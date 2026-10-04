import { readFile,writeFile,mkdir,copyFile,readdir,lstat,rename } from 'node:fs/promises';
import { join,dirname,resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ownedState } from './owned-workspace.js';
import { readRpcBounded,writeRpcAtomic,validateRpcResponse } from './sandbox-rpc.js';
import { assertWindowsSandboxIdle,createOwnedSandboxSession,queryWindowsSandboxProcesses,queryWindowsSandboxSessions,stopWindowsSandboxSession } from './sandbox-session.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const error=code=>Object.assign(new Error(code),{code});
export function trackOwnedSandboxChild(child){
  if(!child||!Number.isSafeInteger(child.pid)||child.pid<1)throw error('OWNED_SANDBOX_PID_INVALID');
  let closed=child.exitCode!==null&&child.exitCode!==undefined||child.signalCode!==null&&child.signalCode!==undefined,resolveClosed;
  const closedPromise=new Promise(resolve=>{resolveClosed=resolve;if(closed)resolve();});
  child.once('close',()=>{closed=true;resolveClosed();});
  return Object.freeze({child,pid:child.pid,get closed(){return closed;},closedPromise});
}
export async function finalizeExecutorSandbox(disposal,{runId,session,lifecycleTimeouts={}}){
  if(disposal?.schemaVersion!=='jar.sandbox-executor-disposal.v1'||disposal.runId!==runId||disposal.workspaceExported!==true
    ||disposal.guestStateGone!==true||disposal.ownedProcessesRemaining!==0||disposal.bridgeSettled!==true
    ||disposal.toolExecutionNetwork!=='disabled_by_windows_sandbox')throw error('EXECUTOR_DISPOSAL_UNVERIFIED');
  const termination=await session.settle(lifecycleTimeouts);
  return {...disposal,guestDisposalReceiptValidated:true,...termination,settled:true};
}
export async function finalizeVerifierSandbox(receipt,{runId,session,lifecycleTimeouts={}}){
  if(receipt?.schemaVersion!=='jar.sandbox-verifier-receipt.v1'||receipt.runId!==runId||!['passed','failed'].includes(receipt.status)
    ||receipt.ownedProcessesRemaining!==0||receipt.guestTerminatedRequested!==true
    ||receipt.toolExecutionNetwork!=='disabled_by_windows_sandbox'||receipt.modelHadVerifierAccess!==false)throw error('VERIFIER_DISPOSAL_UNVERIFIED');
  const termination=await session.settle(lifecycleTimeouts);
  return {...receipt,guestVerifierReceiptValidated:true,...termination,settled:true};
}
async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function copyTree(from,to){await mkdir(to,{recursive:true});for(const item of await readdir(from,{withFileTypes:true})){
  if(item.isSymbolicLink())throw error('STAGING_LINK_REJECTED');const source=join(from,item.name),target=join(to,item.name);
  item.isDirectory()?await copyTree(source,target):await copyFile(source,target);}}
async function addManifest(root,relativePaths){const files=[];for(const path of relativePaths){const bytes=await readFile(join(root,path));files.push({path:path.replaceAll('\\','/'),sha256:digest(bytes),bytes:bytes.length});}return files;}
async function pollJson(path,deadline){while(Date.now()<deadline){try{return await readRpcBounded(path);}catch(e){if(!['ENOENT','RPC_JSON_MALFORMED'].includes(e.code))throw e;}await wait(50);}throw error('SANDBOX_TIMEOUT');}
export async function waitForVerifierReceipt(stage,lifecycle,{timeoutMs=120000}={}){
  const started=Date.now(),receiptPath=join(stage.output,'receipt.json'),failurePath=join(stage.output,'failure.json');
  let incomplete=false;
  const readPublished=async path=>{try{return await readRpcBounded(path);}catch(cause){
    if(cause.code==='RPC_JSON_MALFORMED'){incomplete=true;return null;}
    if(cause.code==='ENOENT')return null;throw cause;}};
  const marker=async name=>exists(join(stage.output,name+'.json'));
  while(Date.now()-started<timeoutMs){
    const receipt=await readPublished(receiptPath);
    if(receipt)return {receipt,elapsedMs:Date.now()-started};
    const failure=await readPublished(failurePath);
    if(failure){const failureError=error(/^[A-Z_]+$/.test(failure.code??'')?failure.code:'VERIFIER_BOOTSTRAP_FAILED');failureError.lifecycle={pid:lifecycle.pid,spawnObserved:true,closeObserved:lifecycle.closed,exitCode:lifecycle.child.exitCode??null,elapsedMs:Date.now()-started,lastStage:await marker('verifier-driver-started')?'verifier_driver_started':await marker('network-check-passed')?'network_check_passed':await marker('bootstrap-started')?'bootstrap_started':'not_observed'};throw failureError;}
    // WindowsSandbox.exe is a launcher on some Windows builds: its exact child
    // can close successfully while the mapped guest continues bootstrapping.
    // Record that lifecycle, but only receipt/failure/markers classify the guest.
    await wait(50);
  }
  if(incomplete)throw error('RPC_JSON_MALFORMED');
  const bootstrap=await marker('bootstrap-started'),driver=await marker('verifier-driver-started');
  const code=!bootstrap?'VERIFIER_BOOTSTRAP_NOT_OBSERVED':!driver?'VERIFIER_DRIVER_NOT_STARTED':'VERIFIER_RECEIPT_NOT_EMITTED',failure=error(code);
  failure.lifecycle={pid:lifecycle.pid,spawnObserved:true,closeObserved:lifecycle.closed,exitCode:lifecycle.child.exitCode??null,elapsedMs:Date.now()-started,lastStage:driver?'verifier_driver_started':await marker('network-check-passed')?'network_check_passed':bootstrap?'bootstrap_started':'not_observed'};throw failure;
}
function sandboxXml(root,command){return `<Configuration><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><PrinterRedirection>Disable</PrinterRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><MappedFolders><MappedFolder><HostFolder>${xml(root)}</HostFolder><SandboxFolder>C:\\JAR</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>${command}</Command></LogonCommand></Configuration>\n`;}

export async function stageSandboxExecutor(handle,{mapping,selectedIds,repositoryRoot=resolve('.')}={}){
  const state=ownedState(handle),root=join(handle.runRoot,'executor'),input=join(root,'input'),bridge=join(root,'bridge'),output=join(root,'output');
  await mkdir(join(input,'runtime'),{recursive:true});await mkdir(join(input,'scripts'),{recursive:true});await mkdir(join(input,'workspace'),{recursive:true});
  await mkdir(join(bridge,'requests'),{recursive:true});await mkdir(join(bridge,'responses'),{recursive:true});await mkdir(output);
  await copyTree(handle.workspaceRoot,join(input,'workspace'));
  const sources={
    'runtime/node.exe':join(repositoryRoot,'.jar/m12-effect-input-v1/runtime/node.exe'),
    'scripts/live-sandbox-executor-guest.mjs':join(repositoryRoot,'scripts/live-sandbox-executor-guest.mjs'),
    'scripts/live-sandbox-executor-bootstrap.ps1':join(repositoryRoot,'scripts/live-sandbox-executor-bootstrap.ps1'),
    'scripts/m11-capture-network-guard.ps1':join(repositoryRoot,'scripts/m11-capture-network-guard.ps1')};
  for(const [relative,source] of Object.entries(sources))await copyFile(source,join(input,relative));
  const selected=new Set(selectedIds),tools=mapping.filter(row=>selected.has(row.capability.id)).map(row=>({capabilityId:row.capability.id,toolName:row.native.name}));
  if(tools.length!==selected.size)throw error('EXECUTOR_SELECTION_INVALID');
  const immutableHashes={};for(const path of state.manifest.immutable)immutableHashes[path]=digest(await readFile(join(input,'workspace',path)));
  const {verifier:unusedVerifier,...guestManifest}=state.manifest;
  const plan={schemaVersion:'jar.sandbox-executor-plan.v1',runId:handle.id,manifest:guestManifest,tools,immutableHashes};
  await writeFile(join(input,'plan.json'),JSON.stringify(plan)+'\n',{flag:'wx'});
  const relativeFiles=[...Object.keys(sources),'plan.json',...state.manifest.include.map(path=>'workspace/'+path)];
  const manifestText=JSON.stringify({schemaVersion:'jar.sandbox-executor-package.v1',files:await addManifest(input,relativeFiles)},null,2)+'\n';
  await writeFile(join(input,'manifest.json'),manifestText,{flag:'wx'});
  const launcher=join(root,'executor.wsb'),manifestHash=digest(manifestText);
  await writeFile(launcher,sandboxXml(root,`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\JAR\\input\\scripts\\live-sandbox-executor-bootstrap.ps1 -ExpectedManifestHash ${manifestHash}`),{flag:'wx'});
  return {schemaVersion:'jar.sandbox-executor-stage.v1',runId:handle.id,root,input,bridge,output,launcher,manifestHash,
    toolExecutionNetwork:'pending_runtime_proof',hiddenVerifierMapped:false};
}

export async function launchSandboxExecutor(stage,{spawnProcess=spawn,timeoutMs=120000,inventoryProvider=queryWindowsSandboxProcesses,
  sessionProvider=queryWindowsSandboxSessions,stopSession=stopWindowsSandboxSession,sessionTimeouts={},disposalTimeoutMs=60000}={}){
  await assertWindowsSandboxIdle({inventoryProvider,sessionProvider});const launchTimestamp=Date.now();
  const child=spawnProcess('C:/Windows/System32/WindowsSandbox.exe',[stage.launcher],{windowsHide:true,stdio:'ignore'});
  await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});const lifecycle=trackOwnedSandboxChild(child),
    session=createOwnedSandboxSession({launcherPath:stage.launcher,launchTimestamp,launcherLifecycle:lifecycle,inventoryProvider,sessionProvider,stopSession,spawnProcess}),deadline=Date.now()+timeoutMs;
  const readyPath=join(stage.bridge,'ready.json'),failurePath=join(stage.output,'failure.json');
  try{await session.observe(sessionTimeouts);while(Date.now()<deadline){if(await exists(failurePath))throw error('EXECUTOR_GUEST_FAILED');if(await exists(readyPath))break;await wait(100);}
    if(!await exists(readyPath))throw error('EXECUTOR_READY_TIMEOUT');
    const ready=await readRpcBounded(readyPath),networkProof=await readRpcBounded(join(stage.bridge,'network-proof.json'));
    if(ready.runId!==stage.runId||ready.toolExecutionNetwork!=='disabled_by_windows_sandbox'||networkProof.activeAdapterCount!==0
      ||networkProof.defaultIpv4RouteCount!==0||networkProof.toolExecutionNetwork!=='disabled_by_windows_sandbox')throw error('EXECUTOR_IDENTITY_MISMATCH');
  const answered=new Set();
  return {stage,child,lifecycle,toolExecutionNetwork:ready.toolExecutionNetwork,networkProof,
    async exchange(request){const name=String(request.sequence).padStart(8,'0')+'.json';await writeRpcAtomic(join(stage.bridge,'requests'),name,request);
      const path=join(stage.bridge,'responses',name),response=await pollJson(path,Date.now()+30000);if(answered.has(request.sequence))throw error('RPC_DUPLICATE_RESPONSE');
      answered.add(request.sequence);return validateRpcResponse(response,request);},
    async dispose(){const body={schemaVersion:'jar.sandbox-executor-stop.v1',runId:stage.runId};await writeRpcAtomic(stage.bridge,'stop.json',{...body,stopHash:(await import('../../../core/src/hash.js')).sha256(body)});
      try{const disposal=await pollJson(join(stage.output,'disposal.json'),Date.now()+disposalTimeoutMs);
        return {...await finalizeExecutorSandbox(disposal,{runId:stage.runId,session,lifecycleTimeouts:sessionTimeouts}),workspaceRoot:join(stage.output,'workspace')};}
      catch(cause){try{await session.cleanup(sessionTimeouts);}catch{throw error('SANDBOX_CLEANUP_FAILED');}throw cause;}}};
  }catch(cause){if(session.observed)try{await session.cleanup(sessionTimeouts);}catch{throw error('SANDBOX_CLEANUP_FAILED');}throw cause;}
}

export async function stageSandboxVerifier(handle,{finalWorkspaceRoot,verifierRoot,entrypoint='verify.mjs',repositoryRoot=resolve('.')}={}){
  const root=join(handle.runRoot,'verifier-guest'),input=join(root,'input'),output=join(root,'output');await mkdir(join(input,'runtime'),{recursive:true});
  await mkdir(join(input,'workspace'),{recursive:true});await mkdir(join(input,'verifier'),{recursive:true});await mkdir(join(input,'scripts'),{recursive:true});await mkdir(output);
  await copyTree(finalWorkspaceRoot,join(input,'workspace'));await copyTree(verifierRoot,join(input,'verifier'));
  for(const [target,source] of Object.entries({'runtime/node.exe':join(repositoryRoot,'.jar/m12-effect-input-v1/runtime/node.exe'),
    'scripts/live-sandbox-verifier-guest.mjs':join(repositoryRoot,'scripts/live-sandbox-verifier-guest.mjs'),
    'scripts/verifier-detail.mjs':join(repositoryRoot,'scripts/verifier-detail.mjs'),
    'scripts/live-sandbox-verifier-bootstrap.ps1':join(repositoryRoot,'scripts/live-sandbox-verifier-bootstrap.ps1'),
    'scripts/m11-capture-network-guard.ps1':join(repositoryRoot,'scripts/m11-capture-network-guard.ps1')}))await copyFile(source,join(input,target));
  const plan={schemaVersion:'jar.sandbox-verifier-plan.v1',runId:handle.id,entrypoint};await writeFile(join(input,'plan.json'),JSON.stringify(plan)+'\n',{flag:'wx'});
  const launcher=join(root,'verifier.wsb');await writeFile(launcher,sandboxXml(root,'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\JAR\\input\\scripts\\live-sandbox-verifier-bootstrap.ps1'),{flag:'wx'});
  return {schemaVersion:'jar.sandbox-verifier-stage.v1',runId:handle.id,root,input,output,launcher,modelExecutorHadVerifierAccess:false};
}

export async function runSandboxVerifier(stage,{spawnProcess=spawn,timeoutMs=120000,inventoryProvider=queryWindowsSandboxProcesses,
  sessionProvider=queryWindowsSandboxSessions,stopSession=stopWindowsSandboxSession,sessionTimeouts={}}={}){
  await assertWindowsSandboxIdle({inventoryProvider,sessionProvider});const launchTimestamp=Date.now();
  const child=spawnProcess('C:/Windows/System32/WindowsSandbox.exe',[stage.launcher],{windowsHide:true,stdio:'ignore'});
  await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});const lifecycle=trackOwnedSandboxChild(child),
    session=createOwnedSandboxSession({launcherPath:stage.launcher,launchTimestamp,launcherLifecycle:lifecycle,inventoryProvider,sessionProvider,stopSession,spawnProcess});
  try{await session.observe(sessionTimeouts);const observed=await waitForVerifierReceipt(stage,lifecycle,{timeoutMs});
    const result=await finalizeVerifierSandbox(observed.receipt,{runId:stage.runId,session,lifecycleTimeouts:sessionTimeouts});
    return {...result,hostLifecycle:{pid:lifecycle.pid,spawnObserved:true,closeObserved:lifecycle.closed,exitCode:child.exitCode??null,elapsedMs:observed.elapsedMs}};
  }catch(cause){if(session.observed)try{await session.cleanup(sessionTimeouts);}catch{throw error('SANDBOX_CLEANUP_FAILED');}throw cause;}
}
