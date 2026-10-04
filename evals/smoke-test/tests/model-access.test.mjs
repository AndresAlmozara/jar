// Offline regression tests. Catalog/transport doubles are synthetic, not live-access proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../run.mjs';
import {json,sha,redactor,filesUnder} from '../lib/common.mjs';
import {normalizeCatalog,fetchAccountModels,selectAccountModel,modelProfile,observeModelBaseline,prepareModelAccess,directToolCatalog,authenticatedToken} from '../lib/model-access.mjs';
import {classifyProviderFailure} from '../lib/model-session.mjs';
import {runCondition} from '../lib/bridge.mjs';
import {executeConditions,schedule} from '../lib/orchestrator.mjs';
import {fakeJar,temporary} from './helpers.mjs';
const catalog=rows=>({models:normalizeCatalog({models:rows})});
const model=(slug,extra={})=>({slug,visibility:'list',supported_reasoning_levels:[{effort:'medium'}],...extra});
const code=value=>e=>e.code===value;
const response=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const token='FAKE_PRIVATE_OAUTH_TOKEN_FOR_OFFLINE_TESTS';
test('authentication waits for allowed renewal and requires the entire model-turn lifetime',async()=>{let calls=0;const waits=[];
  const d={ChatGptAuthService:class{async status(){return {authenticated:true,planPermission:true,tokenState:'valid'};}
    async usableAccessToken(options){assert.equal(options.minimumValidityMs,720000);if(++calls===1)throw Object.assign(Error('wait'),{code:'REFRESH_NOT_YET_ALLOWED',diagnostics:{retryAfterMs:200}});return token;}},runtimeAuthFromStatus:s=>s};
  const result=await authenticatedToken(d,{add(){}},{wait:async ms=>waits.push(ms)});assert.equal(result.accessToken,token);assert.deepEqual(waits,[200]);assert.equal(calls,2);});
const config={...json(path.join(ROOT,'config/diagnostic.json')),model:'gpt-test-sol'};
async function fixture(fn){const temp=temporary();try{return await fn(temp);}finally{fs.rmSync(temp,{recursive:true,force:true});}}

test('Catalog accepts both documented models-slug and data-id envelopes',()=>{
  assert.equal(normalizeCatalog({data:[{id:'gpt-test-sol'}]})[0].model,'gpt-test-sol');
  assert.deepEqual(normalizeCatalog({models:[model('gpt-test-sol') ]})[0].efforts,['medium']);
});
test('Retired gpt-5.4 is never auto-selected or accepted explicitly',()=>{
  const c=catalog([model('gpt-5.4'),model('gpt-test-sol')]);assert.equal(selectAccountModel(c).model,'gpt-test-sol');
  assert.throws(()=>selectAccountModel(c,{requested:'gpt-5.4'}),code('MODEL_NOT_AVAILABLE_FOR_ACCOUNT'));
});
test('Hidden or unsupported-effort catalog models cannot be selected',()=>{
  const c=catalog([model('gpt-9-sol',{visibility:'hide'}),model('gpt-8-sol',{supported_reasoning_levels:[{effort:'high'}]}),model('gpt-6-sol')]);
  assert.equal(selectAccountModel(c).model,'gpt-6-sol');
});
test('Missing preferred family does not invent a model or silently choose an expensive one',()=>{
  assert.throws(()=>selectAccountModel(catalog([model('gpt-6-astra')])),code('EXPLICIT_MODEL_SELECTION_REQUIRED'));
});
test('Exact explicit choice is resolved only against account catalog',()=>{
  const c=catalog([model('gpt-test-luna')]);assert.equal(selectAccountModel(c,{requested:'gpt-test-luna'}).model,'gpt-test-luna');
  assert.throws(()=>selectAccountModel(c,{requested:'made-up-model'}),code('MODEL_NOT_AVAILABLE_FOR_ACCOUNT'));
});
test('Manual pin wins over new catalog entries and unavailable pin fails closed',()=>{
  const c=catalog([model('gpt-6-sol'),model('gpt-7-sol')]);assert.equal(selectAccountModel(c,{pinned:'gpt-6-sol'}).model,'gpt-6-sol');
  assert.throws(()=>selectAccountModel(c,{pinned:'gpt-5.5'}),code('MODEL_NOT_AVAILABLE_FOR_ACCOUNT'));
});
test('Model-catalog GET uses same OAuth token, fixed official endpoint, and no redirect',async()=>{
  let seen;const r=await fetchAccountModels(token,{scrub:redactor(),fetchImpl:async(url,opts)=>{seen={url,opts};return response({models:[model('gpt-test-sol')]});}});
  assert.equal(seen.url,'https://api.openai.com/v1/models');assert.equal(seen.opts.method,'GET');assert.equal(seen.opts.redirect,'error');
  assert.equal(seen.opts.headers.Authorization,'Bearer '+token);assert.equal(seen.opts.body,undefined);assert.equal(r.accessVerifiedByInference,false);assert(!JSON.stringify(r).includes(token));
});
test('Catalog UTF-8 remains intact when a character spans response chunks',async()=>{
  const bytes=Buffer.from(JSON.stringify({models:[model('gpt-test-sol',{display_name:'Sol — rápido'})]}));
  const stream=new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close();}});
  const result=await fetchAccountModels(token,{scrub:redactor(),fetchImpl:async()=>new Response(stream)});
  assert.equal(result.models[0].displayName,'Sol — rápido');
});
test('Catalog HTTP failure is explicit and redacts the bearer',async()=>{
  await assert.rejects(fetchAccountModels(token,{scrub:redactor(),fetchImpl:async()=>new Response(JSON.stringify({detail:'Denied '+token}),{status:401})}),e=>e.code==='ACCOUNT_MODEL_CATALOG_HTTP_ERROR'&&e.details.status===401&&!JSON.stringify(e.details).includes(token));
});
test('Malformed, oversized and stalled catalogs fail before any model',async()=>{
  await assert.rejects(fetchAccountModels(token,{fetchImpl:async()=>new Response('not json')}),code('ACCOUNT_MODEL_CATALOG_INVALID_JSON'));
  await assert.rejects(fetchAccountModels(token,{fetchImpl:async()=>new Response(' '.repeat(2*1024*1024+1))}),code('ACCOUNT_MODEL_CATALOG_TOO_LARGE'));
  await assert.rejects(fetchAccountModels(token,{timeoutMs:5,fetchImpl:async(_,o)=>new Promise((_,no)=>o.signal.addEventListener('abort',()=>no(Error('aborted'))))}),code('ACCOUNT_MODEL_CATALOG_TIMEOUT'));
});
test('Empty or invalid catalog shape is rejected',()=>{
  assert.throws(()=>normalizeCatalog({other:[]}),code('ACCOUNT_MODEL_CATALOG_INVALID'));assert.throws(()=>normalizeCatalog({models:[]}),code('ACCOUNT_MODEL_CATALOG_EMPTY'));
});
test('Profile pins medium without weakening or mutating original security fields',()=>{
  const original={config:{sandbox_mode:'read-only'},toml:'sandbox_mode = "read-only"',thread:{sandbox:'read-only'}};
  const p=modelProfile({liveProfile:()=>original},{},'medium');assert.equal(p.config.model_reasoning_effort,'medium');assert(p.toml.includes('\nmodel_reasoning_effort = "medium"\n'));
  assert.equal(original.config.model_reasoning_effort,undefined);assert.equal(p.thread.sandbox,'read-only');assert.equal(p.config.sandbox_mode,'read-only');
});
test('Structured model-rejection payload produces precise failure code',()=>{
  assert.equal(classifyProviderFailure({message:JSON.stringify({detail:"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."})}).code,'MODEL_NOT_SUPPORTED_FOR_ACCOUNT');
  assert.equal(classifyProviderFailure({message:'usage limit exceeded'}).code,'MODEL_USAGE_LIMIT');
  assert.equal(classifyProviderFailure({message:'authentication failed'}).code,'MODEL_AUTH_REJECTED');
});
test('Exact observed model rejection starts zero executor or verifier VMs and stops the batch',()=>fixture(async temp=>{
  const d=fakeJar({root:ROOT,temp,modelBehavior:'model-denied'}),runs=[];
  await assert.rejects(executeConditions(schedule(config.tasks),{run:item=>runCondition(d,{repo:temp,root:ROOT,task:item.task,condition:item.condition,dir:path.join(temp,'evidence'),scrub:redactor(),config,idleOptions:{delayMs:0}}),onResult:async r=>runs.push(r)}),code('INFRA_FAIL_STOP'));
  assert.equal(runs.length,1);assert.equal(runs[0].error.code,'MODEL_NOT_SUPPORTED_FOR_ACCOUNT');assert.equal(runs[0].failureStage,'model_turn');
  assert.equal(runs[0].mainModelTurnsStarted,1);assert.equal(runs[0].executorStarted,false);assert.equal(runs[0].executorSettled,null);
  assert.equal(d.metrics.models,1);assert.equal(d.metrics.executors,0);assert.equal(d.metrics.verifiers,0);assert.equal(runs[0].toolCalls,0);
}));
test('Completed no-tool turn verifies untouched workspace: functional FAIL, not fake executor receipt',()=>fixture(async temp=>{
  const d=fakeJar({root:ROOT,temp,modelTools:[]});const r=await runCondition(d,{repo:temp,root:ROOT,task:'03-capability-exposure',condition:'CONTROL',dir:path.join(temp,'evidence'),scrub:redactor(),config,idleOptions:{delayMs:0}});
  assert.equal(r.outcome,'FAIL',JSON.stringify(r.error));assert.equal(d.metrics.executors,0);assert.equal(d.metrics.verifiers,1);assert.equal(r.executorSettled,null);
  assert(!fs.existsSync(path.join(temp,'evidence/executor-disposal.json')));
}));
test('First authorized tool launches executor once even for parallel model requests',()=>fixture(async temp=>{
  const d=fakeJar({root:ROOT,temp,modelTools:[{name:'workspace_read'},{name:'workspace_search'}]}),stages=[];
  const r=await runCondition(d,{repo:temp,root:ROOT,task:'03-capability-exposure',condition:'CONTROL',dir:path.join(temp,'evidence'),scrub:redactor(),config,idleOptions:{delayMs:0},onStage:s=>stages.push(s)});
  assert.equal(r.outcome,'PASS',JSON.stringify(r.error));assert.equal(d.metrics.executors,1);assert.equal(r.toolCalls,2);assert(stages.indexOf('model_turn')<stages.indexOf('executor_start'));assert(r.executorStartupMs>=0);
}));

// Real local HTTP loopback with synthetic app-server messages. No provider token sent.
function baselineDouble(temp,{unsafe=false,wrongEffort=false,omitControlTools=false,omitAssistTools=false}={}){
  const d=fakeJar({root:ROOT,temp}),requests=[],transports=[];let disposedWorkspaces=0;
  const originalDispose=d.disposeOwnedWorkspace;d.disposeOwnedWorkspace=async h=>{disposedWorkspaces++;return originalDispose(h);};
  d.sha256=x=>sha(typeof x==='string'?x:JSON.stringify(x));
  d.liveProfile=({workspaceRoot,codexHome,model,providerBaseUrl='https://api.openai.com/v1'})=>({workspaceRoot,codexHome,
    config:{model,model_provider:'jar_live','model_providers.jar_live.base_url':providerBaseUrl,'model_providers.jar_live.wire_api':'responses'},
    baseline:{disabledFeatures:['shell_tool','plugins']},toml:'model = '+JSON.stringify(model)+'\n',
    thread:{cwd:workspaceRoot,model,modelProvider:'jar_live',sandbox:'read-only',approvalPolicy:'never',ephemeral:true,environments:[],selectedCapabilityRoots:[]}});
  d.inspectLiveArtifacts=async()=>({runtimeIdentityAccepted:true,runtimeVersion:'0.159.2',runtimeHash:'fake-pinned-hash',runtimePath:'unused',nativeBaselineProof:{model:'gpt-5.4',id:'OLD_DO_NOT_RELABEL'}});
  d.observeProviderTools=({body,dynamicTools})=>{
    const dynamicNames=new Set(dynamicTools.map(t=>t.name));return {native:body.tools.filter(t=>!dynamicNames.has(t.name)),dynamic:body.tools.filter(t=>dynamicNames.has(t.name)),effective:body.tools,nativeBaselineHash:'same-native'};
  };
  d.assessBaselinePair=({control,assist})=>({status:unsafe?'NATIVE_BASELINE_UNSAFE':'NATIVE_BASELINE_VERIFIED',baselineEqual:control.nativeBaselineHash===assist.nativeBaselineHash,warnings:[]});
  d.validateNativeBaselineProof=(p,{model,runtimeHash})=>{if(!p)return false;const {id,...body}=p;return id==='native_baseline_proof_'+d.sha256(body)&&p.model===model&&p.runtimeHash===runtimeHash&&p.status==='NATIVE_BASELINE_VERIFIED';};
  d.createLiveTransport=({profile,environment})=>{
    let handler=()=>{},tools=[],closed=false;transports.push({environment,profile});const deliver=m=>queueMicrotask(()=>handler(m));
    return {onMessage:cb=>{handler=cb;return()=>{};},start:async()=>{},send(m){
      if(m.method==='initialize')deliver({id:m.id,result:{}});
      if(m.method==='thread/start'){tools=m.params.dynamicTools;deliver({id:m.id,result:{thread:{id:'test-thread'},cwd:profile.thread.cwd,model:profile.thread.model,modelProvider:'jar_live',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}}});}
      if(m.method==='turn/start'){
        deliver({id:m.id,result:{turn:{id:'test-turn'}}});
        const requestIndex=requests.length,toolRows=[{name:'update_plan',schemaHash:'native-schema'},...tools.map(t=>({name:t.name,schemaHash:'schema-'+t.name}))];
        const omitTools=requestIndex===0?omitControlTools:omitAssistTools;
        const body={model:profile.config.model,reasoning:{effort:wrongEffort?'high':m.params.effort},...(omitTools?{}:{tools:toolRows})};
        requests.push(body);
        fetch(profile.config['model_providers.jar_live.base_url']+'/responses',{method:'POST',headers:{Authorization:'Bearer '+environment.JAR_ACCESS_TOKEN},body:JSON.stringify(body)})
          .then(async r=>{await r.text();if(!closed)deliver({method:'turn/completed',params:{threadId:'test-thread',turn:{id:'test-turn',status:r.ok?'completed':'failed'}}});}).catch(()=>{});
      }
    },async dispose(){closed=true;return {settled:true};}};
  };
  return {d,requests,transports,get disposedWorkspaces(){return disposedWorkspaces;}};
}
test('Zero-tool control request may omit tools while assist must still project every dynamic tool',()=>fixture(async temp=>{
  const b=baselineDouble(temp,{omitControlTools:true});
  const proof=await observeModelBaseline(b.d,{repo:temp,root:ROOT,config,artifacts:await b.d.inspectLiveArtifacts(),dir:path.join(temp,'evidence'),scrub:redactor()});
  assert.equal(b.requests.length,2);assert.equal(b.requests[0].tools,undefined);assert.equal(b.requests[1].tools.length,6);
  assert.deepEqual(proof.control.native,[]);assert.equal(proof.assist.dynamic.length,5);assert.equal(b.disposedWorkspaces,1);
}));
test('Missing tools on assist request fails closed instead of normalizing away expected JAR tools',()=>fixture(async temp=>{
  const b=baselineDouble(temp,{omitAssistTools:true});
  await assert.rejects(observeModelBaseline(b.d,{repo:temp,root:ROOT,config,artifacts:await b.d.inspectLiveArtifacts(),dir:path.join(temp,'evidence'),scrub:redactor()}),code('BASELINE_DYNAMIC_TOOLS_MISSING'));
  assert.equal(b.disposedWorkspaces,1);
}));
test('New model baseline is genuinely captured twice on loopback; old model proof not relabelled',()=>fixture(async temp=>{
  const b=baselineDouble(temp),scrub=redactor();scrub.add(token);
  const proof=await observeModelBaseline(b.d,{repo:temp,root:ROOT,config,artifacts:await b.d.inspectLiveArtifacts(),dir:path.join(temp,'evidence'),scrub});
  assert.equal(proof.model,config.model);assert.equal(proof.reasoningEffort,'medium');assert.notEqual(proof.id,'OLD_DO_NOT_RELABEL');
  assert.equal(b.requests.length,2);assert.equal(b.requests[0].tools.length,1);assert.equal(b.requests[1].tools.length,6);assert.equal(b.disposedWorkspaces,1);
  assert.equal(proof.security.inferenceCalls,0);assert.equal(proof.runtimeActivity.windowsSandboxLaunches,0);
  assert(b.transports.every(t=>t.environment.JAR_ACCESS_TOKEN==='jar-owned-loopback-fixture-not-a-credential'));
  for(const file of filesUnder(path.join(temp,'evidence')))assert(!fs.readFileSync(path.join(temp,'evidence',file),'utf8').includes(token));
}));
test('Unsafe native baseline and effort projection mismatch both fail closed with cleanup',()=>fixture(async temp=>{
  const a=baselineDouble(path.join(temp,'a'),{unsafe:true});
  await assert.rejects(observeModelBaseline(a.d,{repo:temp,root:ROOT,config,artifacts:await a.d.inspectLiveArtifacts(),dir:path.join(temp,'evidence-a'),scrub:redactor()}),code('NATIVE_BASELINE_UNSAFE'));assert.equal(a.disposedWorkspaces,1);
  const b=baselineDouble(path.join(temp,'b'),{wrongEffort:true});
  await assert.rejects(observeModelBaseline(b.d,{repo:temp,root:ROOT,config,artifacts:await b.d.inspectLiveArtifacts(),dir:path.join(temp,'evidence-b'),scrub:redactor()}),code('BASELINE_EFFORT_MISMATCH'));assert.equal(b.disposedWorkspaces,1);
}));
test('Resolved model proof is cached with runtime, source, model, effort; no model or VM preflight',()=>fixture(async temp=>{
  const root=path.join(temp,'benchmark');fs.mkdirSync(root);fs.cpSync(path.join(ROOT,'tasks'),path.join(root,'tasks'),{recursive:true});
  const b=baselineDouble(temp),logs=[];const opts={repo:temp,root,config:{...config,model:'auto'},runDir:path.join(temp,'result1'),repoHash:'same-source',scrub:redactor(),log:l=>logs.push(l),fetchImpl:async()=>response({models:[model('gpt-test-sol')]}),readRuntimeMetadata:()=>({models:[{slug:'gpt-test-sol',model_messages:{instructions_template:'test'}}]})};
  const first=await prepareModelAccess(b.d,opts);assert.equal(first.config.model,'gpt-test-sol');assert.equal(first.selection.extraRealInferenceCalls,0);assert.equal(b.requests.length,2);
  const second=await prepareModelAccess(b.d,{...opts,runDir:path.join(temp,'result2')});assert.equal(b.requests.length,2);assert.equal(second.selection.reason,'existing_manual_pin');
  assert.equal(second.config.modelBaselineProof.id,first.config.modelBaselineProof.id);assert(!JSON.stringify(first.config).includes('modelBaselineProof'));
  assert.equal(b.d.metrics.models,0);assert.equal(b.d.metrics.executors,0);assert.equal(b.d.metrics.verifiers,0);
  assert(logs.some(x=>x.startsWith('Reusing a verified')));
}));
test('Direct tool compatibility preserves model instructions and identity while disabling native shell and patch',()=>{
  const original={slug:'gpt-test-sol',tool_mode:'code_mode_only',use_responses_lite:true,apply_patch_tool_type:'freeform',shell_type:'unified_exec',model_messages:{instructions_template:'Original instructions'}};
  const result=directToolCatalog({models:[original]},original.slug).models[0];
  assert.equal(result.tool_mode,'direct');assert.equal(result.use_responses_lite,false);assert.equal(result.apply_patch_tool_type,null);assert.equal(result.shell_type,'disabled');
  assert.deepEqual(result.model_messages,original.model_messages);assert.equal(original.tool_mode,'code_mode_only');
  assert.throws(()=>directToolCatalog({models:[original]},'other'),code('RUNTIME_MODEL_METADATA_MISSING'));
});
