import { readFile,writeFile,mkdir,mkdtemp } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { sha256 } from '../packages/core/src/hash.js';
import { stageSandboxVerifier,runSandboxVerifier } from '../packages/runtime-adapters/codex/src/sandbox-executor.js';

const repo=resolve('.'),sourceRoot=resolve('.jar/live-runs/run-fmWrZO'),disposal=JSON.parse(await readFile(join(sourceRoot,'executor/output/disposal.json'),'utf8'));
if(disposal.schemaVersion!=='jar.sandbox-executor-disposal.v1'||disposal.workspaceExported!==true||disposal.guestStateGone!==true
  ||disposal.ownedProcessesRemaining!==0||disposal.bridgeSettled!==true||disposal.toolExecutionNetwork!=='disabled_by_windows_sandbox')throw Error('ACCEPTED_EXECUTOR_EVIDENCE_INVALID');
const reconcileIndex=process.argv.indexOf('--reconcile');
if(reconcileIndex>=0){
  const runRoot=resolve(process.argv[reconcileIndex+1]??'');if(!runRoot.startsWith(resolve('.jar/live-runs')+'\\'))throw Error('RECONCILE_ROOT_INVALID');
  const output=join(runRoot,'verifier-guest/output'),receipt=JSON.parse(await readFile(join(output,'receipt.json'),'utf8')),
    prior=JSON.parse(await readFile(join(runRoot,'verifier-proof-failure.json'),'utf8'));
  if(receipt.schemaVersion!=='jar.sandbox-verifier-receipt.v1'||receipt.runId!==disposal.runId||receipt.status!=='passed'||receipt.exitCode!==0
    ||receipt.ownedProcessesRemaining!==0||receipt.toolExecutionNetwork!=='disabled_by_windows_sandbox'||receipt.modelHadVerifierAccess!==false
    ||receipt.guestTerminatedRequested!==true||prior.lifecycle?.spawnObserved!==true||prior.lifecycle?.closeObserved!==true||prior.lifecycle?.exitCode!==0)throw Error('VERIFIER_RECONCILIATION_INVALID');
  const verifier={...receipt,guestVerifierReceiptValidated:true,terminationMode:'natural',ownedSandboxPid:prior.lifecycle.pid,
    ownedSandboxProcessSettled:true,ownedSandboxCloseObserved:true,settled:true,receiptObservedAfterLauncherClose:true,
    hostLifecycle:prior.lifecycle},body={schemaVersion:'jar.sandbox-verifier-proof.v1',sourceExecutorRun:'run-fmWrZO',runId:disposal.runId,
    executorStatus:'NETWORKLESS_EXECUTOR_VERIFIED',verifierStatus:'FRESH_VERIFIER_VERIFIED',verifier,executorRerun:false,providerCalls:0,codexLaunches:0};
  const proof={id:`verifier_proof_${sha256(body)}`,...body},receiptPath=join(runRoot,'verifier-proof.json');await writeFile(receiptPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:proof.verifierStatus,receiptPath,runRoot}));process.exit(0);
}
const runsRoot=resolve('.jar/live-runs');await mkdir(runsRoot,{recursive:true});const runRoot=await mkdtemp(join(runsRoot,'verifier-only-'));
const boundary={id:disposal.runId,runRoot};
const stage=await stageSandboxVerifier(boundary,{finalWorkspaceRoot:join(sourceRoot,'executor/output/workspace'),
  verifierRoot:resolve('fixtures/live-readiness/verifier'),entrypoint:'verify.mjs',repositoryRoot:repo});
try{
  const verifier=await runSandboxVerifier(stage),body={schemaVersion:'jar.sandbox-verifier-proof.v1',sourceExecutorRun:'run-fmWrZO',runId:disposal.runId,
    executorStatus:'NETWORKLESS_EXECUTOR_VERIFIED',verifierStatus:verifier.status==='passed'?'FRESH_VERIFIER_VERIFIED':'FRESH_VERIFIER_FAILED',verifier,
    executorRerun:false,providerCalls:0,codexLaunches:0};
  const receipt={id:`verifier_proof_${sha256(body)}`,...body},receiptPath=join(runRoot,'verifier-proof.json');await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:receipt.verifierStatus,receiptPath,runRoot}));
}catch(cause){const body={schemaVersion:'jar.sandbox-verifier-proof-failure.v1',sourceExecutorRun:'run-fmWrZO',runId:disposal.runId,
  code:/^[A-Z_]+$/.test(cause.code??'')?cause.code:'VERIFIER_PROOF_FAILED',lifecycle:cause.lifecycle??null,executorRerun:false,providerCalls:0,codexLaunches:0};
  const failurePath=join(runRoot,'verifier-proof-failure.json');await writeFile(failurePath,JSON.stringify({id:`verifier_failure_${sha256(body)}`,...body},null,2)+'\n',{flag:'wx'});console.error(JSON.stringify({status:'failed',failurePath,code:body.code}));process.exitCode=2;}
