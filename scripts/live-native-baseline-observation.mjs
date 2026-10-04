import http from 'node:http';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../packages/core/src/hash.js';
import { prepareOwnedWorkspace, disposeOwnedWorkspace } from '../packages/runtime-adapters/codex/src/owned-workspace.js';
import { prepareOwnedInputs } from '../packages/runtime-adapters/codex/src/owned-preparation.js';
import { ownedToolMapping } from '../packages/runtime-adapters/codex/src/owned-tools.js';
import { liveProfile, LIVE_RUNTIME_HASH, LIVE_RUNTIME_VERSION } from '../packages/runtime-adapters/codex/src/live-profile.js';
import { createLiveTransport, bounded } from '../packages/runtime-adapters/codex/src/live-transport.js';
import { observeProviderTools, assessBaselinePair } from '../packages/runtime-adapters/codex/src/native-baseline-observation.js';
import { nativeBaselineProofPath } from '../bin/codex-live-v1.js';
import { discoverCodexRuntimeCandidates,selectRuntimeCandidate } from '../packages/runtime-adapters/codex/src/runtime-locator.js';
import { discoverRuntimeIdentity } from '../packages/runtime-adapters/codex/src/owned-runtime-store.js';

const repo=fileURLToPath(new URL('..',import.meta.url));
const manifestPath=join(repo,'fixtures/live-readiness/workspace-manifest.json');
const fakeBearer='jar-owned-loopback-fixture-not-a-credential';

const runtimeIndex=process.argv.indexOf('--runtime');
const explicitRuntime=runtimeIndex>=0&&process.argv[runtimeIndex+1]?await discoverRuntimeIdentity(process.argv[runtimeIndex+1]):null;
const candidates=explicitRuntime?[{path:explicitRuntime.sourcePath,version:explicitRuntime.version,sha256:explicitRuntime.sha256,size:explicitRuntime.size,available:true}]:await discoverCodexRuntimeCandidates();
const selection=selectRuntimeCandidate(candidates,{version:LIVE_RUNTIME_VERSION,sha256:LIVE_RUNTIME_HASH});
if(selection.status==='CODEX_RUNTIME_NOT_FOUND')throw Error('CODEX_RUNTIME_NOT_FOUND');
if(selection.status==='RUNTIME_REVALIDATION_REQUIRED'&&!process.argv.includes('--revalidate-current'))throw Error('RUNTIME_REVALIDATION_REQUIRED');
if(selection.status==='RUNTIME_REVALIDATION_REQUIRED'&&!explicitRuntime)throw Error('EXPLICIT_RUNTIME_REQUIRED_FOR_REVALIDATION');
const runtime=selection.candidate,runtimePath=runtime.path;

function syntheticResponse(index){
  const id=`resp-native-baseline-${index}`;
  const events=[{type:'response.created',response:{id}},
    {type:'response.output_item.done',item:{type:'message',role:'assistant',id:`msg-${index}`,content:[{type:'output_text',text:'Observed.'}]}},
    {type:'response.completed',response:{id,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  return events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

async function startCaptureServer(expectedDynamic){
  const observations=[];let requestIndex=0;
  const captured=expectedDynamic.map(()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject};});
  const server=http.createServer((request,response)=>{(async()=>{
    try{
      const index=requestIndex++;
      if(request.method!=='POST'||request.url!=='/v1/responses'||index>=expectedDynamic.length)throw Error('LOOPBACK_REQUEST_REJECTED');
      const chunks=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>2*1024*1024)throw Error('LOOPBACK_REQUEST_LIMIT');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      observations[index]=observeProviderTools({body,dynamicTools:expectedDynamic[index]});
      response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'close'});
      response.end(syntheticResponse(index),()=>captured[index].resolve());
    }catch(error){
      const code=/^[A-Z_]+$/.test(error?.message??'')?error.message:'LOOPBACK_CAPTURE_REJECTED';
      if(error?.safeDiagnostic)process.stderr.write(JSON.stringify({code,safeToolSchemaDiagnostic:error.safeDiagnostic})+'\n');
      const index=Math.max(0,requestIndex-1);captured[index]?.reject(Error(code));
      if(!response.headersSent)response.writeHead(400,{'content-type':'application/json','connection':'close'});
      response.end('{"error":"LOOPBACK_CAPTURE_REJECTED"}');
    }
  })();});
  server.requestTimeout=15000;server.headersTimeout=15000;
  server.on('connect',(_,socket)=>socket.destroy());server.on('upgrade',(_,socket)=>socket.destroy());
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const address=server.address();if(!address||typeof address==='string')throw Error('LOOPBACK_BIND_FAILED');
  return {port:address.port,observations,waitFor:index=>captured[index].promise,
    async close(){server.closeAllConnections();await new Promise(yes=>server.close(yes));}};
}

async function observeCondition({profile,dynamicTools,captureObserved}){
  const transport=createLiveTransport({runtimePath,profile,envKey:'JAR_ACCESS_TOKEN',environment:{
    SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,JAR_ACCESS_TOKEN:fakeBearer}});
  let nextId=0,threadId=null,turnId=null,resolveTurn,rejectTurn;
  const pending=new Map(),turnDone=new Promise((yes,no)=>{resolveTurn=yes;rejectTurn=no;});turnDone.catch(()=>{});
  const unsubscribe=transport.onMessage(message=>{
    if(message.id!==undefined&&(message.result!==undefined||message.error!==undefined)){
      const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);clearTimeout(waiter.timer);
      message.error?waiter.no(Error('APP_SERVER_RPC_FAILED')):waiter.yes(message.result);return;
    }
    if(message.id!==undefined&&message.method){transport.send({id:message.id,error:{code:-32601,message:'NO_RUNTIME_TOOLS_AUTHORIZED'}});rejectTurn(Error('UNEXPECTED_RUNTIME_REQUEST'));return;}
    if(message.method==='turn/completed'&&message.params?.threadId===threadId){
      message.params?.turn?.id===turnId?resolveTurn(message.params?.turn?.status??'unknown'):rejectTurn(Error('TURN_ID_MISMATCH'));
    }
    if(message.method==='transport/failure')rejectTurn(Error('TRANSPORT_FAILED'));
  });
  const request=(method,params)=>new Promise((yes,no)=>{
    const id=++nextId,timer=setTimeout(()=>{pending.delete(id);no(Error('RPC_TIMEOUT'));},15000);pending.set(id,{yes,no,timer});
    transport.send({id,method,params});
  });
  try{
    await transport.start();
    await request('initialize',{clientInfo:{name:'jar',title:'JAR',version:'0.1.0'},capabilities:{experimentalApi:true}});
    transport.send({method:'initialized'});
    const started=await request('thread/start',{...profile.thread,dynamicTools});threadId=started?.thread?.id;
    if(typeof threadId!=='string'||started.cwd!==profile.thread.cwd||started.model!==profile.thread.model
      ||started.modelProvider!==profile.thread.modelProvider||started.approvalPolicy!=='never'
      ||started.sandbox?.type!=='readOnly'||started.sandbox.networkAccess!==false)throw Error('EFFECTIVE_THREAD_MISMATCH');
    const turn=await request('turn/start',{threadId,cwd:profile.thread.cwd,approvalPolicy:'never',
      input:[{type:'text',text:'Return one short acknowledgement.',textElements:[]}]});
    turnId=turn?.turn?.id;if(typeof turnId!=='string')throw Error('TURN_ID_MISSING');
    await bounded(captureObserved,30000,'PROVIDER_REQUEST_NOT_OBSERVED');
    let terminalStatus='not_observed';try{terminalStatus=await bounded(turnDone,2000,'SYNTHETIC_TURN_TERMINAL_NOT_OBSERVED');}catch{}
    return {providerRequestObserved:true,syntheticTurnStatus:terminalStatus};
  }finally{
    for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.no(Error('SESSION_CLOSED'));}pending.clear();unsubscribe();
    const cleanup=await transport.dispose();if(cleanup.settled!==true)throw Error('APP_SERVER_CLEANUP_FAILED');
  }
}

let handle,server;
try{
  const manifest=JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath,'utf8'));
  handle=await prepareOwnedWorkspace(manifest,{manifestDirectory:dirname(manifestPath),runsRoot:join(repo,'.jar/live-runs')});
  const preparation=await prepareOwnedInputs(handle,{mode:'ASSIST',reviewedCatalogRoot:join(repo,'fixtures/ecc-mini')});
  const mapping=ownedToolMapping(handle),selected=mapping.filter(row=>preparation.request.exposedIds.includes(row.capability.id));
  const controlDynamic=[],assistDynamic=selected.map(row=>row.native);
  server=await startCaptureServer([controlDynamic,assistDynamic]);
  const intended=liveProfile({workspaceRoot:handle.workspaceRoot,codexHome:join(handle.runRoot,'codex-home'),model:'gpt-5.4'});
  const capture=liveProfile({workspaceRoot:handle.workspaceRoot,codexHome:intended.codexHome,model:'gpt-5.4',providerBaseUrl:`http://127.0.0.1:${server.port}/v1`});
  await mkdir(capture.codexHome);await writeFile(join(capture.codexHome,'config.toml'),capture.toml,{flag:'wx'});
  const controlLifecycle=await observeCondition({profile:capture,dynamicTools:controlDynamic,captureObserved:server.waitFor(0)});
  const assistLifecycle=await observeCondition({profile:capture,dynamicTools:assistDynamic,captureObserved:server.waitFor(1)});
  if(server.observations.length!==2||!server.observations[0]||!server.observations[1])throw Error('PROVIDER_REQUEST_NOT_OBSERVED');
  const candidateNames=mapping.map(row=>row.native.name),selectedNames=assistDynamic.map(tool=>tool.name);
  const assessment=assessBaselinePair({control:server.observations[0],assist:server.observations[1],candidateNames,selectedNames});
  if(assessment.status!=='NATIVE_BASELINE_VERIFIED')throw Error(assessment.status);
  const safeObservation=observation=>({native:observation.native,dynamic:observation.dynamic,effective:observation.effective,
    nativeBaselineHash:observation.nativeBaselineHash,dynamicToolSetHash:observation.dynamicToolSetHash,effectiveObservedHash:observation.effectiveObservedHash});
  const body={schemaVersion:'jar.native-baseline-proof.v1',status:assessment.status,observedAt:new Date().toISOString(),
    runtimeVersion:runtime.version,runtimeHash:runtime.sha256,runtimeSize:runtime.size,runtimePath,model:'gpt-5.4',providerId:'jar_live',wireApi:'responses',
    intendedProviderEndpoint:'https://api.openai.com/v1',captureProviderEndpoint:'owned_literal_loopback',
    intendedConfigHash:intended.configHash,captureConfigHash:capture.configHash,ownedCodexHomeIdentity:sha256(resolve(capture.codexHome)),
    sandboxPolicy:'read-only',approvalPolicy:'never',ephemeral:true,environments:[],selectedCapabilityRoots:[],
    disabledFeatures:intended.baseline.disabledFeatures,mcpState:'empty',pluginAppState:'empty',webState:'disabled',agentState:'disabled',memoryState:'disabled',
    control:{...safeObservation(server.observations[0]),lifecycle:controlLifecycle},
    assist:{...safeObservation(server.observations[1]),lifecycle:assistLifecycle},
    jarDynamicCandidateIds:mapping.map(row=>row.capability.id),jarDynamicCandidateNames:candidateNames,
    jarDynamicSelectedIds:selected.map(row=>row.capability.id),jarDynamicSelectedNames:selectedNames,
    jarDynamicSchemaHashes:Object.fromEntries(server.observations[1].dynamic.map(tool=>[tool.name,tool.schemaHash])),
    equivalentCapabilityWarnings:assessment.warnings,baselineHashesEqual:assessment.baselineEqual,
    security:{externalProviderCalls:0,fakeProviderRequests:2,inferenceCalls:0,credentialValuesAccessed:0,credentialsRequired:0,
      normalCodexHomeAccessed:false,normalCodexHomeMutations:0,modelEditableHostExecution:false,rawRequestBodiesPersisted:false,
      promptsPersistedByCapture:false,requestHeadersPersisted:false},runtimeActivity:{codexAppServerLaunches:2,windowsSandboxLaunches:0}};
  const proof={id:`native_baseline_proof_${sha256(body)}`,...body};
  await mkdir(dirname(nativeBaselineProofPath),{recursive:true});
  try{const previous=JSON.parse(await readFile(nativeBaselineProofPath,'utf8')),archive=join(dirname(nativeBaselineProofPath),`native-baseline-proof-${previous.runtimeVersion}-${previous.runtimeHash}.json`);
    await copyFile(nativeBaselineProofPath,archive,fsConstants.COPYFILE_EXCL).catch(error=>{if(error.code!=='EEXIST')throw error;});}catch(error){if(error.code!=='ENOENT'&&error.name!=='SyntaxError')throw error;}
  const temporary=`${nativeBaselineProofPath}.new`;await writeFile(temporary,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});await rename(temporary,nativeBaselineProofPath);
  process.stdout.write(JSON.stringify({status:proof.status,proofPath:nativeBaselineProofPath,proofId:proof.id,
    runtimePath,runtimeVersion:runtime.version,runtimeHash:runtime.sha256,nativeBaselineHash:proof.control.nativeBaselineHash,controlTools:proof.control.native.map(tool=>tool.name),
    assistDynamicTools:proof.assist.dynamic.map(tool=>tool.name)})+'\n');
}finally{
  if(server)await server.close();
  if(handle)await disposeOwnedWorkspace(handle);
}
