import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, lstat, access } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { userInfo } from 'node:os';
import { sha256 } from '../packages/core/src/hash.js';
import { actualExposure, runtimeIdentity } from '../packages/runtime-adapters/src/contracts.js';
import { capabilityDescriptor } from '../packages/capability-exposure/src/contracts.js';
import { captureRuntimeRequest } from '../packages/request-capture/src/capture.js';
import { parseRequestJSON } from '../packages/request-capture/src/privacy.js';
import { CODEX_EFFECT_SCOPE, CODEX_EFFECT_VERSION } from '../packages/runtime-adapters/codex/src/isolated-effect.js';
import { buildRealAdmission } from './m11-evaluate-runtime-admission.mjs';

const digest=b=>createHash('sha256').update(b).digest('hex');
const binaryHash='8f0554ede25bbc5450921897c468b2e84635aa513c5017457997af0954581f49';
const root=resolve('C:/M11/work');
export function assertGuest(){
  let valid=false;
  try{valid=process.platform==='win32'&&process.env.USERPROFILE==='C:\\Users\\WDAGUtilityAccount'
    &&userInfo().username==='WDAGUtilityAccount'&&resolve(process.cwd())===root;}catch{}
  if(!valid)throw new Error('SANDBOX_REQUIRED');
}
async function noOwnedCodex(){
  const ps=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',
    "$ErrorActionPreference='Stop';$p=@(Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object {$_.Name -eq 'codex.exe'});if($p.Count){exit 2}"],
    {stdio:'ignore',windowsHide:true});
  return new Promise(resolve=>{ps.once('error',()=>resolve(false));ps.once('exit',code=>resolve(code===0));});
}

/** M11 parsing plus an independently complete, narrow top-level tool scope.
 * No waiver changes M11's full-request PARTIAL result. Model/input/metadata are
 * outside this scope. Every tool definition must match the frozen native map.
 */
export function inspectToolArray(raw, observation, mapping) {
  const body=parseRequestJSON(raw);
  if(!body || !Array.isArray(body.tools))return null;
  const allowed=['type','name','description','strict','parameters'];
  const names=new Set(), ids=[];
  for(const tool of body.tools){
    if(!tool || tool.type!=='function' || Object.keys(tool).some(k=>!allowed.includes(k))
      ||names.has(tool.name))return null;
    const expected=mapping.find(row=>row.native.name===tool.name);
    if(!expected || sha256(tool)!==sha256(expected.native))return null;
    names.add(tool.name);ids.push(expected.capability.id);
  }
  if(observation.tools.length!==names.size || observation.tools.some(t=>!names.has(t.nativeId)
    || t.representations.some(r=>!/^tools\[\d+\]$/.test(r.location))))return null;
  return {ids:ids.sort(),namesHash:sha256([...names].sort())};
}

export async function createGuestSessionBackend(){
  assertGuest();
  if(digest(await readFile('runtime/codex.exe'))!==binaryHash)throw new Error('RUNTIME_PIN_MISMATCH');
  const admission=(await buildRealAdmission()).outcome;
  const inputs=JSON.parse(await readFile('fixtures/m11-frozen/thread-inputs.json','utf8'));
  const mapping=inputs.baselineDynamicTools.map(tool=>({tool,
    native:{type:'function',name:tool.name,description:tool.description,strict:false,parameters:tool.inputSchema},
    capability:capabilityDescriptor({kind:'tool',name:tool.name,description:'Owned synthetic metadata-only capability',
      source:{namespace:'codex:m12:dynamic-tools',nativeId:tool.name},risk:'low'})}));
  const identity=runtimeIdentity({family:'codex',installationId:`pinned-${binaryHash}`,surface:'windows-sandbox-isolated-dynamic-tools',
    runtimeVersion:CODEX_EFFECT_VERSION,adapterVersion:'m12.v1',evidence:[{kind:'runtime_process',ref:admission.id}]});
  const used=new Set();
  const backend={identity,isolation:'windows-sandbox-owned',async run(ids,phase,onEvent){
    assertGuest();
    if(!await noOwnedCodex())throw new Error('PROCESS_BOUNDARY_NOT_FRESH');
    if(!['before','apply','restore'].includes(phase)||used.has(phase)||!Array.isArray(ids)
      ||new Set(ids).size!==ids.length||ids.some(id=>!mapping.some(m=>m.capability.id===id)))throw new Error('INVALID_SESSION');
    used.add(phase);
    const owned=resolve(root,`m12-${phase}`),rel=relative(root,owned);
    if(!rel||rel.startsWith(`..${sep}`)||rel==='..')throw new Error('INVALID_OWNED_ROOT');
    const report={phase,disposed:false,codexLaunches:0,modelRequests:0,exposure:actualExposure({runtimeId:identity.id,
      runtimeVersion:identity.runtimeVersion,scope:CODEX_EFFECT_SCOPE,sessionId:null})};
    let driver,server,driverExit,settle;const started=performance.now();
    const requestSeen=new Promise(resolve=>{settle=resolve;});
    await mkdir(owned);await mkdir(resolve(owned,'codex'));
    await writeFile(resolve(owned,'codex/config.toml'),await readFile('fixtures/m11-frozen/config.toml'),{flag:'wx'});
    const selected=mapping.filter(m=>ids.includes(m.capability.id)).map(m=>m.tool);
    await writeFile(resolve(owned,'inputs.json'),JSON.stringify({...inputs,baselineDynamicTools:selected}),{flag:'wx'});
    await writeFile(resolve(owned,'plan.json'),JSON.stringify({dynamicToolsKey:'baselineDynamicTools'}),{flag:'wx'});
    onEvent('runtime_isolated_state_prepared');
    try{
      let consumed=false;
      server=http.createServer((req,res)=>{(async()=>{
        try{
          if(consumed||req.method!=='POST'||req.url!=='/v1/responses')throw new Error('REQUEST_REJECTED');
          consumed=true;report.modelRequests++;const chunks=[];let size=0;
          for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw new Error('REQUEST_REJECTED');chunks.push(chunk);}
          const raw=Buffer.concat(chunks).toString('utf8');report.requestHash=digest(raw);
          const observation=captureRuntimeRequest({raw,headers:req.headers,runtime:identity,
            providerProtocol:'openai-responses-http',requestScope:'initial-request-static-context',invocationId:`m12-${phase}`,
            turnId:`m12-${phase}`,admission,captureEvidence:{kind:'model_context',ref:`m12-${phase}-request`,requestHash:report.requestHash,
              binaryHash:admission.facts.binaryHash,configHash:admission.facts.configHash,correlationId:admission.correlationId,
              invocationId:`m12-${phase}`,turnId:`m12-${phase}`,ordinal:1}});
          report.fullRequestCompleteness=observation.completeness;
          const tools=inspectToolArray(raw,observation,mapping);
          if(tools){report.observedToolNamesHash=tools.namesHash;report.exposure=actualExposure({runtimeId:identity.id,
            runtimeVersion:identity.runtimeVersion,scope:CODEX_EFFECT_SCOPE,sessionId:null,state:'known',completeness:'complete',
            visibleIds:tools.ids,evidence:[{kind:'model_context',ref:`request:${report.requestHash}:tools`}]});}
        }catch{report.failureCode='EXPOSURE_UNAVAILABLE';}
        finally{
          // Capture stops at the request boundary. No generated answer or tool execution is needed.
          if(!res.headersSent){res.writeHead(400,{'content-type':'application/json','connection':'close'});res.end('{"error":"M12_CAPTURE_STOP"}');}
          settle();
        }
      })();});
      server.requestTimeout=10000;server.headersTimeout=10000;
      server.on('connect',(_,socket)=>socket.destroy());server.on('upgrade',(_,socket)=>socket.destroy());
      await new Promise((yes,no)=>{server.once('error',no);server.listen(43187,'127.0.0.1',yes);});
      driver=spawn(process.execPath,['scripts/m11-runtime-capture-driver.mjs',resolve('runtime/codex.exe'),resolve(owned,'plan.json'),
        resolve(owned,'inputs.json'),resolve(owned,'driver-state.json')],{cwd:root,
        env:{...process.env,CODEX_HOME:resolve(owned,'codex')},stdio:['ignore','ignore','pipe'],windowsHide:true});
      driver.stderr.resume();driverExit=new Promise(resolve=>{driver.once('exit',()=>resolve(true));driver.once('error',()=>resolve(true));});
      await new Promise((yes,no)=>{driver.once('spawn',yes);driver.once('error',no);});onEvent('runtime_session_launched');
      let timer;await Promise.race([requestSeen,driverExit,new Promise(resolve=>{timer=setTimeout(resolve,35000);})]);clearTimeout(timer);
      report.observeMs=performance.now()-started;
      let waitTimer;const exited=await Promise.race([driverExit,new Promise(resolve=>{waitTimer=setTimeout(()=>resolve(false),5000);})]);clearTimeout(waitTimer);
      if(!exited){
        const killer=spawn('C:/Windows/System32/taskkill.exe',['/PID',String(driver.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        await new Promise(resolve=>killer.once('exit',resolve));await driverExit;
      }
      const state=JSON.parse(await readFile(resolve(owned,'driver-state.json'),'utf8'));
      report.codexLaunches=state.codexProcessStarted===true?1:0;
      if(!state.initializedObserved||!state.threadStartObserved){report.exposure=actualExposure({runtimeId:identity.id,
        runtimeVersion:identity.runtimeVersion,scope:CODEX_EFFECT_SCOPE,sessionId:null});report.failureCode='SESSION_UNVERIFIED';}
    } finally {
      if(driver && driver.exitCode===null && driver.signalCode===null){
        const killer=spawn('C:/Windows/System32/taskkill.exe',['/PID',String(driver.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        await new Promise(resolve=>killer.once('exit',resolve));await driverExit;
      }
      if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
      // Only this exact newly-created, non-reparse guest directory is disposable.
      if(await noOwnedCodex() && !(await lstat(owned)).isSymbolicLink()){
        await rm(owned,{recursive:true});try{await access(owned);}catch(error){if(error.code==='ENOENT')report.disposed=true;}
      }
    }
    return report;
  }};
  return {backend,capabilities:mapping.map(m=>m.capability)};
}
