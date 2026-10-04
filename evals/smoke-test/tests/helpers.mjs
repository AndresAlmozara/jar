import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {json,atomic,treeHash,sha,command,parseJson} from '../lib/common.mjs';
export const temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'jar smoke test '));
export function mockTransport({thread,behavior='complete',tools=[],cleanup=true}={}) {
  let handler=()=>{},closed=0,active=0,responses=0;const sent=[];
  const deliver=m=>queueMicrotask(()=>handler(m));
  const finish=()=>{
    deliver({method:'thread/tokenUsage/updated',params:{threadId:'thread-test',tokenUsage:{total:{inputTokens:20,outputTokens:10,totalTokens:30}}}});
    deliver({method:'item/completed',params:{threadId:'thread-test',item:{type:'agentMessage',text:'Done.'}}});
    deliver({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}}});
  };
  return {sent,get closed(){return closed;},onMessage(cb){handler=cb;return ()=>{handler=()=>{};};},async start(){if(behavior==='start-fail')throw Error('start failed');},
    send(m){sent.push(m);
      if(m.method==='initialize')deliver({id:m.id,result:{}});
      else if(m.method==='thread/start'){
        if(behavior==='rpc-fail')deliver({id:m.id,error:{code:123,message:'Unauthorized test error'}});
        else deliver({id:m.id,result:{thread:{id:'thread-test'},cwd:thread.cwd,model:thread.model,modelProvider:thread.modelProvider,
          approvalPolicy:behavior==='mismatch'?'always':'never',sandbox:{type:'readOnly',networkAccess:false},reasoningEffort:'medium'}});
      }else if(m.method==='turn/start'){
        deliver({id:m.id,result:{turn:{id:'turn-test'}}});
        if(behavior==='stall')return;
        if(behavior==='model-denied'){deliver({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',items:[],status:'failed',error:{message:JSON.stringify({detail:"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."})}}}});return;}
        if(behavior==='failed-turn'){deliver({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'failed',error:{message:'provider denied'}}}});return;}
        if(behavior==='approval'){deliver({id:199,method:'item/commandExecution/requestApproval',params:{threadId:'thread-test'}});return;}
        if(tools.length){for(const [i,t] of tools.entries())deliver({id:200+i,method:'item/tool/call',params:{threadId:'thread-test',tool:t.name,arguments:t.arguments??{}}});}
        else finish();
      }else if(m.id>=200&&(m.result||m.error)){responses++;if(responses===tools.length)finish();}
    },async dispose(){closed++;return {settled:cleanup};}};
}
// Deterministic test doubles. They do NOT constitute Windows Sandbox / live-provider validation.
export function fakeJar({root,temp,result='PASS',modelBehavior='complete',modelTools=[{name:'workspace_read'}],verifierThrow=false,missingDetails=false,unsettled=false,postIdleFail=false}={}) {
  const states=new WeakMap();let sequence=0,idleCalls=0,launched=false;const metrics={models:0,verifiers:0,executors:0};
  const d={metrics,
    workspaceManifest(raw){if(!raw.surfaces.includes('capabilities'))throw Error('SURFACES_INVALID');return raw;},
    async prepareOwnedWorkspace(manifest,{manifestDirectory,runsRoot}){
      const runRoot=path.join(temp,'owned-'+(++sequence)),workspaceRoot=path.join(runRoot,'workspace');fs.mkdirSync(workspaceRoot,{recursive:true});
      fs.cpSync(path.join(manifestDirectory,manifest.sourceRoot),workspaceRoot,{recursive:true});
      const handle={id:'run-'+sequence,runRoot,workspaceRoot,manifestHash:sha(JSON.stringify(manifest)),taskHash:sha(manifest.task),startStateHash:treeHash(workspaceRoot),files:manifest.include.map(p=>({path:p,hash:sha(fs.readFileSync(path.join(workspaceRoot,p)))}))};states.set(handle,{manifest,manifestDirectory});return handle;
    },
    async disposeOwnedWorkspace(handle){fs.rmSync(handle.runRoot,{recursive:true,force:true});},
    ownedToolMapping(handle){return ['workspace_write','workspace_list','workspace_run','workspace_read','workspace_search'].map(name=>({capability:{id:'id-'+name},native:{name,description:name,inputSchema:{type:'object',properties:{}}}}));},
    async prepareOwnedInputs(handle,{mode,client,telemetry}){
      const ids=d.ownedToolMapping(handle).map(r=>r.capability.id),s=states.get(handle);
      const surfaces={capabilities:{status:'proposed',strategy:mode==='ASSIST'?'capability/jev-hierarchical-cover-v1':'capability/all-visible-v1',provider:mode==='ASSIST'?'jev-live':'none',candidates:ids,requested:ids},skills:{status:'disabled'},context:{status:'disabled'},output:{status:'disabled'}};
      if(mode==='ASSIST'){
        const response=await client.systemOne({state:{task:s.manifest.task},questions:{decision:{type:'noul',instructions:'Relevant?',criteria:'Useful'}}});
        telemetry.append({success:true,provider_model:response.model,input_tokens:3,output_tokens:2});
        if(s.manifest.surfaces.includes('skills'))surfaces.skills={status:'prepared',items:[{id:'tdd-workflow'}]};
        if(s.manifest.surfaces.includes('context'))surfaces.context={status:'prepared',items:[]};
        if(s.manifest.surfaces.includes('output-shadow'))surfaces.output={status:'prepared-shadow-only',delivery:'exact_passthrough'};
      }
      return {request:{exposedIds:ids},inputs:[{channel:'task',text:s.manifest.task}],surfaces};
    },
    TypeSafeClient:class {
      constructor(){this.model='fake-jev';}
      async systemOne({questions}){for(const q of Object.values(questions))if(typeof q.criteria!=='object')throw Object.assign(Error('422 invalid criteria'),{status:422});
        return {model:'fake-jev',answers:{decision:{type:'noul',noul:0.8}},usage:{input_tokens:3,output_tokens:2}};}
    },
    ChatGptAuthService:class {async status(){return {authenticated:true,planPermission:true,tokenState:'valid'};}async usableAccessToken(){return 'FAKE_PRIVATE_TOKEN_NEVER_LOG';}},
    runtimeAuthFromStatus:s=>s,jevEnvironmentAuth:()=>({credentialPresent:true}),
    async inspectLiveArtifacts(){return {runtimeVersion:'0.159.2',runtimeHash:'fake-hash',runtimePath:'unused'};},
    v1Readiness:()=>({status:'READY_FOR_HUMAN_AUTHORIZED_LIVE_RUN',baselineId:'fake-baseline'}),
    liveProfile({workspaceRoot,codexHome,model}){return {workspaceRoot,codexHome,config:{model},toml:'model = "fake"',thread:{cwd:workspaceRoot,model,modelProvider:'jar_live',approvalPolicy:'never',sandbox:'read-only'}};},
    async assertWindowsSandboxIdle(options){
      if(options){const p=await options.inventoryProvider(),s=await options.sessionProvider();if(s.length||p.some(x=>x.name!=='WindowsSandboxServer.exe'))throw Error('BUSY');return {};}
      idleCalls++;if(postIdleFail&&launched&&idleCalls>2)throw Error('BUSY');return {sandboxProcessCount:0,sandboxSessionCount:0};
    },
    async stageSandboxExecutor(handle){const stage={handle,root:path.join(handle.runRoot,'executor')};fs.mkdirSync(path.join(stage.root,'output'),{recursive:true});return stage;},
    async launchSandboxExecutor(stage){metrics.executors++;launched=true;return {toolExecutionNetwork:'disabled_by_windows_sandbox',async dispose(){
      const final=path.join(stage.root,'output/workspace');fs.cpSync(stage.handle.workspaceRoot,final,{recursive:true});
      if(result==='PASS')fs.cpSync(path.join(states.get(stage.handle).manifestDirectory,'canonical'),final,{recursive:true});
      return {workspaceRoot:final,settled:!unsettled,sandboxSessionSettled:!unsettled,ownedSandboxSessionProcessesRemaining:0};}};},
    createSandboxToolCallback:()=>async()=>({success:true}),
    async stageSandboxVerifier(handle,{finalWorkspaceRoot,verifierRoot}){
      const base=path.join(handle.runRoot,'verifier-guest'),input=path.join(base,'input'),output=path.join(base,'output');fs.mkdirSync(output,{recursive:true});
      fs.cpSync(finalWorkspaceRoot,path.join(input,'workspace'),{recursive:true});fs.cpSync(verifierRoot,path.join(input,'verifier'),{recursive:true});
      atomic(path.join(input,'plan.json'),{runId:handle.id});return {input,output};
    },
    async runSandboxVerifier(stage){metrics.verifiers++;if(verifierThrow)throw Object.assign(Error('Verifier boot failed'),{code:'VERIFIER_BOOTSTRAP_NOT_OBSERVED'});
      const r=await command([process.execPath,path.join(stage.input,'verifier/verify.mjs'),path.join(stage.input,'workspace')],{timeoutMs:12000});
      const details=parseJson(r.stdout);if(details)atomic(path.join(stage.output,'diagnostic-details.json'),{...details,runId:json(path.join(stage.input,'plan.json')).runId});
      if(missingDetails)fs.rmSync(path.join(stage.output,'diagnostic-details.json'),{force:true});
      return {status:r.returncode===0?'passed':'failed',exitCode:r.returncode,settled:true,sandboxSessionSettled:true,ownedSandboxSessionProcessesRemaining:0};
    },
    createLiveTransport({profile}){metrics.models++;return mockTransport({thread:profile.thread,behavior:modelBehavior,tools:modelTools});}
  };return d;
}
