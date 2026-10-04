import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, lstat, access, copyFile, readdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { actualExposure, runtimeIdentity } from '../packages/runtime-adapters/src/contracts.js';
import { capabilityDescriptor } from '../packages/capability-exposure/src/contracts.js';
import { CODEX_EFFECT_SCOPE, CODEX_EFFECT_VERSION } from '../packages/runtime-adapters/codex/src/isolated-effect.js';
import { sha256 } from '../packages/core/src/hash.js';
import { assertGuest } from './m12-codex-session.mjs';
import { surfaceConfig, prepareFixtureSurfaces, observeFixtureInputs, observeToolOutput } from '../packages/runtime-adapters/codex/src/fixture-surfaces.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const binaryHash='8f0554ede25bbc5450921897c468b2e84635aa513c5017457997af0954581f49';
const root=resolve('C:/M11/work');
const responseEvents=(index,call)=>{
  const id=`resp-m14-${index}`,events=[{type:'response.created',response:{id}}];
  if(call)events.push({type:'response.output_item.done',item:{type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.arguments)}});
  else events.push({type:'response.output_item.done',item:{type:'message',role:'assistant',id:'msg-m14',content:[{type:'output_text',text:'Task completed.'}]}});
  events.push({type:'response.completed',response:{id,usage:{input_tokens:1,input_tokens_details:null,
    output_tokens:1,output_tokens_details:null,total_tokens:2}}});
  return events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
};
async function noOwnedCodex(){
  const ps=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',
    "$ErrorActionPreference='Stop';$p=@(Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object {$_.Name -eq 'codex.exe'});if($p.Count){exit 2}"],{stdio:'ignore',windowsHide:true});
  return new Promise(yes=>{ps.once('error',()=>yes(false));ps.once('exit',code=>yes(code===0));});
}
async function runVerifier(project){
  const started=performance.now(),child=spawn(process.execPath,['test.mjs'],{cwd:project,
    env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,TEMP:process.env.TEMP,TMP:process.env.TMP},
    stdio:['ignore','pipe','pipe'],windowsHide:true});child.stdout.resume();child.stderr.resume();
  const exitCode=await new Promise(yes=>{child.once('error',()=>yes(127));child.once('exit',code=>yes(code??127));});
  return {exitCode,passed:exitCode===0,ms:performance.now()-started};
}
async function filesBelow(directory,prefix=''){
  const out=[];for(const entry of await readdir(directory,{withFileTypes:true})){
    const rel=prefix?`${prefix}/${entry.name}`:entry.name,path=resolve(directory,entry.name);
    if(entry.isSymbolicLink())out.push(`SYMLINK:${rel}`);else if(entry.isDirectory())out.push(...await filesBelow(path,rel));else out.push(rel);
  }return out.sort();
}
function inspectTools(body,mapping){
  if(!body||!Array.isArray(body.tools))return null;const ids=[],seen=new Set();
  for(const tool of body.tools){
    if(!tool||tool.type!=='function'||seen.has(tool.name))return null;const row=mapping.find(x=>x.native.name===tool.name);
    if(!row||sha256(tool)!==sha256(row.native))return null;seen.add(tool.name);ids.push(row.capability.id);
  }return ids.sort();
}

export async function createGuestCodingBackend({taskId,task,mode='ASSIST',surfaces='none'}){
  const configSurfaces=surfaceConfig(surfaces),surfaceSessions=[];
  assertGuest();if(digest(await readFile('runtime/codex.exe'))!==binaryHash)throw Error('RUNTIME_PIN_MISMATCH');
  const fixture=JSON.parse(await readFile('fixtures/m14-coding-task/fixture.json','utf8'));
  if(task!==fixture.task||typeof taskId!=='string'||!taskId)throw Error('FIXTURE_TASK_MISMATCH');
  const mapping=fixture.capabilities.map(spec=>{
    const native={type:'function',name:spec.name,description:spec.description,strict:false,parameters:spec.inputSchema};
    const tool={type:'function',name:spec.name,description:spec.description,inputSchema:spec.inputSchema,deferLoading:false};
    const capability=capabilityDescriptor({kind:'tool',name:spec.name,description:spec.description,
      source:{namespace:'codex:m14:workspace-tools',nativeId:spec.name},risk:spec.risk,
      requiredPermissions:spec.permission==='allowed'?['owned-workspace']:['destructive-workspace']});
    return {spec,native,tool,capability};
  });
  const identity=runtimeIdentity({family:'codex',installationId:`pinned-${binaryHash}`,surface:'windows-sandbox-isolated-coding-task',
    runtimeVersion:CODEX_EFFECT_VERSION,adapterVersion:'m14.v1',evidence:[{kind:'runtime_process',ref:`sha256:${binaryHash}`}]});
  const used=new Set();
  const backend={identity,isolation:'windows-sandbox-owned',async run(ids,phase,onEvent){
    assertGuest();if(!await noOwnedCodex())throw Error('PROCESS_BOUNDARY_NOT_FRESH');
    if(!['before','apply','restore'].includes(phase)||used.has(phase)||new Set(ids).size!==ids.length
      ||ids.some(id=>!mapping.some(m=>m.capability.id===id)))throw Error('INVALID_SESSION');used.add(phase);
    const owned=resolve(root,`m14-${phase}`),project=resolve(owned,'project'),rel=relative(root,owned);
    if(!rel||rel==='..'||rel.startsWith(`..${sep}`))throw Error('INVALID_OWNED_ROOT');
    const selected=mapping.filter(m=>ids.includes(m.capability.id));
    const report={phase,disposed:false,codexLaunches:0,modelRequests:0,externalProviderCalls:0,
      exposure:actualExposure({runtimeId:identity.id,runtimeVersion:identity.runtimeVersion,scope:CODEX_EFFECT_SCOPE,sessionId:null})};
    let driver=null,driverExit=null,server=null;const started=performance.now(),requests=[];
    await mkdir(project,{recursive:true});await mkdir(resolve(owned,'codex'));
    for(const name of fixture.allowedFiles)await copyFile(resolve('fixtures/m14-coding-task',name),resolve(project,name));
    const initialHashes=Object.fromEntries(await Promise.all(fixture.allowedFiles.map(async name=>[name,digest(await readFile(resolve(project,name)))])));
    let config=await readFile('fixtures/m11-frozen/config.toml','utf8');
    config=config.replaceAll('M11 synthetic metadata experiment. Do not execute any tools.','M14 isolated coding fixture. Use only the reviewed dynamic workspace tools.');
    await writeFile(resolve(owned,'codex/config.toml'),config,{flag:'wx'});
    let catalog=await readFile('fixtures/m11-frozen/model-catalog.json','utf8');
    catalog=catalog.replaceAll('M11 synthetic metadata experiment. Do not execute any tools.','M14 isolated coding fixture. Use only the reviewed dynamic workspace tools.');
    await writeFile(resolve(owned,'codex/model-catalog.json'),catalog,{flag:'wx'});
    const completionPath=resolve(owned,'provider-sequence-complete');
    try{
    const prepared=await prepareFixtureSurfaces({config:configSurfaces,mode:phase==='apply'?mode:'CONTROL',task:{id:taskId,text:task},
      skillRoot:resolve('fixtures/m14-reviewed-skills'),projectRoot:project});
    const surfaceSession={phase,evidence:prepared.evidence,outputObservations:[],nativeTurnCompleted:null,providerSequenceCompleted:null};surfaceSessions.push(surfaceSession);
    const driverInput={projectRoot:project,completionPath,task:fixture.task,taskId,sessionId:`m14-${phase}`,surfaceInputs:prepared.inputs,
      outputShadow:phase==='apply'&&mode==='ASSIST'&&configSurfaces.outputShadow,allowedFiles:fixture.allowedFiles,
      toolCapabilityIds:Object.fromEntries(mapping.map(m=>[m.spec.name,m.capability.id])),dynamicTools:selected.map(m=>m.tool),
      threadStartCommon:{model:'m11-synthetic-direct',modelProvider:'m11_loopback',allowProviderModelFallback:false,cwd:project,
        ephemeral:true,environments:[],selectedCapabilityRoots:[],config:{}}};
    await writeFile(resolve(owned,'inputs.json'),JSON.stringify(driverInput),{flag:'wx'});
      const calls=phase==='apply'?[{id:'m14-call-read',name:'workspace_read',arguments:{path:'math.js'}},
        {id:'m14-call-write',name:'workspace_write',arguments:{path:'math.js',content:fixture.expectedSource}},
        {id:'m14-call-test',name:'workspace_test',arguments:{}}]:[];
      let index=0;
      server=http.createServer((req,res)=>{(async()=>{
        try{
          if(req.method!=='POST'||req.url!=='/v1/responses'||index>(calls.length))throw Error('REQUEST_REJECTED');
          const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw Error('REQUEST_LIMIT');chunks.push(chunk);}
          const raw=Buffer.concat(chunks).toString('utf8'),body=JSON.parse(raw),observed=inspectTools(body,mapping);
          if(!observed||sha256(observed)!==sha256([...ids].sort()))throw Error('EXPOSURE_MISMATCH');
          if(index===0)surfaceSession.evidence=observeFixtureInputs(body,prepared);
          if(index>0&&phase==='apply'){
            const expected=index===1?await readFile('fixtures/m14-coding-task/math.js','utf8'):index===2?'written':'tests passed';
            surfaceSession.outputObservations.push(observeToolOutput(body,calls[index-1].id,expected));
          }
          requests.push(digest(raw));report.modelRequests++;if(index===0){report.requestHash=requests[0];report.observedToolNamesHash=sha256(selected.map(m=>m.spec.name).sort());
            report.exposure=actualExposure({runtimeId:identity.id,runtimeVersion:identity.runtimeVersion,scope:CODEX_EFFECT_SCOPE,
              sessionId:null,state:'known',completeness:'complete',visibleIds:observed,evidence:[{kind:'model_context',ref:`request:${requests[0]}:tools`}]});
            onEvent('runtime_exposure_observed');}
          const payload=responseEvents(index,calls[index]??null);index++;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'close'});
          await new Promise((yes,no)=>{res.once('finish',yes);res.once('error',no);res.end(payload);});
          if(index===calls.length+1)await writeFile(completionPath,'complete\n',{flag:'wx'});
        }catch{report.failureCode='PROVIDER_PROTOCOL_FAILED';if(!res.headersSent)res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"M14_PROVIDER_FAILED"}');}
      })();});
      server.requestTimeout=10000;server.headersTimeout=10000;server.on('connect',(_,socket)=>socket.destroy());server.on('upgrade',(_,socket)=>socket.destroy());
      await new Promise((yes,no)=>{server.once('error',no);server.listen(43187,'127.0.0.1',yes);});
      driver=spawn(process.execPath,['scripts/m14-codex-task-driver.mjs',resolve('runtime/codex.exe'),resolve(owned,'inputs.json'),resolve(owned,'driver-state.json')],{
        cwd:root,env:{...process.env,CODEX_HOME:resolve(owned,'codex')},stdio:['ignore','ignore','pipe'],windowsHide:true});driver.stderr.resume();
      driverExit=new Promise(yes=>{driver.once('exit',code=>yes(code));driver.once('error',()=>yes(127));});
      await new Promise((yes,no)=>{driver.once('spawn',yes);driver.once('error',no);});onEvent('runtime_session_launched');
      let sessionTimer;const code=await Promise.race([driverExit,new Promise(yes=>{sessionTimer=setTimeout(()=>yes(124),70000);})]);clearTimeout(sessionTimer);
      if(code===124){const killer=spawn('C:/Windows/System32/taskkill.exe',['/PID',String(driver.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise(yes=>killer.once('exit',yes));await driverExit;}
      const state=JSON.parse(await readFile(resolve(owned,'driver-state.json'),'utf8'));report.codexLaunches=state.codexProcessStarted?1:0;
      surfaceSession.nativeTurnCompleted=state.turnCompleted===true;surfaceSession.providerSequenceCompleted=state.providerSequenceCompleted===true;
      surfaceSession.outputShadow=state.outputShadow??[];
      if(code!==0||state.status!=='SUCCEEDED'||!state.providerSequenceCompleted||report.failureCode)throw Error('CODING_SESSION_FAILED');
      report.observeMs=performance.now()-started;
      if(phase==='apply'){
        onEvent('workspace_mutation_observed');onEvent('verification_started');const verificationStart=performance.now();
        const codeBytes=await readFile(resolve(project,'math.js')),verification=await runVerifier(project),files=await filesBelow(project);
        const finalHashes=Object.fromEntries(await Promise.all(fixture.allowedFiles.map(async name=>[name,digest(await readFile(resolve(project,name)))])));
        const modified=fixture.allowedFiles.filter(name=>initialHashes[name]!==finalHashes[name]);
        const forbidden=[...files.filter(name=>!fixture.allowedFiles.includes(name)),...modified.filter(name=>!fixture.expectedModifiedFiles.includes(name))];
        const failed=state.toolCalls.filter(c=>!c.success).map(c=>({capabilityId:c.capabilityId,code:c.code}));
        report.taskExecution={schemaVersion:'codex.coding-task-report.v1',fixtureId:fixture.id,taskTextHash:sha256({id:taskId,text:fixture.task}),
          status:verification.passed&&digest(codeBytes)===digest(fixture.expectedSource)&&forbidden.length===0?'passed':'failed',
          observedCapabilityIds:report.exposure.visibleIds,usedCapabilityIds:[...new Set(state.toolCalls.map(c=>c.capabilityId).filter(Boolean))],
          failedToolCalls:failed,toolCallCount:state.toolCalls.length,filesRead:[...new Set(state.filesRead)].sort(),
          filesModified:modified,testsRun:state.testsRun,
          verification:{codeHash:digest(codeBytes),expectedCodeHash:digest(fixture.expectedSource),targetPassed:verification.passed,
            existingTestsPassed:verification.passed,forbiddenModifications:forbidden},
          timings:{executionMs:report.observeMs,verificationMs:performance.now()-verificationStart}};
        onEvent('verification_completed');
      }
    }finally{
      if(driver&&driver.exitCode===null&&driver.signalCode===null){const killer=spawn('C:/Windows/System32/taskkill.exe',['/PID',String(driver.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise(yes=>killer.once('exit',yes));await driverExit;}
      if(server){server.closeAllConnections();await new Promise(yes=>server.close(yes));}
      if(await noOwnedCodex()&&!(await lstat(owned)).isSymbolicLink()){await rm(owned,{recursive:true});try{await access(owned);}catch(error){if(error.code==='ENOENT')report.disposed=true;}}
    }
    return report;
  }};
  const capabilities=mapping.map(m=>m.capability),requiredCapabilityIds=mapping.filter(m=>m.spec.required).map(m=>m.capability.id);
  return {backend,capabilities,fixture,surfaceEvidence:()=>structuredClone(surfaceSessions),entries:mapping.map(m=>({capability:m.capability,permission:m.spec.permission})),
    acceptance:{fixtureId:fixture.id,taskTextHash:sha256({id:taskId,text:fixture.task}),requiredCapabilityIds,
      expectedModifiedFiles:fixture.expectedModifiedFiles,allowedFiles:fixture.allowedFiles}};
}
