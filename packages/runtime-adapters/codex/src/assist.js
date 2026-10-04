import { sha256, stableStringify } from '../../../core/src/hash.js';
import { newId } from '../../../core/src/ids.js';
import { exposureInput, validateExposureProposal, freeze } from '../../../capability-exposure/src/contracts.js';
import { AllVisibleCapabilityStrategy } from '../../../capability-exposure/src/strategies.js';
import { CapabilityPolicyGate } from '../../../capability-exposure/src/policy-gate.js';
import { capabilityTelemetry } from '../../../capability-exposure/src/telemetry.js';
import { runtimeExposurePlan, runtimeEffectResult, exposureRequest } from '../../src/contracts.js';
import { isIsolatedCodexEffectAdapter, CODEX_EFFECT_SCOPE, CODEX_EFFECT_VERSION } from './isolated-effect.js';
import { codingTaskAcceptance, codingTaskReport } from './coding-task.js';

const equal=(a,b)=>stableStringify(a)===stableStringify(b);
const fail=code=>Object.assign(new Error(code),{assistCode:code});

export function requireEffectEligible({plan,input,proposal,identity,adapter}){
  if(!isIsolatedCodexEffectAdapter(adapter))throw fail('ISOLATED_EFFECT_REQUIRED');
  const {version,unknownIds,application,...raw}=plan;
  if(!equal(runtimeExposurePlan(raw),plan))throw fail('NONCANONICAL_PLAN');
  if(identity.family!=='codex'||identity.runtimeVersion!==CODEX_EFFECT_VERSION
    ||plan.runtimeId!==identity.id||input.inventory.runtime.id!==identity.id)throw fail('RUNTIME_MISMATCH');
  if(input.inventory.state!=='known'||plan.request.exposedIds===null||plan.unknownIds.length||plan.unsupportedIds.length
    ||plan.supportedIds.length!==input.inventory.entries.length)throw fail('MAPPING_INCOMPLETE');
  if(!equal(plan.request,exposureRequest({input,proposal})))throw fail('POLICY_PLAN_MISMATCH');
  if(plan.conflicts.length)throw fail('PLAN_CONFLICT');
  if(plan.effectClass!=='STATIC_SCHEMA_WITHHOLDING'||plan.scope!==CODEX_EFFECT_SCOPE)throw fail('UNSUPPORTED_EFFECT');
  if(plan.reversible!==true||plan.requiresNewSession!==true||plan.requiresRestart!==false)throw fail('RESTORATION_UNRESOLVED');
}

/** Coordination only. Strategies propose; the independent gate constrains;
 * only the issued isolated adapter can apply. No native tools enter this layer.
 * Supply a JEV capability strategy with either mock or live DecisionEngine
 * to use the same orchestration and validation at the provider boundary.
 */
export async function runCodexAssist({task,capabilityInventory,strategy,runtimeAdapter,mode='ASSIST',
  constraints={},policy={},telemetry,invocationId=newId('invocation'),taskAcceptance=null}){
  if(!['CONTROL','ASSIST'].includes(mode))throw new TypeError('Invalid Assist mode');
  const input=exposureInput({task,inventory:capabilityInventory,constraints,policy});
  const started=performance.now(),timings={},recordingErrors=[];
  let identity=null,proposal=null,effective=null,plan=null,result=null,effectReceipt=null,taskExecution=null;
  let applyEntered=false,restorationAttempted=false,failureCode=null,stage='eligibility',decisionCalls=null,semanticRefs=[];
  const chosen=mode==='CONTROL'?new AllVisibleCapabilityStrategy():strategy;
  const emit=(event,extra={})=>{
    try{telemetry?.append({event_type:event,component:'codex_assist',task_id:input.task.id,
      invocation_id:invocationId,proposal_id:proposal?.id??null,runtime_plan_id:plan?.id??null,
      attempt_id:result?.attemptId??null,...extra});}catch{recordingErrors.push('TELEMETRY_WRITE_FAILED');}
  };
  const validateResult=value=>{
    const rebuilt=runtimeEffectResult({plan,status:value.status,attemptId:value.attemptId,observed:value.observed,restoration:value.restoration});
    if(!equal(rebuilt,value)||value.observed.state==='known'&&value.observed.runtimeVersion!==identity.runtimeVersion)
      throw fail('EFFECT_RESULT_INVALID');
    return rebuilt;
  };
  emit('assist_task_started',{mode,task_hash:sha256(input.task),inventory_id:input.inventory.id});
  try{
    const acceptance=taskAcceptance===null?null:codingTaskAcceptance(taskAcceptance);
    if(input.inventory.state!=='known')throw fail('INVENTORY_UNKNOWN');
    if(!isIsolatedCodexEffectAdapter(runtimeAdapter))throw fail('ISOLATED_EFFECT_REQUIRED');
    identity=await runtimeAdapter.identify();
    if(identity.family!=='codex'||identity.runtimeVersion!==CODEX_EFFECT_VERSION||input.inventory.runtime.id!==identity.id)
      throw fail('RUNTIME_MISMATCH');
    if(typeof chosen?.propose!=='function')throw fail('STRATEGY_UNAVAILABLE');
    stage='strategy';const strategyStart=performance.now();emit('capability_strategy_started',{strategy_id:chosen.id});
    const selection=await chosen.propose({...input,invocationId,sessionId:null});
    proposal=validateExposureProposal(selection.proposal,input);
    if(proposal.invocation.invocation_id!==invocationId||proposal.invocation.session_id!==null||proposal.strategy!==chosen.id)
      throw fail('STRATEGY_CORRELATION_MISMATCH');
    const counts=selection.decisionCalls,refs=selection.semanticRefs;
    if(!counts||![counts.attempted,counts.settled,counts.failed].every(n=>Number.isSafeInteger(n)&&n>=0)
      ||counts.attempted!==counts.settled||counts.failed>counts.settled||!Array.isArray(refs)||refs.length<counts.attempted
      ||refs.some(r=>typeof r.call_id!=='string'||!r.call_id
        ||(r.candidate_id!==undefined&&!proposal.semanticCandidateIds.includes(r.candidate_id))
        ||(r.subject_type!==undefined&&!['family','atom'].includes(r.subject_type))
        ||(r.subject_type!==undefined&&(typeof r.subject_id!=='string'||!r.subject_id))
        ||(r.candidate_id===undefined)===(r.subject_type===undefined)
        ||(r.request_id!==null&&typeof r.request_id!=='string'))
      ||new Set(refs.map(r=>r.call_id)).size!==counts.attempted)throw fail('STRATEGY_ACCOUNTING_INVALID');
    decisionCalls={attempted:counts.attempted,settled:counts.settled,failed:counts.failed};
    semanticRefs=refs.map(r=>r.candidate_id!==undefined
      ?{candidate_id:r.candidate_id,call_id:r.call_id,request_id:r.request_id}
      :{subject_type:r.subject_type,subject_id:r.subject_id,call_id:r.call_id,request_id:r.request_id});
    timings.strategyMs=performance.now()-strategyStart;
    emit('capability_exposure_proposal',capabilityTelemetry(input,proposal));
    emit('capability_strategy_completed',{strategy_id:chosen.id});
    if(proposal.outcome!=='selected'||counts.failed)throw fail('STRATEGY_FAILED');
    stage='policy';effective=new CapabilityPolicyGate().evaluate({input,proposal});
    emit('capability_policy_evaluated',{effective_ids:effective.effectiveIds,rejected_ids:effective.rejections.map(r=>r.id)});
    if(effective.fallback||effective.unresolvedRequiredIds.length||effective.eligibility.conflicts.length)throw fail('POLICY_UNRESOLVED');
    stage='baseline';await runtimeAdapter.observeBaseline();
    stage='plan';plan=await runtimeAdapter.planExposure({input,proposal});
    requireEffectEligible({plan,input,proposal,identity,adapter:runtimeAdapter});
    emit('assist_plan_eligible');stage='effect';const applyStart=performance.now();applyEntered=true;
    result=validateResult(await runtimeAdapter.applyExposure(plan));timings.applyMs=performance.now()-applyStart;
    if(result.status!=='applied')failureCode='EFFECT_NOT_APPLIED';
    if(acceptance&&result.status==='applied'){
      stage='task';emit('task_execution_started');
      try{taskExecution=codingTaskReport(runtimeAdapter.taskExecution(plan),{acceptance,requestedIds:plan.request.exposedIds});}
      catch{failureCode='TASK_EXECUTION_INVALID';}
      emit('verification_started');
      if(taskExecution?.status!=='passed')failureCode??='TASK_VERIFICATION_FAILED';
      emit('verification_completed',{verification_status:taskExecution?.status??'failed'});
    }
  }catch(error){failureCode=error.assistCode??({strategy:'STRATEGY_FAILED',baseline:'BASELINE_FAILED',plan:'PLAN_REJECTED',effect:'EFFECT_FAILED'}[stage]??'ASSIST_REJECTED');}
  finally{
    if(applyEntered){
      restorationAttempted=true;emit('assist_restoration_started');const restoreStart=performance.now();
      try{
        const restored=validateResult(await runtimeAdapter.restoreExposure(plan));
        if(result&&(restored.attemptId!==result.attemptId||!equal(restored.observed,result.observed)))throw fail('RESTORE_CORRELATION_MISMATCH');
        result=restored;
        if(result.restoration.status!=='restored')failureCode='RESTORATION_FAILED';
        effectReceipt=runtimeAdapter.receipt(plan);
      }catch{failureCode='RESTORATION_FAILED';}
      timings.restoreMs=performance.now()-restoreStart;
      emit('assist_restoration_completed',{restoration_status:failureCode==='RESTORATION_FAILED'?'failed':result?.restoration.status??'unverified'});
    }
  }
  timings.totalMs=performance.now()-started;
  const succeeded=failureCode===null&&result?.status==='applied'&&result.restoration.status==='restored'
    &&(taskAcceptance===null||taskExecution?.status==='passed');
  const body={schemaVersion:taskAcceptance===null?'codex.assist.execution.v1':'codex.assist.execution.v2',mode,status:succeeded?'succeeded':'failed',
    jarOn:mode==='ASSIST'&&succeeded,taskId:input.task.id,taskHash:sha256(input.task),inventoryId:input.inventory.id,
    invocationId,strategyId:chosen?.id??null,runtime:identity,proposal,
    policy:effective?{effectiveIds:effective.effectiveIds,withheldIds:effective.withheldIds,
      overrides:effective.overrides,rejections:effective.rejections,fallback:effective.fallback}:null,
    plan,result,taskExecution,effectReceiptId:effectReceipt?.id??null,decisionCalls,semanticRefs,
    failureCode,restorationAttempted,fallback:null,recordingErrors:[...recordingErrors],timings};
  const receipt=freeze({id:`assist_${sha256(body)}`,...body});
  emit('assist_run_completed',{receipt_id:receipt.id,status:receipt.status,jar_on:receipt.jarOn,failure_code:failureCode});
  return {receipt,effectReceipt};
}
