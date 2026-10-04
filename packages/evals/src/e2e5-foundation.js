import { randomUUID } from 'node:crypto';
import { sha256 } from '../../core/src/hash.js';

export const E2E5_TASKS=Object.freeze(['running-dashboard','endless-runner-game','cross-file-bugfix','postgres-goals-api','security-hardening']);
export function e2e5Plan(fixtures={}){
  return {experimentId:'e2e5-v1',executed:false,runs:E2E5_TASKS.flatMap((task,index)=>(index%2?['JAR','CONTROL']:['CONTROL','JAR']).map(condition=>({
    task,condition,promptHash:fixtures[task]?.promptHash??null,startStateHash:fixtures[task]?.startStateHash??null,
    verifierHash:fixtures[task]?.verifierHash??null,configHash:fixtures[task]?.configHash??null,
    readiness:fixtures[task]?'not_executed':'fixture_required'})))};
}

/** Conservative whole-file evidence: a changed version must equal the final
 * version continuously. Partial surviving hunks cannot be timed from hashes. */
export function persistentEditEvidence(edits,initial,final){
  if(!Array.isArray(edits)||edits.some(e=>!Number.isFinite(e.atMs)||e.atMs<0))throw Error('EDIT_HISTORY_INVALID');
  let first=null,reverted=0,ambiguous=false;
  for(const [path,initialHash] of Object.entries(initial)){
    const history=edits.filter(e=>e.path===path);let current=initialHash,last=-1;
    for(const event of history){if(event.beforeHash!==current||event.atMs<last)throw Error('EDIT_HISTORY_INVALID');current=event.afterHash;last=event.atMs;}
    if(current!==final[path]){ambiguous=true;continue;}
    if(final[path]===initialHash){reverted+=history.filter(e=>e.afterHash!==initialHash).length;continue;}
    const at=history.findIndex((e,i)=>e.beforeHash!==e.afterHash&&e.afterHash===final[path]&&history.slice(i).every(x=>x.afterHash===final[path]));
    if(at>=0){first=first===null?history[at].atMs:Math.min(first,history[at].atMs);
      if(history.slice(0,at).some(e=>e.afterHash!==initialHash))ambiguous=true;
    }else ambiguous=true;
  }
  return {timeToFirstPersistentEditMs:ambiguous?null:first,revertedEdits:reverted,
    precision:ambiguous?'unknown_partial_hunks':'observed_whole_file_version'};
}
export function e2eMetrics({events=[],wallClockMs=null,history=null,mainUsage=null,jevUsage=null}={}){
  const first=name=>events.find(e=>e.tool===name)?.atMs??null;
  const count=name=>events.length?events.filter(e=>e.tool===name).length:null;
  const persistent=history?persistentEditEvidence(history.edits,history.initial,history.final):null;
  return {wallClockMs,timeToFirstToolMs:events[0]?.atMs??null,timeToFirstSearchMs:first('workspace_search'),
    timeToFirstReadMs:first('workspace_read'),timeToFirstTestMs:first('workspace_run'),
    timeToFirstPersistentEditMs:persistent?.timeToFirstPersistentEditMs??null,persistentEditPrecision:persistent?.precision??'unknown',
    toolCalls:events.length||null,searches:count('workspace_search'),reads:count('workspace_read'),tests:count('workspace_run'),
    persistentEdits:history?Object.keys(history.final).filter(p=>history.initial[p]!==history.final[p]).length:null,
    revertedEdits:persistent?.revertedEdits??null,filesModified:history?Object.keys(history.final).filter(p=>history.initial[p]!==history.final[p]):null,
    linesChanged:null,unrelatedFiles:null,mainModelUsage:mainUsage,jevUsage,actualMonetaryCost:null};
}
export function apiEquivalentCost(usage,pricing){
  if(!usage||usage.kind!=='measured'||!pricing)return null;
  if(![usage.inputTokens,usage.outputTokens,pricing.inputPerMillion,pricing.outputPerMillion].every(n=>Number.isFinite(n)&&n>=0))return null;
  return {kind:'api_equivalent_estimate',currency:pricing.currency??null,
    amount:(usage.inputTokens*pricing.inputPerMillion+usage.outputTokens*pricing.outputPerMillion)/1e6,actualSubscriptionCost:null};
}

export function packageTrialEvidence(receipt,artifacts=[]){
  const {id,...body}=receipt;
  if(id!==`e2e_trial_${sha256(body)}`||artifacts.some(a=>!['verification','disposal','surface-receipt'].includes(a.kind)
    ||!/^[a-f0-9]{64}$/.test(a.sha256)))throw Error('EVIDENCE_PACKAGE_INVALID');
  const packet={schemaVersion:'jar.e2e-evidence-package.v1',receiptId:id,
    artifacts:artifacts.map(a=>({kind:a.kind,sha256:a.sha256})),rawRequestsIncluded:false,promptsIncluded:false};
  return {id:`e2e_package_${sha256(packet)}`,...packet};
}

/** Offline transport seam, not a benchmark launcher. Every call requires a new
 * prepare/dispose pair. Neither condition shares mutable workspace state. */
export async function offlineTrial({condition,identity,prepare,exercise,verify,dispose,clock=()=>performance.now()}){
  if(!['CONTROL','JAR'].includes(condition)||!['deterministic_loopback','mock_jev'].includes(identity.providerKind))throw Error('OFFLINE_PROVIDER_REQUIRED');
  const runId=randomUUID(),started=clock();let workspace=null,result=null,verification=null,disposal=null,failure=null;
  try{workspace=await prepare();result=await exercise(workspace);verification=await verify(workspace,result);}
  catch{failure='OFFLINE_TRIAL_FAILED';}
  finally{if(workspace)try{disposal=await dispose(workspace);}catch{failure='DISPOSAL_FAILED';}}
  const body={schemaVersion:'jar.e2e-trial.v1',runId,condition,identity:{taskId:identity.taskId??null,providerKind:identity.providerKind,
    runtime:identity.runtime??null,model:identity.model??null,promptHash:identity.promptHash??null,configHash:identity.configHash??null,
    verifierHash:identity.verifierHash??null,startStateHash:workspace?.startStateHash??null},
    status:!failure&&verification?.status==='passed'&&disposal?.disposed===true?'passed':'failed',failure,
    verificationReceiptId:verification?.id??null,disposal:disposal?{disposed:disposal.disposed===true,remainingOwnedProcesses:disposal.remainingOwnedProcesses??null}:null,metrics:e2eMetrics({events:result?.events??[],wallClockMs:clock()-started,history:result?.history??null}),
    externalProviderCalls:0,liveModelProof:false};
  return {id:`e2e_trial_${sha256(body)}`,...body};
}
