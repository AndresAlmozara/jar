import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadGeneration,normalizeM5,normalizeM6,normalizeM7,normalizeM8,l0Observation} from './generation-adapter.mjs';
import {gradeObservation} from './metrics.mjs';

const sha=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const task=row=>({id:row.id,text:row.task,createdAt:'2026-10-02T00:00:00.000Z'});
const failure=(row,error,layer='infrastructure')=>({id:row.id,module:row.module,failureClass:error?.code?.includes('provider')?'provider':layer,errorCode:error?.code??'unexpected_error'});

function semanticAccounting(events){
  const completed=events.filter(event=>event?.event_type==='decision_provider_result'),number=(key)=>completed.reduce((sum,event)=>sum+(Number.isFinite(event[key])?event[key]:0),0);
  return{httpAttempts:number('attempt_count'),semanticQuestions:number('question_count'),inputTokens:number('input_tokens'),outputTokens:number('output_tokens'),latencyMs:number('latency_ms'),costEstimate:null,
    distributions:completed.map(event=>({primitive:event.primitive,questionIds:event.question_ids??[],probabilities:event.probabilities??event.selected_values??null,success:event.success,errorCode:event.error_code??null}))};
}

function createEngine(loaded,events){
  const {TypeSafeClient,JevDecisionEngine}=loaded.modules.jev,client=new TypeSafeClient({apiKey:process.env.TYPESAFE_API_KEY,model:'jev-1.13.0'});
  return new JevDecisionEngine({client,onTelemetry:event=>events.push(event)});
}

function skillCatalog(resource){
  const skills=resource.skills.map(item=>({id:item.id,name:item.name,description:item.description,relativePath:`skills/${item.id}/SKILL.md`,sourceHash:sha(item.body),metadata:{}}));
  return{hash:sha(skills),source:{type:'generational-eval',root:'frozen-fixture',git_commit:null,git_dirty:false},skills};
}

async function executeM5(loaded,row,resources,engine){
  const catalog=skillCatalog(resources.skillCatalogs[row.input.catalog]),input={task:task(row),catalog,event:row.input.event??'new_task',skillEvidence:Object.fromEntries(resources.skillCatalogs[row.input.catalog].skills.map(item=>[item.id,{id:item.id,text:item.body,sourceHash:sha(item.body)}]))};
  if(row.input.explicitSkills)input.task.explicitSkills=[...row.input.explicitSkills];
  const strategy=loaded.profile.id==='v2'?new loaded.modules.skills.V2PrimarySupportSkillStrategy({decisionEngine:engine,topology:loaded.profile.topology}):new loaded.modules.skills.EccNativeSkillStrategy();
  const proposal=await strategy.route(input),candidatePool=loaded.profile.id==='v2'?(proposal.candidates??[]).map(item=>item.id):catalog.skills.map(item=>item.id);
  return normalizeM5(row.id,proposal,candidatePool);
}

function duplicateRepository(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'jar-generational-m6-'));fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'docs'));
  fs.writeFileSync(path.join(root,'src','retry.js'),'export const boundedPause=(attempt,maximum)=>Math.min(2**attempt,maximum);');
  for(let index=0;index<12;index++)fs.writeFileSync(path.join(root,'docs',`waiting-${index}.md`),'Repeated waits should never exceed the maximum.');
  return{root,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

async function evaluatorMaterialization(modules,repository,proposal){
  if(typeof modules.materializeRecallFirstContext==='function')return modules.materializeRecallFirstContext({repository,proposal,task:{id:proposal.taskId,text:'evaluation'}});
  const items=[];for(const selectedId of proposal.decision?.selectedCandidateIds??[]){const candidate=proposal.candidates.find(item=>item.id===selectedId);if(!candidate)throw Object.assign(Error('CONTEXT_BINDING_REJECTED'),{code:'CONTEXT_BINDING_REJECTED'});const current=await modules.readRepositoryFile(repository,candidate.path,65536);if(!current||current.sourceHash!==candidate.sourceHash)throw Object.assign(Error('CONTENT_CHANGED'),{code:'CONTENT_CHANGED'});items.push({path:candidate.path,sourceHash:candidate.sourceHash});}
  return{evidence:{items}};
}

async function executeM6(loaded,row,resources,engine,repo){
  const generated=row.input.repository==='generated-duplicate-stressor'?duplicateRepository():null,root=generated?.root??path.resolve(repo,resources.repositories[row.input.repository].root);
  try{
    const repository=await new loaded.modules.context.LocalRepositoryAdapter(root).snapshot(),strategy=loaded.profile.id==='v2'?new loaded.modules.context.RecallFirstContextStrategy({decisionEngine:engine,topology:loaded.profile.topology}):new loaded.modules.context.DeterministicContextStrategy();
    const proposal=await strategy.route({task:task(row),repository}),materialized=await evaluatorMaterialization(loaded.modules.context,repository,proposal);return normalizeM6(row.id,proposal,materialized);
  }finally{generated?.cleanup();}
}

async function executeM7(loaded,row){
  const observation=loaded.modules.output.freshOutput({toolInvocationId:`tool-${row.id}`,capabilityId:'fixture',taskId:row.id,source:{outputClass:'unknown',sensitive:false},parts:structuredClone(row.input.parts)}),strategy=new loaded.modules.output.PassthroughOutputStrategy(),result=await strategy.propose({observation,task:{id:row.id,text:row.task}}),decision=result.decision??result;
  return normalizeM7(row.id,observation.parts,decision);
}

const coverageAtoms=provides=>[...new Set(provides.flatMap(value=>({
  'workspace.inspect':['workspace.read'],'workspace.modify':['workspace.write'],'verification.tests.executed':['workspace.execute','verification.tests'],
  'verification.tests.observed':['version_control.history'],'audit.recorded':['documentation.write'],'history.observed':['version_control.history']
}[value]??[])))];

async function executeM8(loaded,row,engine){
  const {capabilityDescriptor,capabilityInventory,exposureInput,JevHierarchicalCoverCapabilityStrategy,OperationalSufficiencyCapabilityStrategy,CapabilityPolicyGate}=loaded.modules.capabilities,idMap=new Map(),providedById=new Map();
  const descriptors=row.input.capabilities.map(item=>{
    const base={kind:'tool',name:item.id,description:item.description,source:{namespace:'generational-eval',nativeId:item.id},risk:'low',schemaChars:Math.max(1,item.description.length),mandatory:item.mandatory??false,coverageAtoms:coverageAtoms(item.provides??[])};
    if(loaded.profile.id==='v2'&&item.operationalCompleteness!=='unknown')base.operational={operation:item.id,effects:[`${item.id}.effect`],produces:[`${item.id}.result`],provides:item.provides??[],requires:item.requires??[],scope:item.scope??null,prerequisiteNativeIds:item.prerequisiteIds??[],compatibleWithNativeIds:[],incompatibleWithNativeIds:[],completeness:'complete',provenance:'frozen-generational-fixture-v1'};
    const descriptor=capabilityDescriptor(base);idMap.set(descriptor.id,item.id);providedById.set(item.id,item.provides??[]);return descriptor;
  });
  const entries=descriptors.map((capability,index)=>({capability,available:true,supported:true,enabled:true,permission:row.input.capabilities[index].permission??'allowed',requirementsSatisfied:true})),inventory=capabilityInventory({runtime:{id:'generational-eval',family:'codex'},source:'frozen-generational-fixture-v1',state:'known',entries});
  const constraints=loaded.profile.id==='v2'?{operationalScope:row.input.requiredScope??null}:{},input=exposureInput({task:task(row),inventory,constraints}),strategy=loaded.profile.id==='v2'?new OperationalSufficiencyCapabilityStrategy({decisionEngine:engine,topology:loaded.profile.topology}):new JevHierarchicalCoverCapabilityStrategy({decisionEngine:engine}),result=await strategy.propose(input);
  let effectiveIds=result.proposal?.proposedIds??[];if(CapabilityPolicyGate){const gate=new CapabilityPolicyGate().evaluate({input,proposal:result.proposal});effectiveIds=gate.effectiveIds??effectiveIds;}
  return normalizeM8(row.id,{proposal:result,effectiveIds,idMap,providedById});
}

export async function evaluateGeneration({repo,spec,generation,live=false,splits=null,fixtureIds=null,engineFactory=null}){
  if(!live&&!engineFactory)throw Object.assign(Error('GENERATIONAL_LIVE_EXPLICIT_REQUIRED'),{code:'GENERATIONAL_LIVE_EXPLICIT_REQUIRED'});if(live&&!engineFactory&&!process.env.TYPESAFE_API_KEY)throw Object.assign(Error('GENERATIONAL_TYPESAFE_KEY_REQUIRED'),{code:'GENERATIONAL_TYPESAFE_KEY_REQUIRED'});
  const loaded=await loadGeneration(repo,generation),events=[],engine=engineFactory?engineFactory(loaded,events):createEngine(loaded,events),goldById=new Map(spec.gold.labels.map(label=>[label.id,label])),rows=[];
  try{
    for(const row of spec.fixtures.rows){if(splits&& !splits.includes(row.split)||fixtureIds&&!fixtureIds.includes(row.id))continue;let observation;try{if(row.module==='M5')observation=await executeM5(loaded,row,spec.fixtures.resources,engine);else if(row.module==='M6')observation=await executeM6(loaded,row,spec.fixtures.resources,engine,repo);else if(row.module==='M7')observation=await executeM7(loaded,row);else observation=await executeM8(loaded,row,engine);}catch(error){observation=failure(row,error,error?.code?.includes('provider')?'provider':'infrastructure');}
      rows.push({fixtureId:row.id,module:row.module,split:row.split,provenance:row.provenance,observation,grade:gradeObservation(observation,row,goldById.get(row.id))});
    }
    const l0=spec.manifest.l0Contracts.map(contract=>l0Observation(loaded.profile,contract));return{generation,profile:loaded.profile,l0,rows,accounting:semanticAccounting(events)};
  }finally{loaded.cleanup();}
}
