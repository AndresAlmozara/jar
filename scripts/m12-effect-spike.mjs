import { writeFile } from 'node:fs/promises';
import { createIsolatedCodexEffectAdapter } from '../packages/runtime-adapters/codex/src/isolated-effect.js';
import { capabilityInventory, exposureInput, exposureProposal, capabilityInvocation } from '../packages/capability-exposure/src/contracts.js';
import { JsonlTelemetryStore } from '../packages/telemetry/src/jsonl-store.js';
import { assertGuest, createGuestSessionBackend } from './m12-codex-session.mjs';

assertGuest();
try{
  const {backend,capabilities}=await createGuestSessionBackend();
  const adapter=await createIsolatedCodexEffectAdapter({backend,capabilities,
    telemetry:new JsonlTelemetryStore('C:/M11/output/m12-telemetry.jsonl')});
  await adapter.observeBaseline();
  const input=exposureInput({task:{id:'m12-isolated-effect',text:'Withhold synthetic beta in owned session'},
    inventory:capabilityInventory({runtime:{id:backend.identity.id,family:'codex'},source:'owned-synthetic-tool-registration',state:'known',
      entries:capabilities.map(capability=>({capability,available:true,supported:true,enabled:true,permission:'allowed',requirementsSatisfied:true}))})});
  const proposal=exposureProposal({input,invocation:capabilityInvocation('capability/isolated-spike-v1','m12-effect'),
    proposedIds:capabilities.filter(c=>c.name!=='tool_beta').map(c=>c.id)});
  const plan=await adapter.planExposure({input,proposal});
  await adapter.applyExposure(plan);
  await adapter.restoreExposure(plan);
  const receipt=adapter.receipt(plan);
  await writeFile('C:/M11/output/m12-effect-receipt.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  if(receipt.result.status!=='applied'||receipt.result.restoration.status!=='restored')process.exitCode=2;
}catch{
  await writeFile('C:/M11/output/m12-effect-failure.json',JSON.stringify({schemaVersion:'m12.effect-failure.v1',code:'EFFECT_SPIKE_FAILED'})+'\n',{flag:'wx'});
  process.exitCode=2;
}
