import { readFile, writeFile } from 'node:fs/promises';
import { createIsolatedCodexEffectAdapter } from '../packages/runtime-adapters/codex/src/isolated-effect.js';
import { runCodexAssist } from '../packages/runtime-adapters/codex/src/assist.js';
import { createAssistStrategy } from '../packages/runtime-adapters/codex/src/assist-strategy.js';
import { capabilityDescriptor, capabilityInventory } from '../packages/capability-exposure/src/contracts.js';
import { JsonlTelemetryStore } from '../packages/telemetry/src/jsonl-store.js';
import { assertGuest, createGuestSessionBackend } from './m12-codex-session.mjs';

assertGuest();
try{
  const request=JSON.parse(await readFile('m13-run.json','utf8'));
  if(!['ASSIST','CONTROL'].includes(request.mode)||!['deterministic','jev-mock'].includes(request.provider))throw Error('INVALID_MODE');
  const fixture=JSON.parse(await readFile('fixtures/m13-codex-assist.json','utf8'));
  const {backend,capabilities}=await createGuestSessionBackend();
  const store=new JsonlTelemetryStore('C:/M11/output/m13-telemetry.jsonl');
  // Baseline events occur before a plan exists; bind them to the same run.
  const telemetry={append:event=>store.append({...event,task_id:request.taskId,invocation_id:request.invocationId})};
  const adapter=await createIsolatedCodexEffectAdapter({backend,capabilities,telemetry});
  const inventory=capabilityInventory({runtime:{id:backend.identity.id,family:'codex'},source:'owned-synthetic-tool-registration',state:'known',
    entries:capabilities.map(c=>({capability:capabilityDescriptor({...c,description:fixture.descriptions[c.name]}),
      available:true,supported:true,enabled:true,permission:'allowed',requirementsSatisfied:true}))});
  const run=await runCodexAssist({task:{id:request.taskId,text:request.task},capabilityInventory:inventory,
    mode:request.mode,invocationId:request.invocationId,strategy:createAssistStrategy({provider:request.provider,telemetry}),
    runtimeAdapter:adapter,telemetry});
  await writeFile('C:/M11/output/m13-assist-receipt.json',JSON.stringify(run.receipt,null,2)+'\n',{flag:'wx'});
  if(run.effectReceipt)await writeFile('C:/M11/output/m13-effect-receipt.json',JSON.stringify(run.effectReceipt,null,2)+'\n',{flag:'wx'});
  if(run.receipt.status!=='succeeded')process.exitCode=2;
}catch{
  await writeFile('C:/M11/output/m13-failure.json',JSON.stringify({schemaVersion:'m13.guest-failure.v1',code:'ASSIST_GUEST_FAILED'})+'\n',{flag:'wx'});
  process.exitCode=2;
}
