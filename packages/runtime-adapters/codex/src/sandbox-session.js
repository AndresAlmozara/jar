import { spawn } from 'node:child_process';
import { join,resolve } from 'node:path';

const wait=ms=>new Promise(done=>setTimeout(done,ms));
const failure=code=>Object.assign(new Error(code),{code});
const sandboxName=name=>typeof name==='string'&&(/^WindowsSandbox[A-Za-z0-9_-]*\.exe$/i.test(name)||/^vmmemWindowsSandbox$/i.test(name));
const persistentInfrastructureName=name=>typeof name==='string'&&/^WindowsSandboxServer\.exe$/i.test(name);
const canonicalPath=path=>resolve(path).replaceAll('/','\\').toLowerCase();
const normalizedText=value=>String(value??'').replaceAll('/','\\').toLowerCase();
const sameCreation=(a,b)=>a===b||Date.parse(a)===Date.parse(b);

function normalized(row){
  const pid=Number(row.pid??row.ProcessId),parentPid=Number(row.parentPid??row.ParentProcessId),name=row.name??row.Name,
    creationTime=String(row.creationTime??row.CreationDate??''),commandLine=String(row.commandLine??row.CommandLine??'');
  if(!Number.isSafeInteger(pid)||pid<1||!Number.isSafeInteger(parentPid)||parentPid<0||!sandboxName(name)||!Number.isFinite(Date.parse(creationTime)))
    throw failure('SANDBOX_PROCESS_INVENTORY_INVALID');
  return {pid,parentPid,name,creationTime,commandLine};
}

async function collect(child,{timeoutMs=10000,maxBytes=1024*1024}={}){
  let stdout='',settled=false;
  child.stdout?.setEncoding('utf8');child.stdout?.on('data',chunk=>{stdout+=chunk;if(stdout.length>maxBytes)child.kill();});
  const result=await Promise.race([new Promise(resolveResult=>{
    child.once('error',()=>{settled=true;resolveResult({ok:false});});
    child.once('close',code=>{settled=true;resolveResult({ok:code===0});});
  }),wait(timeoutMs).then(()=>({ok:false,timeout:true}))]);
  if(!result.ok){if(!settled)child.kill();throw failure('SANDBOX_PROCESS_INVENTORY_UNAVAILABLE');}
  return stdout;
}

export async function queryWindowsSandboxProcesses({spawnProcess=spawn}={}){
  const script="$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter \"Name LIKE 'WindowsSandbox%' OR Name = 'vmmemWindowsSandbox'\" | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name;creationTime=$_.CreationDate.ToUniversalTime().ToString('o');commandLine=[string]$_.CommandLine} }); [Console]::Out.Write(($p|ConvertTo-Json -Compress))";
  const child=spawnProcess('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
  const text=(await collect(child)).trim();if(!text)return [];
  let parsed;try{parsed=JSON.parse(text);}catch{throw failure('SANDBOX_PROCESS_INVENTORY_INVALID');}
  return (Array.isArray(parsed)?parsed:[parsed]).map(normalized);
}

const wsbCliPath=(environment=process.env)=>join(environment.LOCALAPPDATA??'','Microsoft','WindowsApps','wsb.exe');
export async function queryWindowsSandboxSessions({spawnProcess=spawn,environment=process.env}={}){
  const child=spawnProcess(wsbCliPath(environment),['list','--raw'],{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']}),text=(await collect(child)).trim();
  let parsed;try{parsed=text?JSON.parse(text):{};}catch{throw failure('SANDBOX_SESSION_INVENTORY_INVALID');}
  const rows=parsed?.WindowsSandboxEnvironments;if(!Array.isArray(rows))throw failure('SANDBOX_SESSION_INVENTORY_INVALID');
  return rows.map(row=>{const id=String(row.Id??row.id??'');if(!/^[0-9a-f-]{36}$/i.test(id))throw failure('SANDBOX_SESSION_INVENTORY_INVALID');
    return {id,status:String(row.State??row.state??row.Status??row.status??'unknown')};});
}
export async function stopWindowsSandboxSession(id,{spawnProcess=spawn,environment=process.env}={}){
  if(!/^[0-9a-f-]{36}$/i.test(id))throw failure('SANDBOX_SESSION_ID_INVALID');
  const child=spawnProcess(wsbCliPath(environment),['stop','--id',id,'--raw'],{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});await collect(child,{timeoutMs:15000});
}

export async function assertWindowsSandboxIdle({inventoryProvider=queryWindowsSandboxProcesses,sessionProvider=queryWindowsSandboxSessions}={}){
  const [inventory,sessions]=await Promise.all([inventoryProvider(),sessionProvider()]),current=inventory.map(normalized);
  const persistentInfrastructure=current.filter(process=>persistentInfrastructureName(process.name));
  const sessionProcesses=current.filter(process=>!persistentInfrastructureName(process.name));
  if(sessionProcesses.length||sessions.length)throw failure('SANDBOX_BUSY_EXTERNAL');
  return {sandboxProcessCount:0,sandboxSessionCount:0,persistentInfrastructureProcessCount:persistentInfrastructure.length,observedAt:new Date().toISOString()};
}

async function terminateExactPid(pid,{spawnProcess=spawn,timeoutMs=10000}={}){
  const child=spawnProcess('C:/Windows/System32/taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
  const result=await Promise.race([new Promise(resolveResult=>{child.once('error',()=>resolveResult(false));child.once('close',code=>resolveResult(code===0));}),wait(timeoutMs).then(()=>false)]);
  if(!result)throw failure('OWNED_SANDBOX_FORCE_TERMINATION_FAILED');
}

export function createOwnedSandboxSession({launcherPath,launchTimestamp,launcherLifecycle,inventoryProvider=queryWindowsSandboxProcesses,
  sessionProvider=queryWindowsSandboxSessions,stopSession=stopWindowsSandboxSession,spawnProcess=spawn,pollMs=100}={}){
  if(!launcherLifecycle||!Number.isSafeInteger(launcherLifecycle.pid)||launcherLifecycle.pid<1)throw failure('OWNED_SANDBOX_PID_INVALID');
  const pathIdentity=canonicalPath(launcherPath),launchedAt=Number(launchTimestamp),identities=new Map();let remoteRoot=null,observed=false,officialSessionId=null;
  const remember=process=>{const prior=identities.get(process.pid);if(prior&&!sameCreation(prior.creationTime,process.creationTime))throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');
    identities.set(process.pid,{pid:process.pid,parentPid:process.parentPid,name:process.name,creationTime:process.creationTime,commandLineMatched:normalizedText(process.commandLine).includes(pathIdentity)});};
  const classify=async()=>{
    const all=(await inventoryProvider()).map(normalized),infrastructure=all.filter(item=>persistentInfrastructureName(item.name)),
      sessionProcesses=all.filter(item=>!persistentInfrastructureName(item.name)),byPid=new Map(sessionProcesses.map(item=>[item.pid,item]));
    const exact=sessionProcesses.filter(item=>/^WindowsSandboxRemoteSession\.exe$/i.test(item.name)&&normalizedText(item.commandLine).includes(pathIdentity));
    if(exact.length>1)throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');
    if(exact.length===1){const root=exact[0];if(Date.parse(root.creationTime)<launchedAt-5000)throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');
      if(remoteRoot&&!sameCreation(remoteRoot.creationTime,root.creationTime))throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');remoteRoot=root;remember(root);observed=true;}
    const compute=sessionProcesses.filter(item=>/^vmmemWindowsSandbox$/i.test(item.name)&&Date.parse(item.creationTime)>=launchedAt-5000&&Date.parse(item.creationTime)<=launchedAt+60000);
    if(observed&&compute.length>1)throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');if(observed&&compute.length===1)remember(compute[0]);
    const owned=new Map();for(const item of sessionProcesses){const identity=identities.get(item.pid);
      if(identity&&sameCreation(identity.creationTime,item.creationTime))owned.set(item.pid,item);
      else if(item.pid===launcherLifecycle.pid&&Date.parse(item.creationTime)>=launchedAt-5000){owned.set(item.pid,item);remember(item);}}
    let changed=true;while(changed){changed=false;for(const item of sessionProcesses)if(!owned.has(item.pid)&&owned.has(item.parentPid)){owned.set(item.pid,item);remember(item);changed=true;}}
    if(observed){for(const item of sessionProcesses){const identity=identities.get(item.pid);if(identity&&sameCreation(identity.creationTime,item.creationTime))owned.set(item.pid,item);}
      changed=true;while(changed){changed=false;for(const item of sessionProcesses)if(!owned.has(item.pid)&&owned.has(item.parentPid)){owned.set(item.pid,item);remember(item);changed=true;}}}
    const unrelated=sessionProcesses.filter(item=>!owned.has(item.pid));
    return {all,infrastructure,owned:[...owned.values()],unrelated,byPid};
  };
  const requireNoUnrelated=state=>{if(state.unrelated.length)throw failure('SANDBOX_BUSY_EXTERNAL');};
  const officialSessionGone=async()=>{const sessions=await sessionProvider();if(sessions.some(session=>session.id!==officialSessionId))throw failure('SANDBOX_BUSY_EXTERNAL');
    return !sessions.some(session=>session.id===officialSessionId);};
  const confirmStableIdle=async ms=>{const deadline=Date.now()+ms;do{const state=await classify();requireNoUnrelated(state);if(state.owned.length||!await officialSessionGone())return false;
      if(Date.now()>=deadline)return true;await wait(pollMs);}while(true);};
  const confirmOwnedGone=async ms=>{const deadline=Date.now()+ms;do{const state=await classify();if(state.owned.length)return false;
      if(Date.now()>=deadline)return true;await wait(pollMs);}while(true);};
  const observe=async({timeoutMs=30000}={})=>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const state=await classify();
      if(observed){requireNoUnrelated(state);const sessions=await sessionProvider();if(sessions.length>1)throw failure('SANDBOX_BUSY_EXTERNAL');
        if(sessions.length===1){officialSessionId=sessions[0].id;return snapshot(state);}}await wait(pollMs);}throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');};
  const snapshot=state=>({canonicalLauncherPath:resolve(launcherPath),launchTimestamp:new Date(launchedAt).toISOString(),launcherPid:launcherLifecycle.pid,
    launcherCloseObserved:launcherLifecycle.closed,launcherExitCode:launcherLifecycle.child.exitCode??null,
    officialSandboxSessionId:officialSessionId,
    observedSessionProcesses:[...identities.values()].map(({commandLineMatched,...item})=>({...item,commandLineMatched})),
    ownedSessionPids:state.owned.map(item=>item.pid).sort((a,b)=>a-b)});
  const settle=async({naturalCloseMs=5000,forcedCloseMs=15000,killTimeoutMs=10000,idleCooldownMs=2000}={})=>{
    if(!observed)throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');const naturalDeadline=Date.now()+naturalCloseMs;let state;
    do{state=await classify();requireNoUnrelated(state);if(state.owned.length===0&&await confirmStableIdle(idleCooldownMs))return {...snapshot(state),terminationMode:'natural',
        sandboxSessionSettled:true,ownedSandboxSessionProcessesRemaining:0,idleCooldownMs};await wait(pollMs);}while(Date.now()<naturalDeadline);
    if(officialSessionId)try{await stopSession(officialSessionId,{spawnProcess});}catch{}
    const afterStopDeadline=Date.now()+forcedCloseMs;do{state=await classify();requireNoUnrelated(state);if(state.owned.length===0&&await confirmStableIdle(idleCooldownMs))return {...snapshot(state),
        terminationMode:'host_forced_owned_session',forcedOwnedSessionId:officialSessionId,sandboxSessionSettled:true,ownedSandboxSessionProcessesRemaining:0,idleCooldownMs};await wait(pollMs);}while(Date.now()<afterStopDeadline);
    const ownedIds=new Set(state.owned.map(item=>item.pid)),roots=state.owned.filter(item=>!ownedIds.has(item.parentPid)&&!/^vmmemWindowsSandbox$/i.test(item.name));
    if(!roots.length)throw failure('OWNED_SANDBOX_FORCE_TERMINATION_UNVERIFIED');const forced=[];
    for(const root of roots){const current=(await inventoryProvider()).map(normalized).find(item=>item.pid===root.pid);
      const identity=identities.get(root.pid);if(!current)continue;if(!identity||!sameCreation(identity.creationTime,current.creationTime))throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');
      await terminateExactPid(root.pid,{spawnProcess,timeoutMs:killTimeoutMs});forced.push(root.pid);}
    const forcedDeadline=Date.now()+forcedCloseMs;do{state=await classify();requireNoUnrelated(state);if(state.owned.length===0&&await confirmStableIdle(idleCooldownMs))return {...snapshot(state),
        terminationMode:'host_forced_owned_session',forcedOwnedSessionPids:forced,sandboxSessionSettled:true,ownedSandboxSessionProcessesRemaining:0,idleCooldownMs};await wait(pollMs);}while(Date.now()<forcedDeadline);
    throw failure('OWNED_SANDBOX_FORCE_TERMINATION_UNVERIFIED');
  };
  const cleanup=async({forcedCloseMs=15000,killTimeoutMs=10000,idleCooldownMs=2000}={})=>{
    if(!observed)throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');let state=await classify();if(state.owned.length===0&&await confirmOwnedGone(idleCooldownMs))return {ownedSandboxSessionProcessesRemaining:0,idleCooldownMs};
    if(officialSessionId)try{await stopSession(officialSessionId,{spawnProcess});}catch{}
    const stopDeadline=Date.now()+forcedCloseMs;do{state=await classify();if(state.owned.length===0&&await confirmOwnedGone(idleCooldownMs))return {ownedSandboxSessionProcessesRemaining:0,idleCooldownMs};await wait(pollMs);}while(Date.now()<stopDeadline);
    const ownedIds=new Set(state.owned.map(item=>item.pid)),roots=state.owned.filter(item=>!ownedIds.has(item.parentPid)&&!/^vmmemWindowsSandbox$/i.test(item.name));
    if(!roots.length)throw failure('OWNED_SANDBOX_FORCE_TERMINATION_UNVERIFIED');
    for(const root of roots){const current=(await inventoryProvider()).map(normalized).find(item=>item.pid===root.pid),identity=identities.get(root.pid);
      if(!current)continue;if(!identity||!sameCreation(identity.creationTime,current.creationTime))throw failure('SANDBOX_SESSION_OWNERSHIP_UNVERIFIED');
      await terminateExactPid(root.pid,{spawnProcess,timeoutMs:killTimeoutMs});}
    const deadline=Date.now()+forcedCloseMs;do{state=await classify();if(state.owned.length===0&&await confirmOwnedGone(idleCooldownMs))return {ownedSandboxSessionProcessesRemaining:0,idleCooldownMs};await wait(pollMs);}while(Date.now()<deadline);
    throw failure('OWNED_SANDBOX_FORCE_TERMINATION_UNVERIFIED');
  };
  return Object.freeze({observe,settle,cleanup,get observed(){return observed;},get launcherPath(){return resolve(launcherPath);}});
}
