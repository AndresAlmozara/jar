import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {atomic,json,sha,filesUnder,treeHash,DiagnosticError,fail,errorInfo,journal,sleep,equalSet} from './common.mjs';
import {compatibleClient} from './typesafe-compat.mjs';
import {runModelTurn} from './model-session.mjs';
import {authenticatedToken,modelProfile} from './model-access.mjs';
import {createToolObserver,toolTimingMetrics,summarizeJevUsage,routingMetrics,fileChanges} from './diagnostics.mjs';

export async function loadJar(repo) {
  const get=rel=>import(pathToFileURL(path.join(repo,rel)).href);
  const modules=await Promise.all([
    get('packages/runtime-adapters/codex/src/owned-workspace.js'),
    get('packages/runtime-adapters/codex/src/owned-preparation.js'),
    get('packages/runtime-adapters/codex/src/owned-tools.js'),
    get('packages/runtime-adapters/codex/src/sandbox-rpc.js'),
    get('packages/runtime-adapters/codex/src/sandbox-executor.js'),
    get('packages/runtime-adapters/codex/src/sandbox-session.js'),
    get('packages/runtime-adapters/codex/src/live-profile.js'),
    get('packages/runtime-adapters/codex/src/owned-runtime-store.js'),
    get('packages/runtime-adapters/codex/src/live-transport.js'),
    get('packages/auth/chatgpt/src/index.js'),
    get('packages/decision-providers/jev/src/typesafe-client.js'),
    get('bin/codex-live-v1.js'),
    get('packages/runtime-adapters/codex/src/native-baseline-observation.js'),
    get('packages/core/src/hash.js')]);
  const d=Object.assign({},...modules);
  const needed=['workspaceManifest','prepareOwnedWorkspace','prepareOwnedInputs','disposeOwnedWorkspace','ownedToolMapping',
    'createSandboxToolCallback','stageSandboxExecutor','launchSandboxExecutor','stageSandboxVerifier','runSandboxVerifier',
    'assertWindowsSandboxIdle','queryWindowsSandboxProcesses','queryWindowsSandboxSessions','liveProfile','createLiveTransport',
    'ChatGptAuthService','runtimeAuthFromStatus','TypeSafeClient','inspectLiveArtifacts','v1Readiness','jevEnvironmentAuth','resolvePinnedOwnedRuntime',
    'observeProviderTools','assessBaselinePair','validateNativeBaselineProof','sha256'];
  for(const name of needed)if(typeof d[name]!=='function')fail('JAR_EXPORT_MISSING',{name});
  return d;
}
export async function idleGate(d,emit,{delayMs=750,checks=2}={}) {
  let result;
  for(let n=0;n<checks;n++){
    result=await d.assertWindowsSandboxIdle();emit('sandbox_idle',{...result,check:n+1});
    if(n+1<checks)await sleep(delayMs);
  }return result;
}
export async function checkLifecycleContract(d) {
  const infrastructure={pid:314159,parentPid:0,name:'WindowsSandboxServer.exe',creationTime:new Date().toISOString(),commandLine:''};
  await d.assertWindowsSandboxIdle({inventoryProvider:async()=>[infrastructure],sessionProvider:async()=>[]});
  let blocked=false;
  try{await d.assertWindowsSandboxIdle({inventoryProvider:async()=>[],sessionProvider:async()=>[{id:'00000000-0000-0000-0000-000000000001',status:'running'}]});}
  catch{blocked=true;}if(!blocked)fail('SANDBOX_ACTIVE_SESSION_NOT_REJECTED');
}
export function verifyFixture(root,task,d) {
  const base=path.join(root,'tasks',task),manifestPath=path.join(base,'manifest.json'),raw=json(manifestPath);
  const manifest=d.workspaceManifest(raw);
  if(manifest.id!==task||manifest.sourceRoot!=='workspace'||manifest.capabilityProfile!=='smoke-expanded'||manifest.verifier?.root!=='verifier'||manifest.verifier?.entrypoint!=='verify.mjs')fail('FIXTURE_LAYOUT_INVALID',{task});
  const files=filesUnder(path.join(base,'workspace'));
  if(!equalSet(files,manifest.include))fail('MANIFEST_INCLUDE_MISMATCH',{task});
  const prompt=fs.readFileSync(path.join(base,'task.md'),'utf8').trim();
  if(prompt!==manifest.task.trim())fail('PROMPT_MANIFEST_MISMATCH',{task});
  if(!manifest.surfaces.includes('capabilities'))fail('CAPABILITIES_SURFACE_REQUIRED',{task});
  for(const f of files)if(fs.statSync(path.join(base,'workspace',f)).size>manifest.limits.maxFileBytes)fail('FIXTURE_FILE_TOO_LARGE',{task,f});
  for(const f of filesUnder(path.join(base,'canonical'))){
    if(!files.includes(f)||manifest.immutable.includes(f))fail('CANONICAL_EDIT_NOT_PERMITTED',{task,f});}
  return {base,manifestPath,manifest};
}
export async function readiness(d,repo,config,scrub) {
  const {accessToken,auth}=await authenticatedToken(d,scrub);
  const artifacts=await d.inspectLiveArtifacts();
  if(config.modelBaselineProof)artifacts.nativeBaselineProof=config.modelBaselineProof;
  const profile=modelProfile(d,{workspaceRoot:path.join(repo,'.jar','smoke-readiness-workspace'),codexHome:path.join(repo,'.jar','smoke-readiness-home'),model:config.model,envKey:'JAR_ACCESS_TOKEN'},config.effort);
  const ready=d.v1Readiness({artifacts,auth,profile,mode:'ASSIST',strategy:'jev-live',jevAuth:d.jevEnvironmentAuth(process.env)});
  if(ready.status!=='READY_FOR_HUMAN_AUTHORIZED_LIVE_RUN')fail('LIVE_READINESS_BLOCKED',{readiness:ready});
  return {artifacts,auth,ready,accessToken};
}
function serialMapping(mapping) {
  const rows=mapping.map(row=>({capabilityId:row.capability.id,toolName:row.native.name,native:row.native}));
  if(new Set(rows.map(r=>r.capabilityId)).size!==rows.length||new Set(rows.map(r=>r.toolName)).size!==rows.length)fail('CAPABILITY_MAPPING_NOT_BIJECTIVE');
  return rows;
}
export function assertConditionContract({condition,manifest,preparation,mapping,decisionEvents}){
  const s=preparation.surfaces,control=condition==='CONTROL',ids=preparation.request.exposedIds;
  const strategy=control?'capability/all-visible-v1':'capability/jev-hierarchical-cover-v1';
  if(s.capabilities.strategy!==strategy||s.capabilities.provider!==(control?'none':'jev-live')
    ||!equalSet(s.capabilities.requested,ids)||!equalSet(s.capabilities.candidates,mapping.map(r=>r.capabilityId)))fail('CONDITION_CONTRACT_MISMATCH');
  if(control?decisionEvents.length!==0:!decisionEvents.some(e=>e.success===true))fail('CONDITION_JEV_CONTRACT_MISMATCH');
  for(const name of ['skills','context']){
    const enabled=!control&&manifest.surfaces.includes(name);
    if(enabled?!['prepared','selected','no_decision'].includes(s[name].status):s[name].status!=='disabled')fail('CONDITION_SURFACE_CONTRACT_MISMATCH',{name});
  }
  const shadow=!control&&manifest.surfaces.includes('output-shadow');
  if(shadow?(s.output.status!=='prepared-shadow-only'||s.output.delivery!=='exact_passthrough'):s.output.status!=='disabled')fail('CONDITION_OUTPUT_CONTRACT_MISMATCH');
  return {verified:true,condition,mode:control?'CONTROL':'ASSIST',strategy,provider:s.capabilities.provider,
    jevDecisionCalls:decisionEvents.length,selectedCapabilityIds:ids,withheldCapabilityIds:mapping.map(r=>r.capabilityId).filter(id=>!ids.includes(id)),
    selectedToolNames:mapping.filter(r=>ids.includes(r.capabilityId)).map(r=>r.toolName),surfaces:s};
}
async function prepare(d,{repo,root,task,condition,dir,scrub,liveDecisions=true,emit}) {
  const {base,manifestPath,manifest}=verifyFixture(root,task,d);
  const handle=await d.prepareOwnedWorkspace(manifest,{manifestDirectory:base,runsRoot:path.join(repo,'.jar/live-runs')});
  const mapping=d.ownedToolMapping(handle),serial=serialMapping(mapping),decisionEvents=[];
  const c=compatibleClient(d.TypeSafeClient,{emit,scrub});
  try{
    const skillRoot=path.join(base,'skills-catalog'),reviewedSkillIds=fs.existsSync(path.join(skillRoot,'skills'))?fs.readdirSync(path.join(skillRoot,'skills')).sort():['backend-patterns','tdd-workflow'];
    const preparation=await d.prepareOwnedInputs(handle,{mode:condition==='JAR'?'ASSIST':'CONTROL',reviewedCatalogRoot:skillRoot,
      reviewedSkillIds,
      capabilityProvider:condition==='JAR'?'jev-live':'deterministic',prepareOnly:!liveDecisions,
      client:c.client,telemetry:{append:event=>{decisionEvents.push(event);emit('jar_decision',event);}}});
    if(!preparation.request||!Array.isArray(preparation.request.exposedIds))fail('LIVE_SELECTION_NOT_PREPARED');
    const ids=preparation.request.exposedIds;
    if(ids.some(id=>!serial.some(row=>row.capabilityId===id)))fail('CAPABILITY_MAPPING_INCOMPLETE');
    if(condition==='CONTROL'&&!equalSet(ids,serial.map(r=>r.capabilityId)))fail('CONTROL_NOT_ALL_VISIBLE');
    if(condition==='CONTROL'&&(preparation.inputs.length!==1||decisionEvents.length))fail('CONTROL_CONTAMINATED');
    if(condition==='JAR'&&decisionEvents.some(e=>e.success===false))fail('JEV_DECISION_FAILED',{events:decisionEvents.filter(e=>e.success===false),http:c.observed});
    const contract=assertConditionContract({condition,manifest,preparation,mapping:serial,decisionEvents});
    atomic(path.join(dir,'condition-contract.json'),scrub.clean(contract));
    const plan={schemaVersion:'jar.smoke-benchmark.plan.v1',task,condition,runId:handle.id,manifestHash:handle.manifestHash,
      contract,
      taskHash:handle.taskHash,startStateHash:handle.startStateHash,files:handle.files,
      workspaceRoot:handle.workspaceRoot,runRoot:handle.runRoot,surfaces:preparation.surfaces,
      capabilityMapping:serial,selectedCapabilityIds:ids,selectedToolNames:serial.filter(r=>ids.includes(r.capabilityId)).map(r=>r.toolName),
      modelInputHashes:preparation.inputs.map(i=>({channel:i.channel,sha256:sha(i.text),bytes:Buffer.byteLength(i.text)})),
      compatibilityAdapter:'noul-string-criteria-to-true-object-v1'};
    atomic(path.join(dir,'plan.json'),scrub.clean(plan));
    return {base,manifestPath,manifest,handle,mapping,preparation,plan,decisionEvents};
  }catch(e){
    emit('preparation_failure',{error:errorInfo(e,scrub),decisions:decisionEvents,http:c.observed,runRoot:handle.runRoot});
    await d.disposeOwnedWorkspace(handle);throw new DiagnosticError(e.code??e.message??'PREPARATION_FAILED',
      {cause:errorInfo(e,scrub),providerErrors:decisionEvents.filter(e=>e.success===false),http:c.observed});
  }
}
export async function preflightFixture(d,args) {
  const j=journal(args.dir,args.scrub),p=await prepare(d,{...args,condition:'JAR',liveDecisions:true,emit:j.emit});
  try{
    // Exercise the real staging contracts without starting either VM or the main model.
    await d.stageSandboxExecutor(p.handle,{mapping:p.mapping,selectedIds:p.plan.selectedCapabilityIds,repositoryRoot:args.repo});
    await d.stageSandboxVerifier(p.handle,{finalWorkspaceRoot:p.handle.workspaceRoot,verifierRoot:path.join(p.base,p.manifest.verifier.root),entrypoint:p.manifest.verifier.entrypoint,repositoryRoot:args.repo});
    const expected=p.plan.capabilityMapping.map(r=>r.capabilityId),actual=p.plan.selectedCapabilityIds;
    const result={task:args.task,status:'READY',mainModelTurns:0,liveJevDecisionCalls:p.decisionEvents.length,
      mapping:p.plan.capabilityMapping,selectedTools:p.plan.selectedToolNames,
      capabilityConfounding:!equalSet(expected,actual),surfaces:p.plan.surfaces,
      providerModels:[...new Set(p.decisionEvents.filter(e=>e.success).map(e=>e.provider_model))]};
    j.write('preflight.json',result);return result;
  }finally{await d.disposeOwnedWorkspace(p.handle);}
}
function copyEvidence(source,target) {
  if(!fs.existsSync(source))return;
  const stat=fs.lstatSync(source);if(stat.isSymbolicLink())fail('EVIDENCE_SYMLINK_REJECTED',{source});
  if(stat.isDirectory()){
    fs.mkdirSync(target,{recursive:true});for(const e of fs.readdirSync(source))copyEvidence(path.join(source,e),path.join(target,e));
  }else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
}
export async function runCondition(d,args) {
  const {repo,root,task,condition,dir,scrub,config,isCancelled=()=>false,onStage=()=>{}}=args;
  const j=journal(dir,scrub);let phase='pre_run_idle',p=null,executor=null,disposed=false,disposeAttempted=false,verifier=null,session=null;
  let outcome='INFRA_FAIL',error=null,disposal=null,postIdle=null;const start=performance.now();
  const toolObserver=createToolObserver({emit:j.emit,clock:()=>performance.now()-start,sanitizeError:e=>errorInfo(e,scrub)}),toolEvents=toolObserver.events;
  const stage=name=>{phase=name;j.emit('stage',{stage:name});onStage(name);};
  const row={schemaVersion:'jar.smoke-benchmark.condition.v1',task_id:task,condition,outcome:'INFRA_FAIL',
    mainModel:config.model,effortRequested:config.effort,mainModelTurnsStarted:0,mainModelUsage:null,jevUsage:null,executorStarted:false,
    timeToFirstPersistentEditMs:null,ttpeExplanation:'Exact persistent-edit time not observable; first successful write recorded separately.'};
  try{
    await idleGate(d,j.emit,args.idleOptions??{});if(isCancelled())fail('USER_INTERRUPTED');
    stage('readiness_and_oauth');const live=await readiness(d,repo,config,scrub);
    stage('jar_preparation');p=await prepare(d,{repo,root,task,condition,dir,scrub,emit:j.emit});
    row.plan=p.plan;row.runRoot=p.handle.runRoot;row.baselineId=live.ready.baselineId;row.runtimeVersion=live.artifacts.runtimeVersion;row.runtimeHash=live.artifacts.runtimeHash;
    const profile=modelProfile(d,{workspaceRoot:p.handle.workspaceRoot,codexHome:path.join(p.handle.runRoot,'codex-home'),model:config.model,envKey:'JAR_ACCESS_TOKEN'},config.effort);
    fs.mkdirSync(profile.codexHome);fs.writeFileSync(path.join(profile.codexHome,'config.toml'),profile.toml,{flag:'wx'});
    j.write('profile.json',{config:profile.config,thread:profile.thread,baselineId:live.ready.baselineId});
    if(isCancelled())fail('USER_INTERRUPTED');
    stage('executor_stage');const es=await d.stageSandboxExecutor(p.handle,{mapping:p.mapping,selectedIds:p.plan.selectedCapabilityIds,repositoryRoot:repo});
    // No VM is launched until the model emits its first authorized dynamic-tool call.
    let originalTool=null;
    const executeTool=async(name,arguments_)=>{
      try{
        return await toolObserver.run(name,arguments_,async()=>{
          if(!executor){
            if(isCancelled())fail('USER_INTERRUPTED');
            stage('executor_start');const vmStart=performance.now();executor=await d.launchSandboxExecutor(es);row.executorStarted=true;
            row.executorStartupMs=performance.now()-vmStart;
            originalTool=d.createSandboxToolCallback({runId:p.handle.id,mapping:p.mapping,selectedIds:p.plan.selectedCapabilityIds,client:executor});
            stage('model_turn');
          }
          if(isCancelled())fail('USER_INTERRUPTED');
          return originalTool(name,arguments_);
        });
      }
      catch(e){row.failureStage??=phase;throw e;}
    };
    const spawnObserved=(file,argv,options)=>{
      // No environment values are journalled. Capture stderr previously discarded by JAR.
      const child=spawn(file,argv,options);
      let stderrText='',stderrTruncated=false;
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data',text=>{stderrText+=text;if(stderrText.length>1048576){stderrText=stderrText.slice(0,1048576);stderrTruncated=true;}});
      child.once('close',()=>{if(stderrTruncated)stderrText=stderrText.slice(0,Math.max(0,stderrText.lastIndexOf('\n')));
        if(stderrText||stderrTruncated)j.emit('app_server_stderr',{text:scrub.text(stderrText),truncated:stderrTruncated});});
      child.once('spawn',()=>j.emit('owned_process_started',{pid:child.pid,executable:path.basename(file)}));
      child.once('close',(code,signal)=>j.emit('owned_process_closed',{pid:child.pid,exitCode:code,signal}));return child;
    };
    const transport=d.createLiveTransport({runtimePath:live.artifacts.runtimePath,profile,envKey:'JAR_ACCESS_TOKEN',accessToken:live.accessToken,environment:process.env,spawnProcess:spawnObserved});
    const wrappedTransport={...transport,send(message){
      if(message.method==='turn/start')row.mainModelTurnsStarted++;
      j.emit('app_server_send',{message});return transport.send(message);
    }};
    stage('model_turn');session=await runModelTurn({transport:wrappedTransport,thread:profile.thread,inputs:p.preparation.inputs,
      dynamicTools:p.mapping.filter(r=>p.plan.selectedCapabilityIds.includes(r.capability.id)).map(r=>r.native),
      executeTool,emit:j.emit,scrub,isCancelled,reasoningEffort:config.effort,timeoutMs:config.timeouts.model_ms,rpcTimeoutMs:config.timeouts.rpc_ms,toolTimeoutMs:config.timeouts.tool_ms});
    j.write('model-session.json',session);row.modelSession=session;row.mainModelUsage=session.usage;
    if(session.status!=='completed')row.failureStage??='model_turn';
    if(executor){
      stage('executor_export_and_settle');disposeAttempted=true;disposal=await executor.dispose();disposed=true;j.write('executor-disposal.json',disposal);
      if(disposal.settled!==true||disposal.sandboxSessionSettled!==true||disposal.ownedSandboxSessionProcessesRemaining!==0)fail('EXECUTOR_NOT_SETTLED');
    }else{
      // A completed no-tool turn is tested against the untouched starting workspace.
      // This is not a synthetic executor-disposal receipt.
      disposal={workspaceRoot:p.handle.workspaceRoot,notStarted:true,settled:null};
      j.write('executor-not-started.json',{reason:'no_authorized_dynamic_tool_call',modelStatus:session.status});
    }
    await idleGate(d,j.emit,args.idleOptions??{});
    if(session.status!=='completed')fail(session.failure?.code??'MODEL_SESSION_FAILED',{failure:session.failure});
    if(isCancelled())fail('USER_INTERRUPTED');
    stage('verifier_stage');const vs=await d.stageSandboxVerifier(p.handle,{finalWorkspaceRoot:disposal.workspaceRoot,
      verifierRoot:path.resolve(p.base,p.manifest.verifier.root),entrypoint:p.manifest.verifier.entrypoint,repositoryRoot:repo});
    stage('fresh_verifier');verifier=await d.runSandboxVerifier(vs);j.write('verifier-receipt.json',verifier);
    if(verifier.settled!==true||verifier.sandboxSessionSettled!==true||verifier.ownedSandboxSessionProcessesRemaining!==0)fail('VERIFIER_NOT_SETTLED');
    const detailPath=path.join(vs.output,'diagnostic-details.json');
    if(!fs.existsSync(detailPath))fail('VERIFIER_DETAIL_MISSING',{exitCode:verifier.exitCode,status:verifier.status});
    const details=json(detailPath);j.write('verifier-details.json',details);row.verifierDetails=details;
    if(details.runId!==p.handle.id)fail('VERIFIER_DETAIL_RUN_MISMATCH');
    if(details.kind==='infrastructure')fail('VERIFIER_INFRASTRUCTURE_FAILURE',{details});
    if(typeof details.pass!=='boolean'||!['passed','failed'].includes(verifier.status)||!Number.isInteger(verifier.exitCode))fail('VERIFIER_STATUS_INVALID');
    if((verifier.status==='passed')!==(verifier.exitCode===0)||details.pass!==(verifier.exitCode===0))fail('VERIFIER_RECEIPT_CONTRADICTION');
    outcome=details.pass?'PASS':'FAIL';
  }catch(e){row.failureStage??=phase;error=errorInfo(e,scrub);j.emit('condition_failure',{stage:row.failureStage??phase,error});outcome='INFRA_FAIL';}
  finally{
    if(executor&&!disposed&&!disposeAttempted){
      stage('failure_cleanup');disposeAttempted=true;
      try{disposal=await executor.dispose();disposed=true;j.write('executor-disposal.json',disposal);}
      catch(e){error={code:'CLEANUP_FAILED',original:error,cleanup:errorInfo(e,scrub)};outcome='INFRA_FAIL';}
    }
    try{stage('post_run_idle');postIdle=await idleGate(d,j.emit,args.idleOptions??{});}
    catch(e){error={code:'SANDBOX_POST_RUN_NOT_IDLE',original:error,cleanup:errorInfo(e,scrub)};outcome='INFRA_FAIL';}
    if(p){
      try{
        copyEvidence(path.join(p.handle.runRoot,'executor/bridge'),path.join(dir,'sandbox-tool-rpc'));
        copyEvidence(path.join(p.handle.runRoot,'executor/output'),path.join(dir,'executor-output'));
        copyEvidence(path.join(p.handle.runRoot,'verifier-guest/output'),path.join(dir,'verifier-output'));
        copyEvidence(path.join(p.handle.runRoot,'executor/input/plan.json'),path.join(dir,'executor-plan.json'));
        copyEvidence(path.join(p.handle.runRoot,'verifier-guest/input/plan.json'),path.join(dir,'verifier-plan.json'));
      }catch(e){error={code:'EVIDENCE_COPY_FAILED',original:error,cause:errorInfo(e,scrub)};outcome='INFRA_FAIL';}
      row.jevUsage=summarizeJevUsage(p.decisionEvents);
    }
  }
  Object.assign(row,{outcome,error,wallClockMs:performance.now()-start,executorSettled:disposal?.settled??null,
    verifier,postIdle,toolEvents,...toolTimingMetrics(toolEvents),toolCalls:session||toolEvents.length?toolEvents.length:null,
    finalWorkspace:disposal?.workspaceRoot??null});
  if(p){
    try{row.routing=condition==='JAR'?routingMetrics(json(path.join(p.base,'ground-truth.json')),p.plan,toolEvents):null;
      row.fileChanges=disposal?.workspaceRoot?fileChanges(path.join(p.base,'workspace'),disposal.workspaceRoot):null;
      row.toolCounts=Object.fromEntries(p.plan.capabilityMapping.map(r=>[r.toolName,toolEvents.filter(e=>e.name===r.toolName).length]));
    }catch(e){row.telemetryWarnings=[errorInfo(e,scrub)];}
  }
  j.write('receipt.json',row);return row;
}
