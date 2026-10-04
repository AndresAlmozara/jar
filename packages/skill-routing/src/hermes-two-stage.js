import { assertDecisionProbability, canonicalSkills, explicitProposal, invalidDecision, makeSkillProposal, renderRoutingContext, SKILL_OUTCOMES, strategyErrorProposal } from "./common.js";
import { withSkillInvocation } from "./invocation.js";

const NO_SKILL="__no_skill__";

export function stableBatches(items,size) {
  if (!Number.isInteger(size)||size<1) throw new TypeError("batchSize must be a positive integer");
  const batches=[];
  for (let index=0;index<items.length;index+=size) batches.push(items.slice(index,index+size));
  return batches;
}

export async function mapBounded(items,limit,worker) {
  if (!Number.isInteger(limit)||limit<1) throw new TypeError("concurrency must be a positive integer");
  const results=new Array(items.length); let next=0; let failed=false; let failure;
  async function run() {
    while (!failed) {
      const index=next++;
      if (index>=items.length) return;
      try { results[index]=await worker(items[index],index); }
      catch (error) { if (!failed) failure=error; failed=true; }
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},run));
  if (failed) throw failure;
  return results;
}

function callEvidence(result) {
  return {provider:result.provider??null,usage:result.usage??null,latencyMs:result.latency_ms??null};
}

export class HermesTwoStageSkillStrategy {
  constructor({decisionEngine,batchSize=120,concurrency=4,finalists=5,maxSelected=3,shortlistFloor=0.02,verificationThreshold=0.5,candidateAnnotation=null}={}) {
    if (!decisionEngine) throw new TypeError("decisionEngine is required");
    if (candidateAnnotation!==null && typeof candidateAnnotation!=="function") throw new TypeError("candidateAnnotation must be a function");
    this.id="skill/hermes-two-stage-v1"; this.engine=decisionEngine; this.batchSize=batchSize; this.concurrency=concurrency; this.finalists=finalists; this.maxSelected=maxSelected; this.shortlistFloor=shortlistFloor; this.verificationThreshold=verificationThreshold; this.candidateAnnotation=candidateAnnotation;
  }

  describeCandidate(skill) {
    const annotation=this.candidateAnnotation?.(skill);
    return annotation?`${skill.description}\n${annotation}`:skill.description;
  }

  async route(input) {
    return withSkillInvocation(this.id,input,this.engine,(engine)=>this.routeWithEngine(input,engine));
  }

  // Composition entry: the caller supplies its invocation-scoped DecisionEngine.
  async routeWithEngine(input,engine) {
    const started=performance.now(); const skills=canonicalSkills(input.catalog); const explicit=explicitProposal(this.id,input,skills);
    if (explicit) { explicit.decision.latencyMs=performance.now()-started; return explicit; }
    const state=renderRoutingContext(input.task,input.session); const batches=stableBatches(skills,this.batchSize);
    const base={path:"hermes-two-stage",initialCandidateCount:skills.length,batchCount:batches.length,batchSizes:batches.map((batch)=>batch.length),concurrency:this.concurrency,policy:{shortlistFloor:this.shortlistFloor,verificationThreshold:this.verificationThreshold,finalists:this.finalists,maxSelected:this.maxSelected},jevCallCount:0,stage1:[],stage2:[]};
    if (!batches.length) return makeSkillProposal({strategy:this.id,...input,outcome:SKILL_OUTCOMES.NO_DECISION,reason:"empty_catalog",provenance:base,latencyMs:performance.now()-started});
    let stage1; let stage1CallCount=0;
    try {
      stage1=await mapBounded(batches,this.concurrency,async(batch,index)=>{
        try {
          const criteria=Object.fromEntries(batch.map((skill)=>[skill.id,this.describeCandidate(skill)])); criteria[NO_SKILL]="No listed skill is needed for this task";
          stage1CallCount++;
          const result=await engine.choice({taskId:input.task.id,state,decisionContext:{operation:"hermes.stage1",operation_id:String(index)},instructions:"Which listed skill is the specialized procedure this task calls for, if any?",criteria});
          if (!Object.hasOwn(criteria,result.choice)) throw invalidDecision("off_batch_choice","Stage 1 selected a choice outside its batch");
          const probabilities={};
          for (const [id,probability] of Object.entries(result.probabilities??{})) if (Object.hasOwn(criteria,id)) probabilities[id]=assertDecisionProbability(probability,`Stage 1 probability for ${id}`);
          if (!Object.hasOwn(probabilities,result.choice)) throw invalidDecision("missing_choice_probability","Stage 1 omitted the selected choice probability");
          return {batchIndex:index,candidateIds:batch.map((skill)=>skill.id),choice:result.choice,confidence:result.confidence??null,probabilities,call:callEvidence(result)};
        } catch (error) {
          const wrapped=new Error(error?.message??"Stage 1 batch failed",{cause:error});
          wrapped.name=error?.name??"Error"; wrapped.code=error?.code??null; wrapped.batchIndex=index; throw wrapped;
        }
      });
    } catch (error) { return strategyErrorProposal(this.id,input,error,{...base,jevCallCount:stage1CallCount,failureStage:"stage1",failureBatchIndex:error.batchIndex??null},performance.now()-started); }
    base.jevCallCount=stage1CallCount; base.stage1=stage1;
    const byId=new Map();
    for (const result of stage1) for (const [id,probability] of Object.entries(result.probabilities)) if (id!==NO_SKILL&&Number.isFinite(probability)&&probability>=this.shortlistFloor) { const prior=byId.get(id); if (!prior||probability>prior.probability) byId.set(id,{id,probability,confidence:result.confidence}); }
    const survivors=[...byId.values()].sort((a,b)=>b.probability-a.probability||a.id.localeCompare(b.id)).slice(0,this.finalists);
    base.stage1Survivors=survivors;
    if (!survivors.length) return makeSkillProposal({strategy:this.id,...input,outcome:SKILL_OUTCOMES.NO_SKILL,reason:"no_stage1_survivors",provenance:base,latencyMs:performance.now()-started});
    const skillById=new Map(skills.map((skill)=>[skill.id,skill])); let verified; let stage2CallCount=0;
    try {
      verified=await mapBounded(survivors,this.concurrency,async(survivor)=>{
        const skill=skillById.get(survivor.id); stage2CallCount++;
        const result=await engine.noul({taskId:input.task.id,state,decisionContext:{operation:"hermes.stage2",operation_id:skill.id},instructions:`Does this task actually need the specialized procedure described for skill ${skill.id}?`,criteria:{true:this.describeCandidate(skill),false:"The task does not need this skill"}});
        const probabilityTrue=assertDecisionProbability(result.probability_true,`Stage 2 true probability for ${skill.id}`);
        const probabilityFalse=assertDecisionProbability(result.probability_false,`Stage 2 false probability for ${skill.id}`);
        return {...survivor,probabilityTrue,probabilityFalse,accepted:probabilityTrue>=this.verificationThreshold,call:callEvidence(result)};
      });
    } catch (error) { return strategyErrorProposal(this.id,input,error,{...base,jevCallCount:stage1CallCount+stage2CallCount,failureStage:"stage2"},performance.now()-started); }
    base.jevCallCount+=verified.length; base.stage2=verified;
    const accepted=verified.filter((item)=>item.accepted).sort((a,b)=>b.probabilityTrue-a.probabilityTrue||b.probability-a.probability||a.id.localeCompare(b.id)).slice(0,this.maxSelected);
    const candidates=verified.map((item)=>({id:item.id,stage1Probability:item.probability,stage1Confidence:item.confidence,verificationProbability:item.probabilityTrue,accepted:item.accepted}));
    if (!accepted.length) return makeSkillProposal({strategy:this.id,...input,candidates,outcome:SKILL_OUTCOMES.NO_SKILL,reason:"stage2_rejected_all",provenance:base,latencyMs:performance.now()-started});
    return makeSkillProposal({strategy:this.id,...input,candidates,outcome:SKILL_OUTCOMES.SELECTED,selectedSkillIds:accepted.map((item)=>item.id),confidence:accepted[0].probabilityTrue,reason:"stage2_verified",provenance:base,latencyMs:performance.now()-started});
  }
}
