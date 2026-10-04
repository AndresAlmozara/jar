import { mkdir,open,readFile,rename,unlink,chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ChatGptAuthError, isIssuedClientId } from './oauth.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const authError=(code,cause)=>new ChatGptAuthError(code,{cause});
export function defaultAuthRoot(environment=process.env){
  const base=environment.LOCALAPPDATA;if(typeof base!=='string'||!base.trim())throw authError('LOCAL_APP_DATA_UNAVAILABLE');
  return join(base,'JAR');
}

async function runChild(exe,args,{input=null,spawnProcess=spawn}={}){
  return new Promise((resolve,reject)=>{
    const child=spawnProcess(exe,args,{windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});let output='';
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4*1024*1024)child.kill();});
    child.once('error',()=>reject(authError('LOCAL_CREDENTIAL_PROTECTION_FAILED')));
    child.once('close',code=>code===0?resolve(output.trim()):reject(authError('LOCAL_CREDENTIAL_PROTECTION_FAILED')));
    child.stdin.end(input??'');
  });
}

export class WindowsDpapiProtector {
  constructor({environment=process.env,spawnProcess=spawn}={}){this.environment=environment;this.spawnProcess=spawnProcess;}
  async transform(mode,bytes){
    if(process.platform!=='win32')throw authError('PLATFORM_CREDENTIAL_PROTECTION_UNAVAILABLE');
    const exe=join(this.environment.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const method=mode==='protect'?'Protect':'Unprotect';
    const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $o=[Security.Cryptography.ProtectedData]::${method}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
    const result=await runChild(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{input:Buffer.from(bytes).toString('base64'),spawnProcess:this.spawnProcess});
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(result))throw authError('LOCAL_CREDENTIAL_PROTECTION_FAILED');
    const decoded=Buffer.from(result,'base64');if(!decoded.length)throw authError('LOCAL_CREDENTIAL_PROTECTION_FAILED');return decoded;
  }
  protect(bytes){return this.transform('protect',bytes);}
  unprotect(bytes){return this.transform('unprotect',bytes);}
}

export async function restrictWindowsAccess(target,{directory=false,environment=process.env,spawnProcess=spawn}={}){
  if(process.platform!=='win32')return chmod(target,directory?0o700:0o600);
  const user=[environment.USERDOMAIN,environment.USERNAME].filter(Boolean).join('\\');if(!user)throw authError('LOCAL_ACCOUNT_UNAVAILABLE');
  const grant=directory?`${user}:(OI)(CI)F`:`${user}:F`;
  await runChild(join(environment.SystemRoot??'C:\\Windows','System32','icacls.exe'),[target,'/inheritance:r','/grant:r',grant],{spawnProcess});
}

async function atomicWrite(path,bytes,{restrictAccess=restrictWindowsAccess}={}){
  const temp=`${path}.${randomUUID()}.tmp`;let handle;
  try{handle=await open(temp,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    await restrictAccess(temp,{directory:false});await rename(temp,path);
  }catch(error){try{await handle?.close();}catch{}try{await unlink(temp);}catch{}throw error;}
}

export class ChatGptCredentialStore {
  constructor({root=defaultAuthRoot(),protector=new WindowsDpapiProtector(),restrictAccess=restrictWindowsAccess,now=()=>Date.now()}={}){
    this.root=root;this.protector=protector;this.restrictAccess=restrictAccess;this.now=now;
    this.hostPath=join(root,'host.json');this.profilePath=join(root,'chatgpt-profile.bin');this.lockPath=join(root,'chatgpt-profile.lock');
  }
  async ensureRoot(){await mkdir(this.root,{recursive:true,mode:0o700});await this.restrictAccess(this.root,{directory:true});}
  async ensureHostId(){
    await this.ensureRoot();try{const data=JSON.parse(await readFile(this.hostPath,'utf8'));if(/^urn:uuid:[0-9a-f-]{36}$/i.test(data.ext_agent_host_id))return data.ext_agent_host_id;}catch(error){if(error.code!=='ENOENT')throw authError('HOST_ID_INVALID');}
    const ext_agent_host_id=`urn:uuid:${randomUUID()}`;let handle;
    try{handle=await open(this.hostPath,'wx',0o600);await handle.writeFile(JSON.stringify({schemaVersion:1,ext_agent_host_id})+'\n');await handle.sync();await handle.close();handle=null;
      await this.restrictAccess(this.hostPath,{directory:false});return ext_agent_host_id;
    }catch(error){await handle?.close().catch(()=>{});if(error.code!=='EEXIST')throw error;
      const data=JSON.parse(await readFile(this.hostPath,'utf8'));if(!/^urn:uuid:[0-9a-f-]{36}$/i.test(data.ext_agent_host_id))throw authError('HOST_ID_INVALID');return data.ext_agent_host_id;}
  }
  async readProfile(){
    try{const encrypted=await readFile(this.profilePath),plain=await this.protector.unprotect(encrypted),profile=JSON.parse(plain.toString('utf8'));
      if(!profile||profile.schemaVersion!==1||!isIssuedClientId(profile.issuedClientId))throw authError('LOCAL_AUTH_PROFILE_INVALID');return profile;
    }catch(error){if(error.code==='ENOENT')return null;if(error instanceof ChatGptAuthError)throw error;throw authError('LOCAL_AUTH_PROFILE_INVALID');}
  }
  async writeProfile(profile){
    if(!profile||profile.schemaVersion!==1||!isIssuedClientId(profile.issuedClientId))throw authError('LOCAL_AUTH_PROFILE_INVALID');
    await this.ensureRoot();const encrypted=await this.protector.protect(Buffer.from(JSON.stringify(profile)));await atomicWrite(this.profilePath,encrypted,{restrictAccess:this.restrictAccess});
  }
  async withLock(action,{timeoutMs=5000}={}){
    await this.ensureRoot();const deadline=this.now()+timeoutMs;let lock;
    while(!lock){try{lock=await open(this.lockPath,'wx',0o600);await this.restrictAccess(this.lockPath,{directory:false});}
      catch(error){if(lock){await lock.close().catch(()=>{});lock=null;await unlink(this.lockPath).catch(()=>{});}if(error.code!=='EEXIST')throw error;
        if(this.now()>=deadline)throw authError('AUTH_PROFILE_BUSY');await sleep(50);}}
    try{return await action();}finally{try{await lock.close();}finally{await unlink(this.lockPath).catch(()=>{});}}
  }
}
