import { randomUUID } from 'node:crypto';
import { sha256, stableStringify } from '../../../core/src/hash.js';
import { freeze } from '../../../capability-exposure/src/contracts.js';
import { actualExposure, exposureRequest, runtimeExposurePlan, runtimeEffectResult, restorationState } from '../../src/contracts.js';
import { runtimeReceiptTelemetry } from '../../src/telemetry.js';

export const CODEX_EFFECT_SCOPE = 'initial-request.tools';
export const CODEX_EFFECT_VERSION = '0.158.0-alpha.2.1';
export const CODEX_EFFECT_MECHANISM = 'codex.app-server.fresh-thread.dynamicTools.v1';
const equal = (a,b) => stableStringify(a) === stableStringify(b);
const fail = code => Object.assign(new Error(code), {code});
const isolatedAdapters = new WeakSet();
export const isIsolatedCodexEffectAdapter = adapter => isolatedAdapters.has(adapter);

/** Explicit effect component, separate from config/MCP PLAN_ONLY translation.
 * The backend is trusted adapter infrastructure, never request-supplied data.
 * Each observation covers the complete top-level tools array, not all context.
 */
export async function createIsolatedCodexEffectAdapter({backend, capabilities, telemetry}) {
  const identity = backend.identity, ids = capabilities.map(c => c.id).sort();
  if (identity.family !== 'codex' || identity.runtimeVersion !== CODEX_EFFECT_VERSION
    || backend.isolation !== 'windows-sandbox-owned' || new Set(ids).size !== ids.length)
    throw fail('UNSUPPORTED_RUNTIME_BOUNDARY');
  const unknown = () => actualExposure({runtimeId:identity.id, runtimeVersion:identity.runtimeVersion,
    scope:CODEX_EFFECT_SCOPE, sessionId:null});
  let current = unknown(), baseline = null, busy = false;
  const recordingErrors=[];
  const append=event=>{try{telemetry?.append(event);}catch{recordingErrors.push('TELEMETRY_WRITE_FAILED');}};
  const plans = new Map();
  const emit = (event, plan, attemptId, extra={}) => append({event_type:event, component:'runtime_adapter',
    task_id:plan?.request.taskId ?? 'm12-baseline', invocation_id:plan?.request.invocationId ?? null,
    runtime_id:identity.id, runtime_plan_id:plan?.id ?? null, attempt_id:attemptId, ...extra});
  const observe = report => {
    if (!report?.exposure) return unknown();
    const value = actualExposure(report.exposure);
    if (value.runtimeId !== identity.id || value.runtimeVersion !== identity.runtimeVersion
      || value.scope !== CODEX_EFFECT_SCOPE || value.sessionId !== null) throw fail('OBSERVATION_BINDING_MISMATCH');
    return value;
  };
  const owned = plan => {const record=plans.get(plan?.id);if(record?.plan !== plan)throw fail('PLAN_NOT_OWNED');return record;};
  const execute = async (selected, phase, plan, attemptId) => {
    const report = await backend.run(selected, phase, milestone => emit(milestone,plan,attemptId));
    const observation = observe(report);
    if (observation.state === 'known') emit('runtime_exposure_observed',plan,attemptId,{actual_observation_id:observation.id});
    return {observation, report};
  };
  const adapter = Object.freeze({
    async identify(){return identity;},
    async inspectExposure(){return current;},
    async observeBaseline(){
      if(busy || baseline)throw fail('BASELINE_ALREADY_ATTEMPTED');busy=true;
      try {baseline=await execute(ids,'before',null,null);current=baseline.observation;return current;}
      finally {busy=false;}
    },
    async planExposure(value){
      const request=exposureRequest(value), all=[...(request.exposedIds??[]),...(request.withheldIds??[])].sort();
      const conflicts=[];
      if(value.input.inventory.runtime.id!==identity.id)conflicts.push('inventory_runtime_mismatch');
      if(!equal(all,ids))conflicts.push('incomplete_capability_mapping');
      if(request.sessionId!==null)conflicts.push('scope_is_cross_session_tools');
      if(!baseline || baseline.observation.state!=='known' || !equal(baseline.observation.visibleIds,ids)
        || baseline.report.disposed!==true)conflicts.push('baseline_unverified');
      const plan=runtimeExposurePlan({runtimeId:identity.id, request, supportedIds:all.filter(id=>ids.includes(id)),
        effectClass:'STATIC_SCHEMA_WITHHOLDING',scope:CODEX_EFFECT_SCOPE,requiresNewSession:true,requiresRestart:false,
        reversible:true,evidence:[{kind:'official_source',ref:'codex:0d9c7cbfa6cf1489f55a8a9542b75ddd2c061807:thread/start.dynamicTools'},
          ...(baseline?.observation.evidence??[])],conflicts,
        translationHash:sha256({mechanism:CODEX_EFFECT_MECHANISM,exposedIds:request.exposedIds}),
        exposureObservationId:baseline?.observation.id??null});
      if(!plans.has(plan.id)){plans.set(plan.id,{plan,before:baseline?.observation??unknown()});emit('runtime_plan_created',plan,null);}
      return plans.get(plan.id).plan;
    },
    async applyExposure(plan){
      const record=owned(plan);
      if(busy || record.result)throw fail('ATTEMPT_ALREADY_STARTED');
      if(plan.conflicts.length || plan.unknownIds.length || plan.unsupportedIds.length
        || plan.effectClass!=='STATIC_SCHEMA_WITHHOLDING' || plan.request.exposedIds===null)throw fail('UNSAFE_PLAN');
      busy=true;record.attemptId=`attempt_${randomUUID()}`;const started=performance.now();
      emit('runtime_effect_attempt_started',plan,record.attemptId);
      let status='unverified', observed=unknown();
      try {
        record.applied=await execute(plan.request.exposedIds,'apply',plan,record.attemptId);observed=record.applied.observation;
        if(observed.state==='known')status=equal(observed.visibleIds,plan.request.exposedIds)?'applied':'failed';
        if(record.applied.report.disposed!==true){status='failed';record.failureCode='DISPOSAL_UNVERIFIED';}
        if(status==='failed'&&!record.failureCode)record.failureCode='EXPOSURE_MISMATCH';
        if(status==='unverified')record.failureCode='EXPOSURE_UNAVAILABLE';
      } catch {status='failed';record.failureCode='EFFECT_ATTEMPT_FAILED';}
      finally {busy=false;record.applyMs=performance.now()-started;}
      current=observed;record.result=runtimeEffectResult({plan,status,attemptId:record.attemptId,observed,
        restoration:{before:record.before,planId:plan.id}});
      emit('runtime_effect_result',plan,record.attemptId,{effect_status:status});return record.result;
    },
    taskExecution(plan){
      const record=owned(plan);
      if(!record.result)throw fail('ATTEMPT_NOT_STARTED');
      return record.applied?.report.taskExecution??null;
    },
    async restoreExposure(plan){
      const record=owned(plan);if(busy || !record.result || record.restored)throw fail('INVALID_RESTORE_SEQUENCE');
      busy=true;record.restored=true;const started=performance.now();let observed=unknown(),status='unverified';
      emit('runtime_restoration_attempt',plan,record.attemptId);
      try {
        if(record.applied?.report.disposed!==true)throw fail('DISPOSAL_UNVERIFIED');
        record.after=await execute(record.before.visibleIds,'restore',plan,record.attemptId);observed=record.after.observation;
        if(record.after.report.disposed!==true)throw fail('DISPOSAL_UNVERIFIED');
        status=observed.state==='known' ? equal(observed.visibleIds,record.before.visibleIds)?'restored':'failed' : 'unverified';
      }catch{status='failed';record.failureCode='RESTORE_FAILED';}
      finally{busy=false;record.restoreMs=performance.now()-started;}
      if(status!=='restored')record.failureCode??='RESTORE_UNVERIFIED';
      current=observed;record.result=runtimeEffectResult({plan,status:record.result.status,attemptId:record.attemptId,
        observed:record.result.observed,restoration:restorationState({before:record.before,observed,planId:plan.id,status})});
      emit('runtime_restoration_observed',plan,record.attemptId,{restore_status:status,restore_observation_id:observed.id});
      append(runtimeReceiptTelemetry(plan,record.result));return record.result;
    },
    receipt(plan){
      const record=owned(plan);if(!record.result || !record.restored)throw fail('RECEIPT_NOT_FINAL');
      const body={schemaVersion:'m12.codex-effect-receipt.v1',runtime:identity,mechanism:CODEX_EFFECT_MECHANISM,
        plan,result:record.result,failureCode:record.failureCode??null,recordingErrors:[...recordingErrors],
        scopeLimit:'Initial provider request top-level tools only; full context completeness is not claimed.',
        timings:{applyMs:record.applyMs,observeMs:(record.applied?.report.observeMs??null),restoreMs:record.restoreMs},
        taskExecution:record.applied?.report.taskExecution??null,
        sessions:[baseline?.report,record.applied?.report,record.after?.report].filter(Boolean).map(r=>({
          phase:r.phase,requestHash:r.requestHash??null,threadIdHash:r.threadIdHash??null,
          disposed:r.disposed===true,codexLaunches:r.codexLaunches,modelRequests:r.modelRequests,
          observedToolNamesHash:r.observedToolNamesHash??null,fullRequestCompleteness:r.fullRequestCompleteness??'UNKNOWN'}))};
      const receipt=freeze({id:`effect_receipt_${sha256(body)}`,...body});
      emit('runtime_receipt_finalized',plan,record.attemptId,{receipt_id:receipt.id});return receipt;
    },
  });
  isolatedAdapters.add(adapter);
  return adapter;
}
