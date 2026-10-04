import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {materializeGeneration} from './materialize.mjs';

export const GENERATION_PROFILES=Object.freeze({
  h0:Object.freeze({id:'h0',treatment:'jar-h0-scalar-v1',commit:'66c8df1d81d09cb2175dded97df5f188c09934d1',topology:'scalar-v1',m5:'skill/ecc-native-v1',m6:'context/deterministic-v1',m7:'output/exact-passthrough-shadow-v1',m8:'capability/jev-hierarchical-cover-v1'}),
  allIn:Object.freeze({id:'allIn',treatment:'jar-all-in-packed-v1',commit:'e540b8aec766d41da850dbc19f17550e48c2a08d',topology:'packed-antichain-v1',m5:'skill/ecc-native-v1',m6:'context/deterministic-v1',m7:'output/exact-passthrough-shadow-v1',m8:'capability/jev-hierarchical-cover-v1'}),
  v2:Object.freeze({id:'v2',treatment:'jar-v2-approved-v1',commit:'9c737e09f66e1f8c50f3bf88132a0ae6e71a37eb',topology:'packed-antichain-v1',m5:'skill/primary-support-v2',m6:'context/recall-first-v2',m7:'output/exact-passthrough-shadow-v1',m8:'capability/jev-operational-sufficiency-v2'})
});

const support={
  h0:{'cross.treatment_identity':'PASS','cross.model_pin':'PASS','cross.malformed_response':'PASS','cross.empty_request':'PASS','cross.request_question_accounting':'PASS','cross.policy_authority':'PASS','cross.materialization_integrity':'PASS','m5.cardinality':'NOT_IMPLEMENTED','m5.no_skill':'NOT_IMPLEMENTED','m5.safe_loading':'PASS','m6.candidate_provenance':'PASS','m6.safe_path':'PASS','m6.freshness_hash':'PASS','m7.byte_exact':'PASS','m7.no_causal_filter':'PASS','m8.eligibility_policy':'PASS','m8.sufficiency_verification':'NOT_IMPLEMENTED','m8.prerequisites':'NOT_IMPLEMENTED','m8.unknown_handling':'PASS','m8.safe_pruning':'PASS'},
  allIn:{'cross.treatment_identity':'PASS','cross.model_pin':'PASS','cross.malformed_response':'PASS','cross.empty_request':'PASS','cross.request_question_accounting':'PASS','cross.policy_authority':'PASS','cross.materialization_integrity':'PASS','m5.cardinality':'NOT_IMPLEMENTED','m5.no_skill':'NOT_IMPLEMENTED','m5.safe_loading':'PASS','m6.candidate_provenance':'PASS','m6.safe_path':'PASS','m6.freshness_hash':'PASS','m7.byte_exact':'PASS','m7.no_causal_filter':'PASS','m8.eligibility_policy':'PASS','m8.sufficiency_verification':'NOT_IMPLEMENTED','m8.prerequisites':'NOT_IMPLEMENTED','m8.unknown_handling':'PASS','m8.safe_pruning':'PASS'},
  v2:{'cross.treatment_identity':'PASS','cross.model_pin':'PASS','cross.malformed_response':'PASS','cross.empty_request':'PASS','cross.request_question_accounting':'PASS','cross.policy_authority':'PASS','cross.materialization_integrity':'PASS','m5.cardinality':'PASS','m5.no_skill':'PASS','m5.safe_loading':'PASS','m6.candidate_provenance':'PASS','m6.safe_path':'PASS','m6.freshness_hash':'PASS','m7.byte_exact':'PASS','m7.no_causal_filter':'PASS','m8.eligibility_policy':'PASS','m8.sufficiency_verification':'PASS','m8.prerequisites':'PASS','m8.unknown_handling':'PASS','m8.safe_pruning':'PASS'}
};

const errorClass=proposal=>proposal?.decision?.error||proposal?.error||proposal?.outcome==='error'||proposal?.decision?.outcome==='error'?'provider':null;
const ids=value=>Array.isArray(value)?[...new Set(value)].sort():[];

export function normalizeM5(id,proposal,candidatePool=null){
  const decision=proposal?.decision??proposal;if(!decision)return{id,module:'M5',failureClass:'infrastructure',primarySkill:null,supportingSkills:[],explicitSkills:[],abstained:false,candidateSkills:[]};
  const selection=decision.selection??{},selected=ids(decision.selectedSkillIds),primary=selection.primarySkillId??(selected.length?selected[0]:null),supports=ids(selection.supportingSkillIds),explicit=ids(selection.explicitSkillIds),candidateSkills=ids((proposal.candidates??[]).map(item=>item.id));
  return{id,module:'M5',primarySkill:primary,supportingSkills:supports,explicitSkills:explicit,abstained:decision.outcome==='no_skill'||decision.outcome==='no_decision',candidateSkills:ids(candidatePool??candidateSkills),failureClass:errorClass(proposal)};
}
export function normalizeM6(id,proposal,materialized=null){
  const decision=proposal?.decision??{},byId=new Map((proposal?.candidates??[]).map(item=>[item.id,item.path]));
  return{id,module:'M6',candidatePaths:ids((proposal?.candidates??[]).map(item=>item.path)),selectedPaths:ids((decision.selectedCandidateIds??[]).map(candidateId=>byId.get(candidateId)).filter(Boolean)),materializedPaths:ids(materialized?.evidence?.items?.map(item=>item.path)),maximumSemanticDuplicates:Math.max(0,...(proposal?.candidates??[]).map(item=>(item.provenance?.length??1)-1)),failureLayer:decision.reason??null,failureClass:errorClass(proposal)};
}
export function normalizeM7(id,originalParts,decision){
  const same=JSON.stringify(originalParts)===JSON.stringify(decision?.parts),properties=[];if(same)properties.push('BYTE_EXACT','ORDER_PRESERVED','CRITICAL_EVIDENCE_PRESERVED');if(decision?.effect===false||decision?.activeRuntimeEffect===false||same)properties.push('NO_CAUSAL_MUTATION');
  return{id,module:'M7',properties:ids(properties),failureClass:decision?null:'infrastructure'};
}
export function normalizeM8(id,{proposal,effectiveIds=null,idMap=new Map(),providedById=new Map()}){
  const body=proposal?.proposal??proposal,operational=body?.operational??{},map=value=>ids(value).map(item=>idMap.get(item)??item);
  const exposedCapabilityIds=map(effectiveIds??body?.proposedIds),semanticFromSelection=exposedCapabilityIds.flatMap(nativeId=>providedById.get(nativeId)??[]);
  return{id,module:'M8',exposedCapabilityIds,semanticObligations:ids([...(operational.authoritativeObligations??[]),...(operational.semanticNeeded??[]),...(operational.semanticUncertain??[]),...semanticFromSelection]),policyViolations:map(operational.policyViolations),prerequisiteViolations:map(operational.missingPrerequisiteNativeIds),scopeErrors:map(operational.wrongScopeCapabilityIds),failureClass:errorClass(body)};
}

export function l0Observation(profile,contract){return{generation:profile.id,contractId:contract.id,status:support[profile.id]?.[contract.id]??'NOT_APPLICABLE',kind:contract.kind,module:contract.module};}

export async function loadGeneration(repo,generation){
  const profile=GENERATION_PROFILES[generation];if(!profile)throw Object.assign(Error('GENERATION_UNKNOWN'),{code:'GENERATION_UNKNOWN',generation});const materialized=materializeGeneration(repo,profile);
  const importFrom=relative=>import(pathToFileURL(path.join(materialized.root,relative)).href);
  try{
    const [skills,context,output,capabilities,jev]=await Promise.all([
      importFrom('packages/skill-routing/src/index.js'),importFrom('packages/repository-context/src/index.js'),importFrom('packages/output-filtering/src/index.js'),importFrom('packages/capability-exposure/src/index.js'),importFrom('packages/decision-providers/jev/src/index.js')
    ]);
    return{profile,root:materialized.root,modules:{skills,context,output,capabilities,jev},cleanup:materialized.cleanup};
  }catch(error){materialized.cleanup();throw error;}
}
