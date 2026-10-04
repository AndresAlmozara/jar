import { spawn } from 'node:child_process';
import { environmentAuth } from './live-profile.js';

export async function bounded(promise,ms,code='LIVE_TIMEOUT'){
  let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(Object.assign(Error(code),{code})),ms);})]);}
  finally{clearTimeout(timer);}
}
export function childEnvironment({codexHome,workspaceRoot,envKey,environment=process.env,accessToken=null}){
  const token=accessToken??environment[envKey],auth=environmentAuth(envKey,{[envKey]:token});if(!auth.credentialPresent)throw Error('AUTHORIZATION_REQUIRED');
  // Deliberately no PATH, NODE_OPTIONS, proxy settings, user config selectors,
  // normal CODEX_HOME or environment snapshot. Only the provider child receives it.
  return {SystemRoot:environment.SystemRoot,WINDIR:environment.WINDIR,CODEX_HOME:codexHome,
    TEMP:workspaceRoot,TMP:workspaceRoot,RUST_LOG:'off',[envKey]:token};
}
export function createLiveTransport({runtimePath,profile,envKey,environment=process.env,accessToken=null,spawnProcess=spawn}){
  let child,closed=false,spawned=false,handler=()=>{},buffer='',closePromise;
  return {
    onMessage(callback){handler=callback;return ()=>{handler=()=>{};};},
    async start(){
      const env=childEnvironment({...profile,envKey,environment,accessToken});
      child=spawnProcess(runtimePath,['app-server','--stdio','--strict-config'],
        {cwd:profile.workspaceRoot,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
      delete env[envKey];
      closePromise=new Promise(yes=>{child.once('close',()=>{closed=true;yes();});child.once('error',()=>{if(!spawned){closed=true;yes();}});});
      child.stderr.resume();child.stdin.on('error',()=>{});child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        buffer+=chunk;if(Buffer.byteLength(buffer)>1024*1024){handler({method:'transport/failure'});child.stdin.end();buffer='';return;}
        for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
          if(!line.trim())continue;try{const message=JSON.parse(line);Promise.resolve(handler(message)).catch(()=>{});}catch{handler({method:'transport/failure'});}}
      });
      await bounded(new Promise((yes,no)=>{child.once('spawn',()=>{spawned=true;yes();});child.once('error',()=>no(Error('APP_SERVER_START_FAILED')));}),15000);
    },
    send(message){if(!child||closed||!child.stdin.writable)throw Error('APP_SERVER_CLOSED');child.stdin.write(JSON.stringify(message)+'\n');},
    async dispose(){
      if(!child)return {settled:true};child.stdin.end();
      try{await bounded(closePromise,2000);return {settled:true};}catch{}
      if(!closed&&Number.isSafeInteger(child.pid)&&child.pid>0){
        // Target only this still-running owned process tree, never a process name.
        const killer=spawnProcess('C:/Windows/System32/taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        try{await bounded(new Promise((yes,no)=>{killer.once('error',no);killer.once('close',code=>code===0?yes():no(Error('CLEANUP_FAILED')));}),5000);}
        catch{killer.kill();return {settled:false};}
      }
      try{await bounded(closePromise,5000);return {settled:true};}catch{return {settled:false};}
    },
  };
}
