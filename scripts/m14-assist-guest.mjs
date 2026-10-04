import { readFile, writeFile } from 'node:fs/promises';
import { createIsolatedCodexEffectAdapter } from '../packages/runtime-adapters/codex/src/isolated-effect.js';
import { runCodexAssist } from '../packages/runtime-adapters/codex/src/assist.js';
import { createAssistStrategy } from '../packages/runtime-adapters/codex/src/assist-strategy.js';
import { capabilityInventory } from '../packages/capability-exposure/src/contracts.js';
import { JsonlTelemetryStore } from '../packages/telemetry/src/jsonl-store.js';
import { assertGuest } from './m12-codex-session.mjs';
import { createGuestCodingBackend } from './m14-codex-session.mjs';
import { sha256 } from '../packages/core/src/hash.js';

assertGuest();
try{
  const request=JSON.parse(await readFile('m13-run.json','utf8'));
  if(!['ASSIST','CONTROL'].includes(request.mode)||request.provider!=='deterministic'||request.inventory!=='coding-fixture')throw Error('INVALID_MODE');
  const built=await createGuestCodingBackend({taskId:request.taskId,task:request.task,mode:request.mode,surfaces:request.surfaces??'none'});
  const store=new JsonlTelemetryStore('C:/M11/output/m14-telemetry.jsonl');
  const telemetry={append:event=>store.append({...event,task_id:request.taskId,invocation_id:request.invocationId})};
  const adapter=await createIsolatedCodexEffectAdapter({backend:built.backend,capabilities:built.capabilities,telemetry});
  const inventory=capabilityInventory({runtime:{id:built.backend.identity.id,family:'codex'},source:'reviewed-m14-owned-workspace-tools',state:'known',
    entries:built.entries.map(entry=>({capability:entry.capability,available:true,supported:true,enabled:true,
      permission:entry.permission,requirementsSatisfied:true}))});
  const run=await runCodexAssist({task:{id:request.taskId,text:request.task},capabilityInventory:inventory,
    mode:request.mode,invocationId:request.invocationId,strategy:createAssistStrategy({provider:request.provider,telemetry}),
    runtimeAdapter:adapter,telemetry,taskAcceptance:built.acceptance});
  await writeFile('C:/M11/output/m14-assist-receipt.json',JSON.stringify(run.receipt,null,2)+'\n',{flag:'wx'});
  if(run.effectReceipt)await writeFile('C:/M11/output/m14-effect-receipt.json',JSON.stringify(run.effectReceipt,null,2)+'\n',{flag:'wx'});
  if(request.surfaces&&request.surfaces!=='none'){
    const evidence={schemaVersion:'codex.assist.surface-extension.v1',assistReceiptId:run.receipt.id,
      taskId:request.taskId,invocationId:request.invocationId,mode:request.mode,requestedSurfaces:request.surfaces,
      capabilityRunStatus:run.receipt.status,sessions:built.surfaceEvidence()};
    await writeFile('C:/M11/output/m14-surfaces-receipt.json',JSON.stringify({id:`surfaces_${sha256(evidence)}`,...evidence},null,2)+'\n',{flag:'wx'});
  }
  if(run.receipt.status!=='succeeded')process.exitCode=2;
}catch{
  await writeFile('C:/M11/output/m14-failure.json',JSON.stringify({schemaVersion:'m14.guest-failure.v1',code:'CODING_ASSIST_GUEST_FAILED'})+'\n',{flag:'wx'});
  process.exitCode=2;
}
