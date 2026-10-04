import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../packages/core/src/hash.js';
import { prepareOwnedWorkspace, disposeOwnedWorkspace, readBounded } from '../packages/runtime-adapters/codex/src/owned-workspace.js';
import { prepareOwnedInputs } from '../packages/runtime-adapters/codex/src/owned-preparation.js';
import { liveReadiness, rejectLiveExecution } from '../packages/runtime-adapters/codex/src/live-readiness.js';
import { authBoundary, validateLiveIntent } from '../packages/runtime-adapters/codex/src/auth-boundary.js';

const repo=fileURLToPath(new URL('..',import.meta.url));
export async function prepareLiveCommand({manifestPath,mode='ASSIST',prepareOnly=false,executeLive=false,allowNetwork=false,provider='offline',authMode=null}){
  validateLiveIntent({provider,prepareOnly,executeLive,allowNetwork});
  authBoundary(authMode);
  if(executeLive||!prepareOnly)rejectLiveExecution();
  if(typeof manifestPath!=='string'||!manifestPath||!['ASSIST','CONTROL'].includes(mode))throw Error('PREPARE_OPTIONS_INVALID');
  const path=resolve(manifestPath),info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw Error('MANIFEST_FILE_REJECTED');
  const manifest=JSON.parse(await readFile(path,'utf8'));
  const handle=await prepareOwnedWorkspace(manifest,{manifestDirectory:dirname(path),runsRoot:join(repo,'.jar/live-runs')});
  try{
    const preparation=await prepareOwnedInputs(handle,{mode,reviewedCatalogRoot:join(repo,'fixtures/ecc-mini')});
    const verifier=manifest.verifier?await readBounded(resolve(dirname(path),manifest.verifier.root),manifest.verifier.entrypoint,65536):null;
    if(verifier&&handle.files.some(file=>file.hash===verifier.hash))throw Error('VERIFIER_MODEL_BOUNDARY_FAILED');
    const binary=await readFile(join(repo,'.jar/m12-effect-input-v1/runtime/codex.exe'));
    // The binary byte hash is checked against the already reviewed runtime pin.
    const {createHash}=await import('node:crypto');
    const pinned=createHash('sha256').update(binary).digest('hex');
    const verified=pinned==='8f0554ede25bbc5450921897c468b2e84635aa513c5017457997af0954581f49';
    const readiness=liveReadiness({runtimeVersion:verified?'0.158.0-alpha.2.1':null,
      protocol:verified?{dynamicTools:true,ephemeral:true,modelProvider:true}:null,networkAuthorized:allowNetwork,
      authMode,provider,prepared:true,verifierSeparated:!!verifier,surfaces:preparation.surfaces});
    const body={schemaVersion:'jar.live-plan.v1',status:'prepared_live_blocked',runId:handle.id,mode,providerKind:'live_codex_provider',
      manifestHash:handle.manifestHash,taskHash:handle.taskHash,startStateHash:handle.startStateHash,runtimeArtifactHash:pinned,
      workspaceRoot:handle.workspaceRoot,files:handle.files,surfaces:preparation.surfaces,readiness,
      modelInputHashes:preparation.inputs.map(i=>({channel:i.channel,hash:sha256(i.text),bytes:Buffer.byteLength(i.text)})),
      verifier:{status:verifier?'prepared_not_executed':'missing',hash:verifier?.hash??null,modelVisible:false},runtimeLaunches:0,externalProviderCalls:0};
    const plan={id:`live_plan_${sha256(body)}`,...body},planPath=join(handle.runRoot,'plan.json');
    await writeFile(planPath,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
    return {status:plan.status,planPath,workspaceRoot:handle.workspaceRoot,readiness,surfaces:plan.surfaces,
      retainedOwnedWorkspace:true,runtimeLaunches:0,externalProviderCalls:0};
  }catch(error){await disposeOwnedWorkspace(handle);throw error;}
}
