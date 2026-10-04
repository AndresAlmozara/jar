import { readFile,writeFile,mkdir,lstat } from 'node:fs/promises';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../packages/core/src/hash.js';
import { prepareOwnedWorkspace,disposeOwnedWorkspace,readBounded } from '../packages/runtime-adapters/codex/src/owned-workspace.js';
import { prepareOwnedInputs } from '../packages/runtime-adapters/codex/src/owned-preparation.js';
import { validateLiveIntent } from '../packages/runtime-adapters/codex/src/auth-boundary.js';
import { liveProfile,nativeBaseline,assertBaselinePair,environmentAuth,jevEnvironmentAuth,LIVE_RUNTIME_HASH,LIVE_RUNTIME_VERSION } from '../packages/runtime-adapters/codex/src/live-profile.js';
import { validateNativeBaselineProof } from '../packages/runtime-adapters/codex/src/native-baseline-observation.js';
import { ownedToolMapping } from '../packages/runtime-adapters/codex/src/owned-tools.js';
import { createSandboxToolCallback } from '../packages/runtime-adapters/codex/src/sandbox-rpc.js';
import { stageSandboxExecutor,launchSandboxExecutor,stageSandboxVerifier,runSandboxVerifier } from '../packages/runtime-adapters/codex/src/sandbox-executor.js';
import { createLiveTransport } from '../packages/runtime-adapters/codex/src/live-transport.js';
import { driveLiveSession } from '../packages/runtime-adapters/codex/src/live-session.js';
import { discoverCodexRuntimeCandidates,selectRuntimeCandidate } from '../packages/runtime-adapters/codex/src/runtime-locator.js';
import { resolvePinnedOwnedRuntime } from '../packages/runtime-adapters/codex/src/owned-runtime-store.js';

const repo=fileURLToPath(new URL('..',import.meta.url));
// Runtime admission is bound to version+hash. Cache path is discovery metadata.
const verifierProofPath=join(repo,'.jar/live-runs/verifier-only-AFfwiy/verifier-proof.json');
export const nativeBaselineProofPath=join(repo,'.jar/live-readiness/native-baseline-proof.json');
async function inspectNetworklessBoundary(){
  try{
    const json=path=>readFile(path,'utf8').then(text=>JSON.parse(text.replace(/^\uFEFF/,''))),proof=await json(verifierProofPath),{id,...body}=proof;
    const sourceRoot=join(repo,'.jar/live-runs',proof.sourceExecutorRun),disposal=await json(join(sourceRoot,'executor/output/disposal.json')),
      network=await json(join(sourceRoot,'executor/bridge/network-proof.json')),
      responses=await Promise.all([1,2,3].map(n=>json(join(sourceRoot,'executor/bridge/responses',String(n).padStart(8,'0')+'.json'))));
    const verified=id===`verifier_proof_${sha256(body)}`&&proof.schemaVersion==='jar.sandbox-verifier-proof.v1'
      &&proof.executorStatus==='NETWORKLESS_EXECUTOR_VERIFIED'&&proof.verifierStatus==='FRESH_VERIFIER_VERIFIED'
      &&proof.runId===disposal.runId&&disposal.workspaceExported===true&&disposal.guestStateGone===true&&disposal.ownedProcessesRemaining===0
      &&disposal.bridgeSettled===true&&disposal.toolExecutionNetwork==='disabled_by_windows_sandbox'
      &&network.activeAdapterCount===0&&network.defaultIpv4RouteCount===0&&network.toolExecutionNetwork==='disabled_by_windows_sandbox'
      &&responses.every(response=>response.runId===proof.runId&&response.status==='success')&&responses[2].result?.exitCode===0
      &&proof.verifier.status==='passed'&&proof.verifier.exitCode===0&&proof.verifier.ownedProcessesRemaining===0
      &&proof.verifier.toolExecutionNetwork==='disabled_by_windows_sandbox'&&proof.verifier.modelHadVerifierAccess===false
      &&proof.verifier.guestVerifierReceiptValidated===true&&proof.verifier.ownedSandboxProcessSettled===true;
    return {verified,proofId:verified?id:null,proofPath:verifierProofPath,runId:verified?proof.runId:null,
      networklessExecutorVerified:verified,freshVerifierVerified:verified};
  }catch{return {verified:false,proofId:null,proofPath:verifierProofPath,runId:null,networklessExecutorVerified:false,freshVerifierVerified:false};}
}
export async function inspectLiveArtifacts({runtimeCandidates=null,repoRoot=repo}={}){
  let candidates=[],selection;
  if(runtimeCandidates!==null){candidates=runtimeCandidates;selection=selectRuntimeCandidate(candidates,{version:LIVE_RUNTIME_VERSION,sha256:LIVE_RUNTIME_HASH});}
  else try{const candidate=await resolvePinnedOwnedRuntime(repoRoot);candidates=[candidate];selection={status:'ACCEPTED_OWNED_RUNTIME_RESOLVED',candidate,pathIsIdentity:false};}
  catch(error){selection={status:error.code??'OWNED_RUNTIME_RESOLUTION_FAILED',candidate:null,pathIsIdentity:false};}
  const runtime=['ACCEPTED_RUNTIME_RESOLVED','ACCEPTED_OWNED_RUNTIME_RESOLVED'].includes(selection.status)?selection.candidate:null,networklessBoundary=await inspectNetworklessBoundary();
  let nativeBaselineProof=null;try{nativeBaselineProof=JSON.parse(await readFile(nativeBaselineProofPath,'utf8'));}catch{}
  return {runtimePath:runtime?.path??null,runtimeHash:runtime?.sha256??null,runtimeVersion:runtime?.version??null,
    runtimeResolution:selection.status,runtimeIdentityAccepted:['ACCEPTED_RUNTIME_RESOLVED','ACCEPTED_OWNED_RUNTIME_RESOLVED'].includes(selection.status),runtimeOwned:runtime?.owned===true,runtimeManifestId:runtime?.manifestId??null,runtimeCandidates:candidates,
    networklessBoundary,nativeBaselineProof,nativeBaselineProofPath};
}
export function v1Readiness({artifacts,auth,profile,mode='ASSIST',strategy='deterministic',jevAuth=jevEnvironmentAuth({})}){
  const blockers=[],runtimeReady=artifacts.runtimeIdentityAccepted??artifacts.runtimeHash===LIVE_RUNTIME_HASH;
  if(!runtimeReady)blockers.push('PINNED_RUNTIME_MISMATCH');
  if(artifacts.networklessBoundary?.networklessExecutorVerified!==true||artifacts.networklessBoundary?.freshVerifierVerified!==true)
    blockers.push('NETWORKLESS_HOST_EXECUTOR_UNAVAILABLE');
  const baselineVerified=validateNativeBaselineProof(artifacts.nativeBaselineProof,{runtimeHash:artifacts.runtimeHash,
    model:profile.config.model,profile});
  if(!baselineVerified)blockers.push('NATIVE_BASELINE_NOT_OBSERVED');
  const jevRequired=mode==='ASSIST'&&strategy==='jev-live',authorizationRequired=[];
  if(!auth.credentialPresent)authorizationRequired.push('MAIN_MODEL_AUTHORIZATION_REQUIRED');
  if(jevRequired&&!jevAuth.credentialPresent)authorizationRequired.push('JEV_AUTHORIZATION_REQUIRED');
  const mainProvider={kind:'chatgpt_plan_responses',model:profile.config.model,
    authMode:auth.authMode==='jar_owned_chatgpt_oauth'?'jar_owned_chatgpt_oauth':'environment_chatgpt_oauth_access_token',
    envKey:auth.envKey,authState:auth.authState??(auth.credentialPresent?'present':'absent'),planPermission:auth.planPermission??null,
    credentialPersistedByJar:auth.credentialPersistedByJar===true,credentialLoggedByJar:false};
  const decisionProvider=jevRequired?{kind:'typesafe',model:jevAuth.model,authMode:'environment_api_key',envKey:jevAuth.envKey,
    authState:jevAuth.authState,credentialPersistedByJar:false,credentialLoggedByJar:false,usage:null}:
    {kind:'none',model:null,authMode:'not_required',envKey:null,authState:'not_required',credentialPersistedByJar:false,credentialLoggedByJar:false,usage:null};
  return {schemaVersion:'jar.live-preflight.v3',status:blockers.length?'BLOCKED':authorizationRequired.length?
    'AUTHORIZATION_REQUIRED':'READY_FOR_HUMAN_AUTHORIZED_LIVE_RUN',blockers,authorizationRequired,auth,mainProvider,decisionProvider,
    gates:{runtimeReady,nativeBaselineReady:baselineVerified,
      executorReady:artifacts.networklessBoundary?.networklessExecutorVerified===true,verifierReady:artifacts.networklessBoundary?.freshVerifierVerified===true,
      mainModelAuthReady:auth.credentialPresent,jevAuthReady:jevRequired?jevAuth.credentialPresent:true,
      workspaceReady:true,toolBoundaryReady:artifacts.networklessBoundary?.verified===true,liveLifecycleReady:true},
    runtimeVersion:artifacts.runtimeVersion,ownedProfilePrepared:true,supportedProviderConfiguration:true,
    writableRoots:profile.writableRoots,toolNetwork:artifacts.networklessBoundary?.verified?'disabled_by_windows_sandbox':null,approvalPolicy:'never',ephemeral:true,
    baselineId:baselineVerified?artifacts.nativeBaselineProof.id:profile.baseline.id,baselinePairValidated:baselineVerified,
    modelLifecycle:artifacts.networklessBoundary?.verified?'sandbox_executor_and_fresh_verifier_verified':'implemented_transport_loop_not_admitted',
    productionCommandRunner:artifacts.networklessBoundary?.verified?'windows_sandbox_verified':'guest_only',
    sandboxProvisioning:'standard_windows_sandbox_only',oauthImplemented:auth.authMode==='jar_owned_chatgpt_oauth',
    hostWorkspaceExecutionAdmitted:artifacts.networklessBoundary?.verified===true,nodeRuntimeVersion:process.version,
    networkBoundaryEvidence:artifacts.networklessBoundary,
    elevatedSandboxRequired:false,
    normalConfigMutations:0,modelRequests:0,networkAuthorizationPresent:false};
}
export async function prepareLiveV1({manifestPath,mode='ASSIST',provider='offline',prepareOnly=false,
  executeLive=false,allowNetwork=false,envKey='JAR_ACCESS_TOKEN',model,strategy='deterministic',environment=process.env,jevClient=null,
  mainAuth=null,acquireAccessToken=null,artifactsOverride=null}){
  validateLiveIntent({provider,prepareOnly,executeLive,allowNetwork});
  if(!['ASSIST','CONTROL'].includes(mode)||!['deterministic','jev-live'].includes(strategy))throw Error('LIVE_STRATEGY_INVALID');
  if(mode==='ASSIST'&&executeLive&&strategy!=='jev-live')throw Error('LIVE_JEV_SELECTION_REQUIRED');
  const auth=mainAuth??environmentAuth(envKey,environment),jevAuth=jevEnvironmentAuth(environment),baseline=nativeBaseline(model);
  assertBaselinePair(baseline,nativeBaseline(model));
  const artifacts=artifactsOverride??await inspectLiveArtifacts();
  const path=resolve(manifestPath),info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw Error('MANIFEST_FILE_REJECTED');
  const manifest=JSON.parse(await readFile(path,'utf8'));
  const handle=await prepareOwnedWorkspace(manifest,{manifestDirectory:dirname(path),runsRoot:join(repo,'.jar/live-runs')});
  try{
    const decisionEvents=[],telemetry={append:event=>decisionEvents.push(event)};
    const readinessProfile=liveProfile({workspaceRoot:handle.workspaceRoot,codexHome:join(handle.runRoot,'codex-home'),model,envKey});
    const readiness=v1Readiness({artifacts,auth,profile:readinessProfile,mode,strategy,jevAuth});
    let accessToken=null;
    if(!prepareOnly&&readiness.status==='READY_FOR_HUMAN_AUTHORIZED_LIVE_RUN'&&acquireAccessToken){
      accessToken=await acquireAccessToken();if(typeof accessToken!=='string'||!accessToken)throw Error('AUTHORIZATION_REQUIRED');
    }
    const preparation=await prepareOwnedInputs(handle,{mode,reviewedCatalogRoot:join(repo,'fixtures/ecc-mini'),capabilityProvider:strategy,
      prepareOnly:prepareOnly||readiness.status!=='READY_FOR_HUMAN_AUTHORIZED_LIVE_RUN',telemetry,...(jevClient?{client:jevClient}:{})});
    if(!manifest.verifier)throw Error('HIDDEN_VERIFIER_REQUIRED');
    const verifier=await readBounded(resolve(dirname(path),manifest.verifier.root),manifest.verifier.entrypoint,65536);
    if(handle.files.some(file=>file.hash===verifier.hash))throw Error('VERIFIER_MODEL_BOUNDARY_FAILED');
    const profile=readinessProfile;
    await mkdir(profile.codexHome);await writeFile(join(profile.codexHome,'config.toml'),profile.toml,{flag:'wx'});
    const body={schemaVersion:'jar.live-plan.v3',mode,strategy,runId:handle.id,taskHash:handle.taskHash,manifestHash:handle.manifestHash,
      workspaceRoot:handle.workspaceRoot,files:handle.files,readiness,nativeBaseline:readiness.baselinePairValidated?artifacts.nativeBaselineProof.control:baseline,
      nativeBaselineToolIds:readiness.baselinePairValidated?artifacts.nativeBaselineProof.control.native.map(tool=>tool.name):baseline.nativeBaselineToolIds,
      jarDynamicCandidateIds:preparation.surfaces.capabilities.candidates,
      jarDynamicSelectedIds:preparation.request?.exposedIds??null,
      effectiveObservedToolIds:readiness.baselinePairValidated?artifacts.nativeBaselineProof.assist.effective.map(tool=>tool.name):null,usedToolIds:null,
      withheldDynamicNativeEquivalent:readiness.baselinePairValidated?artifacts.nativeBaselineProof.equivalentCapabilityWarnings:'unknown_until_effective_native_observation',
      surfaces:preparation.surfaces,profileHash:profile.configHash,verifierHash:verifier.hash,
      modelInputHashes:preparation.inputs.map(input=>({channel:input.channel,hash:sha256(input.text)})),
      providers:{main:readiness.mainProvider,decision:readiness.decisionProvider},decisionProviderUsage:null,
      runtimeArtifacts:artifacts,runtimeLaunches:0,externalProviderCalls:0,typeSafeRequests:0,inferenceCalls:0};
    const planPath=join(handle.runRoot,'plan.json');await writeFile(planPath,JSON.stringify({id:sha256(body),...body},null,2)+'\n',{flag:'wx'});
    if(prepareOnly||readiness.status!=='READY_FOR_HUMAN_AUTHORIZED_LIVE_RUN')return {status:readiness.status,planPath,readiness,
      baselineId:readiness.baselineId,runtimeLaunches:0,externalProviderCalls:0,typeSafeRequests:0,inferenceCalls:0};
    const mapping=ownedToolMapping(handle),selectedIds=preparation.request.exposedIds;
    const executorStage=await stageSandboxExecutor(handle,{mapping,selectedIds,repositoryRoot:repo});
    let executor=await launchSandboxExecutor(executorStage),executorDisposed=false,executorDisposal=null,verifierResult=null;
    const executeTool=createSandboxToolCallback({runId:handle.id,mapping,selectedIds,client:executor});
    const transport=createLiveTransport({runtimePath:artifacts.runtimePath,profile,envKey,environment,accessToken});
    try{
      const session=await driveLiveSession({transport,thread:profile.thread,inputs:preparation.inputs,
        dynamicTools:mapping.filter(row=>selectedIds.includes(row.capability.id)).map(row=>row.native),executeTool,
        verify:async()=>{
          executorDisposal=await executor.dispose();executorDisposed=true;
          const verifierStage=await stageSandboxVerifier(handle,{finalWorkspaceRoot:executorDisposal.workspaceRoot,
            verifierRoot:resolve(dirname(path),manifest.verifier.root),entrypoint:manifest.verifier.entrypoint,repositoryRoot:repo});
          verifierResult=await runSandboxVerifier(verifierStage);return {status:verifierResult.status==='passed'?'passed':'failed'};
        }});
      if(!executorDisposed){executorDisposal=await executor.dispose();executorDisposed=true;}
      const successfulEvents=decisionEvents.filter(event=>event.success===true),usage=successfulEvents.length?{
        input_tokens:successfulEvents.reduce((n,event)=>n+(event.input_tokens??0),0),
        output_tokens:successfulEvents.reduce((n,event)=>n+(event.output_tokens??0),0),
        latency_ms:successfulEvents.reduce((n,event)=>n+(event.latency_ms??0),0)}:null;
      const receiptBody={schemaVersion:'jar.live-execution.v1',runId:handle.id,status:session.status,mode,strategy,
        mainProvider:{...readiness.mainProvider,authState:'present'},decisionProvider:{...readiness.decisionProvider,
          model:successfulEvents.at(-1)?.provider_model??readiness.decisionProvider.model,usage},session,
        executor:{toolExecutionNetwork:executor.toolExecutionNetwork,settled:executorDisposal?.settled===true},
        verifier:{status:verifierResult?.status??'not_run',settled:verifierResult?.settled===true},credentialValuesPersisted:false};
      const receipt={id:`live_execution_${sha256(receiptBody)}`,...receiptBody},receiptPath=join(handle.runRoot,'live-receipt.json');
      await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
      return {status:session.status==='passed'?'succeeded':'failed',planPath,receiptPath,readiness,baselineId:readiness.baselineId,
        runtimeLaunches:1,sandboxLaunches:verifierResult?2:1,externalProviderCalls:1,typeSafeRequests:decisionEvents.length,inferenceCalls:1};
    }finally{if(executor&&!executorDisposed){executorDisposal=await executor.dispose();executorDisposed=true;}}
  }catch(error){await disposeOwnedWorkspace(handle);throw error;}
}
