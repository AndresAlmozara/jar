import { assertDecisionProbability, canonicalSkills, explicitProposal, invalidDecision, makeSkillProposal, renderRoutingContext, SKILL_OUTCOMES, strategyErrorProposal } from "./common.js";
import { withSkillInvocation } from "./invocation.js";

const NO_SKILL="__no_skill__";
const STOP=new Set("a an and are as at be by for from in is it of on or that the this to with".split(" "));

function tokens(value) { return [...new Set(String(value??"").toLowerCase().match(/[a-z0-9]+/g)?.filter((token)=>token.length>1&&!STOP.has(token))??[])]; }
function metadataText(metadata) { return Object.entries(metadata??{}).map(([key,value])=>`${key} ${typeof value==="string"?value:""}`).join(" "); }

export function retrieveSkills(text,skills,limit=8) {
  const query=tokens(text);
  return skills.map((skill)=>{
    const fields=[[skill.id.replaceAll("-"," "),3],[skill.name,2],[skill.description,1],[metadataText(skill.metadata),0.5]];
    let score=0; const matched=[];
    for (const term of query) { let weight=0; for (const [value,fieldWeight] of fields) if (tokens(value).includes(term)) weight=Math.max(weight,fieldWeight); if (weight) { score+=weight; matched.push(term); } }
    return {id:skill.id,score,matched,relativePath:skill.relativePath,sourceHash:skill.sourceHash};
  }).filter((item)=>item.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
}

function callEvidence(result) { return {provider:result.provider??null,usage:result.usage??null,latencyMs:result.latency_ms??null}; }

export class RetrievalRerankSkillStrategy {
  constructor({decisionEngine,shortlistSize=8,fitThreshold=0.5}={}) { if (!decisionEngine) throw new TypeError("decisionEngine is required"); this.id="skill/skillranker-v1"; this.engine=decisionEngine; this.shortlistSize=shortlistSize; this.fitThreshold=fitThreshold; }
  async route(input) {
    return withSkillInvocation(this.id,input,this.engine,(engine)=>this.routeWithEngine(input,engine));
  }
  async routeWithEngine(input,engine) {
    const started=performance.now(); const skills=canonicalSkills(input.catalog); const explicit=explicitProposal(this.id,input,skills);
    if (explicit) { explicit.decision.latencyMs=performance.now()-started; return explicit; }
    const state=renderRoutingContext(input.task,input.session); const shortlist=retrieveSkills(state,skills,this.shortlistSize);
    const base={path:"independent-retrieval-rerank",initialCandidateCount:skills.length,retrievalShortlist:shortlist.map(({id,score,matched})=>({id,score,matched})),shortlistSize:shortlist.length,jevCallCount:0};
    if (!shortlist.length) return makeSkillProposal({strategy:this.id,...input,outcome:SKILL_OUTCOMES.NO_DECISION,reason:"retrieval_empty",provenance:base,latencyMs:performance.now()-started});
    const byId=new Map(skills.map((skill)=>[skill.id,skill])); const criteria=Object.fromEntries(shortlist.map((item)=>{const skill=byId.get(item.id);return [item.id,`${skill.description}\nMetadata: ${metadataText(skill.metadata)}`]})); criteria[NO_SKILL]="No shortlisted skill is useful for this task";
    let rerank;
    try {
      rerank=await engine.choice({taskId:input.task.id,state,decisionContext:{operation:"retrieval.rerank"},instructions:"Which shortlisted skill would materially help this task, if any?",criteria});
      if (!rerank || typeof rerank!=="object") throw invalidDecision("invalid_choice","Rerank did not return a decision");
    }
    catch (error) { return strategyErrorProposal(this.id,input,error,{...base,failureStage:"rerank"},performance.now()-started); }
    base.jevCallCount=1; base.rerank={choice:rerank.choice,probabilities:rerank.probabilities??{},confidence:rerank.confidence??null,call:callEvidence(rerank)};
    try {
      if (!Object.hasOwn(criteria,rerank.choice)) throw invalidDecision("off_shortlist_choice","Rerank selected a choice outside its shortlist");
      assertDecisionProbability(rerank.probabilities?.[rerank.choice],`Rerank probability for ${rerank.choice}`);
    } catch (error) { return strategyErrorProposal(this.id,input,error,{...base,failureStage:"rerank"},performance.now()-started); }
    if (rerank.choice===NO_SKILL) return makeSkillProposal({strategy:this.id,...input,candidates:shortlist,outcome:SKILL_OUTCOMES.NO_SKILL,confidence:rerank.confidence??null,reason:"rerank_no_skill",provenance:base,latencyMs:performance.now()-started});
    const selected=byId.get(rerank.choice); let fit;
    try { fit=await engine.noul({taskId:input.task.id,state,decisionContext:{operation:"retrieval.fit",operation_id:selected.id},instructions:`Would consulting skill ${selected.id} materially help complete this specific task?`,criteria:{true:selected.description,false:"The task can be completed without this skill"}}); }
    catch (error) { return strategyErrorProposal(this.id,input,error,{...base,failureStage:"fit"},performance.now()-started); }
    let probabilityTrue; let probabilityFalse;
    try {
      probabilityTrue=assertDecisionProbability(fit.probability_true,`Fit true probability for ${selected.id}`);
      probabilityFalse=assertDecisionProbability(fit.probability_false,`Fit false probability for ${selected.id}`);
    } catch (error) { return strategyErrorProposal(this.id,input,error,{...base,failureStage:"fit"},performance.now()-started); }
    base.jevCallCount=2; base.fit={id:selected.id,probabilityTrue,probabilityFalse,threshold:this.fitThreshold,call:callEvidence(fit)};
    if (probabilityTrue<this.fitThreshold) return makeSkillProposal({strategy:this.id,...input,candidates:shortlist,outcome:SKILL_OUTCOMES.NO_SKILL,confidence:probabilityTrue,reason:"fit_rejected",provenance:base,latencyMs:performance.now()-started});
    return makeSkillProposal({strategy:this.id,...input,candidates:shortlist,outcome:SKILL_OUTCOMES.SELECTED,selectedSkillIds:[selected.id],confidence:probabilityTrue,reason:"fit_accepted",provenance:base,latencyMs:performance.now()-started});
  }
}
