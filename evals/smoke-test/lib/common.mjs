import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
export class DiagnosticError extends Error {
  constructor(code, details=null) {super(code); this.name='DiagnosticError'; this.code=code; this.details=details;}
}
export const fail=(code,details)=>{throw new DiagnosticError(code,details);};
export const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export const json=filename=>JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,''));
export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const iso=()=>new Date().toISOString();
export function atomic(filename, value, asText=false) {
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const tmp=filename+'.tmp-'+process.pid+'-'+crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp,asText?value:JSON.stringify(value,null,2)+'\n','utf8');
  fs.renameSync(tmp,filename);
}
export function redactor() {
  const secrets=new Set();
  const add=s=>{if(typeof s==='string'&&s.length>=8)secrets.add(s);};
  const text=s=>{let x=String(s);for(const v of secrets)x=x.split(v).join('[REDACTED]');return x
    .replace(/Bearer\s+[^\s"\\]+/gi,'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED_JWT]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g,'[REDACTED_KEY]');};
  const clean=(v,key='')=>{
    if(/^(authorization|access_?token|refresh_?token|id_?token|api_?key|client_?secret|password)$/i.test(key))return '[REDACTED]';
    if(typeof v==='string')return text(v);
    if(Array.isArray(v))return v.map(x=>clean(x));
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clean(x,k)]));
    return v;
  };
  return {add,text,clean};
}
export function errorInfo(error, scrub) {
  return scrub.clean({code:error?.code??error?.name??'UNKNOWN_ERROR',message:String(error?.message??error),
    type:error?.name??error?.constructor?.name??null,stage:error?.stage??error?.details?.stage??null,
    details:error?.details??null,status:error?.status??null,stack:error?.stack??null});
}
export function journal(dir,scrub) {
  fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'events.jsonl');fs.closeSync(fs.openSync(file,'a'));
  const origin=performance.now();
  const emit=(event,data={})=>{
    const row=scrub.clean({timestamp:iso(),elapsed_ms:Math.round((performance.now()-origin)*1000)/1000,event,...data});
    fs.appendFileSync(file,JSON.stringify(row)+'\n');return row;
  };
  return {emit,write:(name,data)=>atomic(path.join(dir,name),scrub.clean(data)),file};
}
export function filesUnder(root) {
  const list=[];
  function walk(dir,rel='') {for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const name=rel+e.name,full=path.join(dir,e.name);
    if(e.isSymbolicLink())fail('SYMLINK_IN_REVIEWED_INPUT',{path:full});
    if(e.isDirectory())walk(full,name+'/');else if(e.isFile())list.push(name);
  }}walk(root);return list.sort();
}
export function treeHash(root) {return sha(Buffer.concat(filesUnder(root).flatMap(rel=>[Buffer.from(rel+'\0'),fs.readFileSync(path.join(root,rel)),Buffer.from('\0')])));}
export async function command(argv,{cwd,timeoutMs=30000,scrub=null}={}) {
  return await new Promise(resolve=>{
    let child,stdout='',stderr='',done=false,timedOut=false;const start=performance.now();
    const finish=(code,error=null)=>{if(done)return;done=true;clearTimeout(timer);resolve({returncode:code,
      stdout:scrub?scrub.text(stdout):stdout,stderr:scrub?scrub.text(stderr):stderr,error,timedOut,duration_ms:performance.now()-start});};
    let timer;
    try{child=spawn(argv[0],argv.slice(1),{cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch(e){finish(null,e.code??String(e));return;}
    child.stdout.on('data',b=>{if(stdout.length<2*1024*1024)stdout+=b.toString('utf8');});
    child.stderr.on('data',b=>{if(stderr.length<2*1024*1024)stderr+=b.toString('utf8');});
    child.once('error',e=>finish(null,e.code??String(e)));child.once('close',code=>finish(code));
    timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
  });
}
export function parseJson(text) {try{return JSON.parse(text.trim().replace(/^\uFEFF/,''));}catch{}for(const l of text.trim().split('\n').reverse()){try{return JSON.parse(l);}catch{}}return null;}
export function equalSet(a,b) {return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every(x=>b.includes(x));}
export function immutableSnapshot(repo) {
  const roots=['bin','packages','scripts','fixtures/ecc-mini'],entries=[];
  for(const root of roots){const abs=path.join(repo,root);if(!fs.existsSync(abs))fail('REPO_SURFACE_MISSING',{root});
    for(const rel of filesUnder(abs)){if(!/\.(js|mjs|cjs|json|ps1|wsb|md)$/i.test(rel))continue;
      const name=root+'/'+rel;entries.push({path:name,sha256:sha(fs.readFileSync(path.join(repo,name)))});}}
  entries.push({path:'package.json',sha256:sha(fs.readFileSync(path.join(repo,'package.json')))});
  return {hash:sha(JSON.stringify(entries)),files:entries};
}
export function acquireLock(filename) {
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  if(fs.existsSync(filename)){
    let old;try{old=json(filename);}catch{fail('LOCK_UNREADABLE',{filename});}
    let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)fail('DIAGNOSTIC_ALREADY_RUNNING',{pid:old.pid,filename});
    fs.renameSync(filename,filename+'.stale-'+Date.now());
  }
  const token=crypto.randomUUID();fs.writeFileSync(filename,JSON.stringify({pid:process.pid,token,started:iso()}),{flag:'wx'});
  return ()=>{try{if(json(filename).token===token)fs.unlinkSync(filename);}catch{}};
}
