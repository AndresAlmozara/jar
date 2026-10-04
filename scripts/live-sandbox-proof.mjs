import { readFile,writeFile } from 'node:fs/promises';
import { resolve,dirname,join } from 'node:path';
import { prepareOwnedWorkspace,ownedState } from '../packages/runtime-adapters/codex/src/owned-workspace.js';
import { ownedToolMapping,ownedToolInventory } from '../packages/runtime-adapters/codex/src/owned-tools.js';
import { exposureInput } from '../packages/capability-exposure/src/contracts.js';
import { AllVisibleCapabilityStrategy } from '../packages/capability-exposure/src/strategies.js';
import { exposureRequest } from '../packages/runtime-adapters/src/contracts.js';
import { createSandboxToolCallback } from '../packages/runtime-adapters/codex/src/sandbox-rpc.js';
import { stageSandboxExecutor,launchSandboxExecutor,stageSandboxVerifier,runSandboxVerifier } from '../packages/runtime-adapters/codex/src/sandbox-executor.js';
import { sha256 } from '../packages/core/src/hash.js';

const repo=resolve('.'),manifestPath=resolve('fixtures/live-readiness/workspace-manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const handle=await prepareOwnedWorkspace(manifest,{manifestDirectory:dirname(manifestPath),runsRoot:join(repo,'.jar/live-runs')});
const mapping=ownedToolMapping(handle),inventory=ownedToolInventory(handle,{id:'sandbox-proof',family:'codex'}),input=exposureInput({task:{id:'sandbox-proof',text:manifest.task},inventory});
const {proposal}=await new AllVisibleCapabilityStrategy().propose(input),request=exposureRequest({input,proposal}),selectedIds=request.exposedIds;
const stage=await stageSandboxExecutor(handle,{mapping,selectedIds,repositoryRoot:repo});let executor,executorDisposed=false;
try{executor=await launchSandboxExecutor(stage);const execute=createSandboxToolCallback({runId:handle.id,mapping,selectedIds,client:executor});
  const read=await execute('workspace_read',{path:'normalize.js'});
  const source="export function normalizeLabels(values) {\n  return [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))];\n}\n";
  const write=await execute('workspace_write',{path:'normalize.js',content:source}),run=await execute('workspace_run',{commandId:'test'}),disposal=await executor.dispose();executorDisposed=true;
  if(disposal.sandboxSessionSettled!==true||disposal.ownedSandboxSessionProcessesRemaining!==0)throw Error('EXECUTOR_SANDBOX_SESSION_UNSETTLED');
  const verifierStage=await stageSandboxVerifier(handle,{finalWorkspaceRoot:disposal.workspaceRoot,verifierRoot:resolve(dirname(manifestPath),manifest.verifier.root),entrypoint:manifest.verifier.entrypoint,repositoryRoot:repo});
  const verifier=await runSandboxVerifier(verifierStage);
  if(verifier.sandboxSessionSettled!==true||verifier.ownedSandboxSessionProcessesRemaining!==0)throw Error('VERIFIER_SANDBOX_SESSION_UNSETTLED');
  const body={schemaVersion:'jar.sandbox-proof.v1',runId:handle.id,status:read.success&&write.success&&run.success&&verifier.status==='passed'?'passed':'failed',
    selectedIds,usedToolNames:['workspace_read','workspace_write','workspace_run'],toolExecutionNetwork:executor.toolExecutionNetwork,networkProof:executor.networkProof,
    executorDisposal:disposal,verifier:{...verifier,freshGuest:true},hostModelEditableCodeExecutions:0,externalProviderCalls:0,normalCodexConfigMutations:0};
  const receipt={id:`sandbox_proof_${sha256(body)}`,...body};await writeFile(join(handle.runRoot,'sandbox-proof.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({status:receipt.status,receiptPath:join(handle.runRoot,'sandbox-proof.json'),runId:handle.id}));
}finally{if(executor&&!executorDisposed)await executor.dispose();}
