// Account-scoped catalog + freshly observed native baseline. No real inference probe.
// Sources: OpenAI SIWC /models-and-inference and JAR native-baseline-observation.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import {atomic,json,sha,fail,DiagnosticError,errorInfo,iso,journal} from './common.mjs';

const MODEL_ENDPOINT='https://api.openai.com/v1/models';
const safeModel=s=>typeof s==='string'&&/^[-a-zA-Z0-9.]{1,80}$/.test(s);
const RETIRED=new Set(['gpt-5.4','gpt-5.4-mini','gpt-5.2','gpt-5.3-codex']);
export async function authenticatedToken(d,scrub,{wait=ms=>new Promise(done=>setTimeout(done,ms))}={}){
  const service=new d.ChatGptAuthService(),status=await service.status();
  if(!status.authenticated||!status.planPermission||!['valid','refresh_required'].includes(status.tokenState))fail('CHATGPT_AUTH_NOT_READY',{status});
  // The app-server receives a fixed bearer for a bounded ten-minute model turn.
  // Refresh before launch, never partway through an experimental condition.
  const minimumValidityMs=720000;let accessToken,waitedMs=0;
  for(;;){try{accessToken=await service.usableAccessToken({minimumValidityMs});break;}catch(error){
    const delay=error.diagnostics?.retryAfterMs;
    if(error.code!=='REFRESH_NOT_YET_ALLOWED'||!Number.isSafeInteger(delay)||delay<1||waitedMs+delay>minimumValidityMs)throw error;
    waitedMs+=delay;await wait(delay);
  }}
  scrub.add(accessToken);
  if(typeof accessToken!=='string'||!accessToken)fail('CHATGPT_ACCESS_TOKEN_MISSING');
  return {accessToken,auth:d.runtimeAuthFromStatus(await service.status())};
}
export function normalizeCatalog(data){
  const rows=Array.isArray(data?.models)?data.models:Array.isArray(data?.data)?data.data:null;
  if(!rows)fail('ACCOUNT_MODEL_CATALOG_INVALID',{expected:'models[] or data[]'});
  const seen=new Set(),out=[];
  for(const row of rows){
    const model=row?.slug??row?.model??row?.id;
    if(!safeModel(model)||seen.has(model))continue;seen.add(model);
    const values=row.supported_reasoning_levels??row.supportedReasoningEfforts??row.supported_reasoning_efforts;
    const efforts=Array.isArray(values)?values.map(x=>typeof x==='string'?x:x?.effort??x?.reasoningEffort??x?.reasoning_effort).filter(x=>typeof x==='string'):null;
    const modalities=row.input_modalities??row.inputModalities;
    out.push({model,displayName:typeof (row.display_name??row.displayName)==='string'?(row.display_name??row.displayName):model,
      visible:row.hidden!==true&&(row.visibility===undefined||row.visibility==='list'),
      retired:RETIRED.has(model),efforts,inputModalities:Array.isArray(modalities)?modalities:null});
  }
  if(!out.length)fail('ACCOUNT_MODEL_CATALOG_EMPTY');return out;
}
export async function fetchAccountModels(accessToken,{fetchImpl=globalThis.fetch,scrub,timeoutMs=20000}={}){
  scrub?.add(accessToken);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    // Exact documented OAuth model-catalog endpoint. Never forward the bearer on redirects.
    const response=await fetchImpl(MODEL_ENDPOINT,{method:'GET',headers:{Authorization:'Bearer '+accessToken,Accept:'application/json'},redirect:'error',signal:controller.signal});
    let raw='',size=0;
    if(response.body){const chunks=[];for await(const chunk of response.body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>2*1024*1024){controller.abort();fail('ACCOUNT_MODEL_CATALOG_TOO_LARGE');}chunks.push(bytes);}raw=Buffer.concat(chunks).toString('utf8');}
    else {raw=await response.text();if(Buffer.byteLength(raw)>2*1024*1024)fail('ACCOUNT_MODEL_CATALOG_TOO_LARGE');}
    let data;try{data=JSON.parse(raw);}catch{if(response.ok)fail('ACCOUNT_MODEL_CATALOG_INVALID_JSON');}
    if(!response.ok){const message=data?.error?.message??data?.detail??response.statusText??'Catalog request rejected';
      fail('ACCOUNT_MODEL_CATALOG_HTTP_ERROR',{status:response.status,message:scrub?scrub.text(message):String(message)});}
    return {source:MODEL_ENDPOINT,observedAt:iso(),models:normalizeCatalog(data),accessVerifiedByInference:false};
  }catch(e){if(e instanceof DiagnosticError)throw e;fail(controller.signal.aborted?'ACCOUNT_MODEL_CATALOG_TIMEOUT':'ACCOUNT_MODEL_CATALOG_NETWORK_ERROR',{message:scrub?scrub.text(e.message):e.message});}
  finally{clearTimeout(timer);}
}
export function selectAccountModel(catalog,{requested='auto',effort='medium',pinned=null}={}){
  if(!['low','medium','high','xhigh'].includes(effort))fail('REASONING_EFFORT_INVALID',{effort});
  const eligible=catalog.models.filter(m=>m.visible&&!m.retired&&(!m.inputModalities||m.inputModalities.includes('text'))&&(!m.efforts||m.efforts.includes(effort)));
  const exact=requested!=='auto'?requested:pinned;
  if(exact){const model=eligible.find(m=>m.model===exact);if(!model)fail('MODEL_NOT_AVAILABLE_FOR_ACCOUNT',{requested:exact,available:eligible.map(m=>m.model),effort});return {model:model.model,effort,reason:requested!=='auto'?'explicit_catalog_match':'existing_manual_pin',catalogEntry:model};}
  // Preference is a policy, never an invented model id. Only a catalog-returned entry can win.
  const family=m=>/\bsol\b/i.test(m.model)?0:/\bterra\b/i.test(m.model)?1:/\bluna\b/i.test(m.model)?2:m.model==='gpt-5.5'?3:99;
  const ordered=eligible.filter(m=>family(m)<99).sort((a,b)=>family(a)-family(b)||b.model.localeCompare(a.model,'en',{numeric:true}));
  if(!ordered.length)fail('EXPLICIT_MODEL_SELECTION_REQUIRED',{available:eligible.map(m=>m.model),solution:'Use --model with an available catalog id; no automatic expensive-model fallback is performed.'});
  return {model:ordered[0].model,effort,reason:'account_catalog_sol_then_terra_then_luna',catalogEntry:ordered[0]};
}
export function modelProfile(d,options,effort='medium'){
  const profile=d.liveProfile(options);
  if(!['low','medium','high','xhigh'].includes(effort))fail('REASONING_EFFORT_INVALID',{effort});
  const config={...profile.config,model_reasoning_effort:effort};
  const toml=profile.toml.replace(/^model_reasoning_effort\s*=.*(?:\r?\n|$)/gm,'').trimEnd()+'\nmodel_reasoning_effort = '+JSON.stringify(effort)+'\n';
  return {...profile,config,toml,configHash:d.sha256?d.sha256(toml):sha(toml)};
}
export function directToolCatalog(metadata,model){
  const entry=metadata?.models?.find(row=>row.slug===model);
  if(!entry?.model_messages)fail('RUNTIME_MODEL_METADATA_MISSING',{model});
  return {models:[{...entry,tool_mode:'direct',use_responses_lite:false,apply_patch_tool_type:null,shell_type:'disabled'}]};
}
export function installDirectToolProfile(d,{model,resultsRoot,metadata}){
  const catalog=directToolCatalog(metadata,model),hash=sha(JSON.stringify(catalog));
  const file=path.join(resultsRoot,'MODEL-METADATA',hash+'.json');atomic(file,catalog);
  const original=d.liveProfile;
  d.liveProfile=options=>{
    if(options.model!==model)fail('MODEL_METADATA_IDENTITY_MISMATCH');
    const profile=original(options),config={...profile.config,model_catalog_json:file};
    const toml=profile.toml+'model_catalog_json = '+JSON.stringify(file)+'\n';
    return {...profile,config,toml,configHash:d.sha256?d.sha256(toml):sha(toml)};
  };
  return {hash,path:file,overrides:{tool_mode:'direct',use_responses_lite:false,apply_patch_tool_type:null,shell_type:'disabled'}};
}
const fakeBearer='jar-owned-loopback-fixture-not-a-credential';
function syntheticResponse(index){
  const id='resp-diagnostic-baseline-'+index;
  return [{type:'response.created',response:{id}},
    {type:'response.output_item.done',item:{type:'message',role:'assistant',id:'msg-'+index,content:[{type:'output_text',text:'Observed.'}]}},
    {type:'response.completed',response:{id,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}]
    .map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
async function withDeadline(promise,ms,code){let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(new DiagnosticError(code)),ms);})]);}finally{clearTimeout(timer);}}
async function captureServer(d,expectedDynamic,model,effort,emit){
  let index=0;const observations=[],slots=expectedDynamic.map(()=>{let yes,no;const promise=new Promise((y,n)=>{yes=y;no=n;});promise.catch(()=>{});return {promise,yes,no};});
  const server=http.createServer((req,res)=>{const n=index++;(async()=>{
    try{
      if(req.method!=='POST'||req.url!=='/v1/responses'||n>=expectedDynamic.length||req.headers.authorization!=='Bearer '+fakeBearer)fail('LOOPBACK_REQUEST_REJECTED');
      const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>2*1024*1024)fail('LOOPBACK_REQUEST_LIMIT');chunks.push(b);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(body.model!==model)fail('BASELINE_MODEL_MISMATCH',{expected:model,observed:body.model});
      if(body.reasoning?.effort!==effort)fail('BASELINE_EFFORT_MISMATCH',{expected:effort,observed:body.reasoning?.effort??null});
      const expected=expectedDynamic[n];
      // Codex legitimately omits the Responses `tools` member when the effective
      // tool set is empty. Normalize only that zero-tool case. If JAR supplied
      // dynamic tools, absence/non-array remains a hard failure.
      if(body.tools===undefined&&expected.length===0)body.tools=[];
      if(!Array.isArray(body.tools))fail(expected.length?'BASELINE_DYNAMIC_TOOLS_MISSING':'BASELINE_TOOLS_INVALID',{expectedDynamic:expected.map(t=>t.name),observedType:body.tools===undefined?'missing':typeof body.tools});
      observations[n]=d.observeProviderTools({body,dynamicTools:expected});
      const observedDynamic=observations[n].dynamic.map(t=>t.name).sort(),expectedNames=expected.map(t=>t.name).sort();
      if(JSON.stringify(observedDynamic)!==JSON.stringify(expectedNames))fail('BASELINE_DYNAMIC_TOOLS_MISMATCH',{expected:expectedNames,observed:observedDynamic});
      emit('native_tools_observed',{condition:n===0?'native_only':'all_dynamic',model,effort,observation:observations[n]});
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'close'});
      res.end(syntheticResponse(n),()=>slots[n].yes());
    }catch(e){slots[n]?.no(e);if(!res.headersSent)res.writeHead(400,{'content-type':'application/json','connection':'close'});res.end('{"error":"LOOPBACK_CAPTURE_REJECTED"}');}
  })();});
  server.requestTimeout=15000;server.headersTimeout=15000;server.on('connect',(_,s)=>s.destroy());server.on('upgrade',(_,s)=>s.destroy());
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  return {port:server.address().port,observations,waitFor:n=>slots[n].promise,async close(){server.closeAllConnections();await new Promise(yes=>server.close(yes));}};
}
async function observeCondition(d,{runtimePath,profile,dynamicTools,captured}){
  const transport=d.createLiveTransport({runtimePath,profile,envKey:'JAR_ACCESS_TOKEN',environment:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,JAR_ACCESS_TOKEN:fakeBearer}});
  let id=0,threadId=null,turnId=null,terminal=null,unexpected=null;const pending=new Map();
  const unsubscribe=transport.onMessage(message=>{
    if(message.id!==undefined&&(message.result!==undefined||message.error!==undefined)){
      const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);message.error?p.no(new DiagnosticError('BASELINE_RPC_FAILED',{error:message.error})):p.yes(message.result);return;
    }
    if(message.id!==undefined&&message.method){transport.send({id:message.id,error:{code:-32601,message:'NO_RUNTIME_TOOLS_AUTHORIZED'}});unexpected='BASELINE_UNEXPECTED_RUNTIME_REQUEST';return;}
    if(message.method==='transport/failure')unexpected='BASELINE_TRANSPORT_FAILED';
    if(message.method==='turn/completed'&&message.params?.threadId===threadId)terminal=message.params.turn;
  });
  const request=(method,params)=>new Promise((yes,no)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);no(new DiagnosticError('BASELINE_RPC_TIMEOUT',{method}));},15000);
    pending.set(n,{yes,no,timer});try{transport.send({id:n,method,params});}catch(e){clearTimeout(timer);pending.delete(n);no(e);}});
  try{
    await transport.start();await request('initialize',{clientInfo:{name:'jar',title:'JAR',version:'0.1.0'},capabilities:{experimentalApi:true}});transport.send({method:'initialized'});
    const start=await request('thread/start',{...profile.thread,dynamicTools});threadId=start?.thread?.id;
    if(typeof threadId!=='string'||start.cwd!==profile.thread.cwd||start.model!==profile.thread.model||start.modelProvider!==profile.thread.modelProvider||start.approvalPolicy!=='never'||start.sandbox?.type!=='readOnly'||start.sandbox.networkAccess!==false)fail('BASELINE_THREAD_MISMATCH');
    const turn=await request('turn/start',{threadId,cwd:profile.thread.cwd,approvalPolicy:'never',effort:profile.config.model_reasoning_effort,input:[{type:'text',text:'Return one short acknowledgement.',textElements:[]}]});
    turnId=turn?.turn?.id;if(typeof turnId!=='string')fail('BASELINE_TURN_ID_MISSING');
    await withDeadline(captured,30000,'PROVIDER_REQUEST_NOT_OBSERVED');
    if(unexpected)fail(unexpected);
    return {providerRequestObserved:true,syntheticTurnStatus:terminal?.id===turnId?terminal.status:'not_observed',realInferenceCalls:0};
  }finally{
    for(const p of pending.values()){clearTimeout(p.timer);p.no(new DiagnosticError('SESSION_CLOSED'));}pending.clear();unsubscribe();
    const cleanup=await transport.dispose();if(cleanup?.settled!==true)fail('BASELINE_APP_SERVER_CLEANUP_FAILED');
  }
}
export async function observeModelBaseline(d,{repo,root,config,artifacts,dir,scrub}){
  const j=journal(dir,scrub),base=path.join(root,'tasks/03-capability-exposure'),manifest=json(path.join(base,'manifest.json'));
  let handle,server;
  try{
    handle=await d.prepareOwnedWorkspace(manifest,{manifestDirectory:base,runsRoot:path.join(repo,'.jar/live-runs')});
    const mapping=d.ownedToolMapping(handle),dynamic=mapping.map(r=>r.native);
    server=await captureServer(d,[[],dynamic],config.model,config.effort,j.emit);
    const intended=modelProfile(d,{workspaceRoot:handle.workspaceRoot,codexHome:path.join(handle.runRoot,'baseline-home'),model:config.model},config.effort);
    const profile=modelProfile(d,{workspaceRoot:handle.workspaceRoot,codexHome:intended.codexHome,model:config.model,providerBaseUrl:`http://127.0.0.1:${server.port}/v1`},config.effort);
    fs.mkdirSync(profile.codexHome);fs.writeFileSync(path.join(profile.codexHome,'config.toml'),profile.toml,{flag:'wx'});
    const controlLifecycle=await observeCondition(d,{runtimePath:artifacts.runtimePath,profile,dynamicTools:[],captured:server.waitFor(0)});
    const assistLifecycle=await observeCondition(d,{runtimePath:artifacts.runtimePath,profile,dynamicTools:dynamic,captured:server.waitFor(1)});
    const [control,assist]=server.observations;if(!control||!assist)fail('PROVIDER_REQUEST_NOT_OBSERVED');
    const names=dynamic.map(t=>t.name),assessment=d.assessBaselinePair({control,assist,candidateNames:names,selectedNames:names});
    if(assessment.status!=='NATIVE_BASELINE_VERIFIED')fail(assessment.status,{assessment});
    const body={schemaVersion:'jar.native-baseline-proof.v1',status:assessment.status,observedAt:iso(),runtimeVersion:artifacts.runtimeVersion,runtimeHash:artifacts.runtimeHash,
      model:config.model,reasoningEffort:config.effort,providerId:'jar_live',wireApi:'responses',intendedProviderEndpoint:'https://api.openai.com/v1',captureProviderEndpoint:'owned_literal_loopback',
      intendedConfigHash:intended.configHash,captureConfigHash:profile.configHash,ownedCodexHomeIdentity:d.sha256(path.resolve(profile.codexHome)),
      sandboxPolicy:'read-only',approvalPolicy:'never',ephemeral:true,environments:[],selectedCapabilityRoots:[],disabledFeatures:intended.baseline.disabledFeatures,
      mcpState:'empty',pluginAppState:'empty',webState:'disabled',agentState:'disabled',memoryState:'disabled',
      control:{...control,lifecycle:controlLifecycle},assist:{...assist,lifecycle:assistLifecycle},jarDynamicCandidateIds:mapping.map(r=>r.capability.id),jarDynamicCandidateNames:names,
      jarDynamicSelectedIds:mapping.map(r=>r.capability.id),jarDynamicSelectedNames:names,jarDynamicSchemaHashes:Object.fromEntries(assist.dynamic.map(t=>[t.name,t.schemaHash])),
      equivalentCapabilityWarnings:assessment.warnings,baselineHashesEqual:assessment.baselineEqual,
      security:{externalProviderCalls:0,fakeProviderRequests:2,inferenceCalls:0,credentialValuesAccessed:0,credentialsRequired:0,normalCodexHomeAccessed:false,normalCodexHomeMutations:0,modelEditableHostExecution:false,rawRequestBodiesPersisted:false,promptsPersistedByCapture:false,requestHeadersPersisted:false},
      runtimeActivity:{codexAppServerLaunches:2,windowsSandboxLaunches:0}};
    const proof={id:'native_baseline_proof_'+d.sha256(body),...body};
    if(!d.validateNativeBaselineProof(proof,{runtimeHash:artifacts.runtimeHash,model:config.model,profile:intended}))fail('NEW_BASELINE_VALIDATION_FAILED');
    j.write('native-baseline-proof.json',proof);return proof;
  }finally{try{if(server)await server.close();}finally{if(handle)await d.disposeOwnedWorkspace(handle);}}
}
export async function prepareModelAccess(d,{repo,root,config,runDir,repoHash,scrub,log=()=>{},fetchImpl=globalThis.fetch,
  readRuntimeMetadata=()=>json(path.join(os.homedir(),'.codex/models_cache.json'))}){
  const resultsRoot=path.dirname(runDir);
  const auth=await authenticatedToken(d,scrub),artifacts=await d.inspectLiveArtifacts();
  if(artifacts.runtimeIdentityAccepted!==true)fail('PINNED_RUNTIME_MISMATCH',{resolution:artifacts.runtimeResolution});
  log('Querying the current ChatGPT-account model catalog (no inference, no Sandbox).');
  const catalog=await fetchAccountModels(auth.accessToken,{fetchImpl,scrub});atomic(path.join(runDir,'account-model-catalog.json'),catalog);
  const pinPath=path.join(resultsRoot,'MODEL-PIN.json');let pin=null;
  if(fs.existsSync(pinPath)){pin=json(pinPath);if(pin.repoHash!==repoHash)pin=null;}
  const selection=selectAccountModel(catalog,{requested:config.model,effort:config.effort,pinned:pin?.model??null});
  const resolved={...config,model:selection.model,effort:selection.effort};
  const toolProfile=installDirectToolProfile(d,{model:resolved.model,resultsRoot,metadata:readRuntimeMetadata()});
  atomic(path.join(runDir,'runtime-tool-profile.json'),toolProfile);
  const profile=modelProfile(d,{workspaceRoot:path.join(repo,'.jar','smoke-readiness-workspace'),codexHome:path.join(repo,'.jar','smoke-readiness-home'),model:resolved.model},resolved.effort);
  const cachePath=path.join(resultsRoot,'MODEL-BASELINES',sha(JSON.stringify({repoHash,model:resolved.model,effort:resolved.effort,runtime:artifacts.runtimeHash,toolProfile:toolProfile.hash}))+'.json');
  let proof=null;try{const cached=json(cachePath);if(cached.reasoningEffort===resolved.effort&&d.validateNativeBaselineProof(cached,{runtimeHash:artifacts.runtimeHash,model:resolved.model,profile}))proof=cached;}catch(e){if(e.code!=='ENOENT')log('Existing model-baseline cache not reusable; observing it again.');}
  log('Selected '+resolved.model+' / '+resolved.effort+' from your account catalog. This model stays fixed for the batch.');
  if(!proof){log('Observing native tool boundaries for the selected model on local loopback (zero real inference).');
    proof=await observeModelBaseline(d,{repo,root,config:resolved,artifacts,dir:path.join(runDir,'model-baseline'),scrub});atomic(cachePath,proof);
  }else log('Reusing a verified matching model/runtime/source native-boundary observation.');
  atomic(path.join(runDir,'native-baseline-proof.json'),proof);
  const currentArtifacts={...artifacts,nativeBaselineProof:proof,nativeBaselineProofPath:path.join(runDir,'native-baseline-proof.json')};
  const ready=d.v1Readiness({artifacts:currentArtifacts,auth:auth.auth,profile,mode:'ASSIST',strategy:'jev-live',jevAuth:d.jevEnvironmentAuth(process.env)});
  if(ready.status!=='READY_FOR_HUMAN_AUTHORIZED_LIVE_RUN')fail('LIVE_READINESS_BLOCKED',{readiness:ready});
  Object.defineProperty(resolved,'modelBaselineProof',{value:proof,enumerable:false});
  atomic(pinPath,{model:resolved.model,effort:resolved.effort,repoHash,source:'authenticated_account_catalog',pinnedAt:iso()});
  const evidence={...selection,toolProfile,catalogSource:catalog.source,catalogObservedAt:catalog.observedAt,nativeBaselineId:proof.id,
    accessVerifiedByInference:false,inferenceCheck:'first real benchmark turn; Sandbox starts lazily at first authorized dynamic-tool call',extraRealInferenceCalls:0};
  atomic(path.join(runDir,'model-selection.json'),evidence);return {config:resolved,selection:evidence,ready};
}
