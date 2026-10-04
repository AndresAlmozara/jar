import { lstat, realpath, open, mkdir, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, relative, dirname, join, sep, isAbsolute } from 'node:path';
import { sha256 } from '../../../core/src/hash.js';

export const workspaceError=code=>Object.assign(new Error(code),{code});
const reject=code=>{throw workspaceError(code);};
const handles=new WeakMap();
export const DEFAULT_EXCLUDES=['.git','.jar','node_modules','coverage','dist','build','.cache','.vscode','.idea'];
const integer=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
export function reviewedPath(value){
  if(typeof value!=='string'||value.length>240||!value||isAbsolute(value)||value.includes('\\')||value.includes(':')
    ||value.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')||/[ .]$/.test(p)
      ||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)||!/^[-a-zA-Z0-9_.]+$/.test(p)
      ||DEFAULT_EXCLUDES.includes(p.toLowerCase())||/(?:^|[-_.])(auth|credentials?|secrets?|tokens?|passwords?)(?:[-_.]|$)/i.test(p)
      ||/\.(pem|key|pfx|p12|exe|dll|bin)$/i.test(p)))reject('WORKSPACE_PATH_REJECTED');
  return value;
}
const strict=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))reject('MANIFEST_INVALID');};
export function workspaceManifest(raw){
  strict(raw,['schemaVersion','id','sourceRoot','task','include','exclude','immutable','limits','commands','surfaces','capabilityProfile','verifier']);
  if(raw.schemaVersion!=='jar.owned-workspace.v1'||!/^[-a-z0-9]{1,64}$/.test(raw.id)||typeof raw.sourceRoot!=='string'
    ||!raw.sourceRoot||/^[/\\]{2}|^\\\?/.test(raw.sourceRoot)||typeof raw.task!=='string'||!raw.task.trim()||raw.task.length>8000)reject('MANIFEST_INVALID');
  const {limits}=raw;strict(limits,['maxFiles','maxFileBytes','maxTotalBytes']);
  if(!integer(limits.maxFiles,200)||!integer(limits.maxFileBytes,65536)||!integer(limits.maxTotalBytes,4*1024*1024))reject('MANIFEST_LIMITS_INVALID');
  if(!Array.isArray(raw.include)||!raw.include.length||raw.include.length>limits.maxFiles||!Array.isArray(raw.immutable)
    ||!Array.isArray(raw.exclude)||raw.exclude.some(p=>typeof p!=='string'||!p))reject('MANIFEST_INVALID');
  const include=raw.include.map(reviewedPath).sort();
  if(new Set(include.map(p=>p.toLowerCase())).size!==include.length||raw.immutable.some(p=>!include.includes(p))
    ||include.some(p=>raw.exclude.some(e=>p===e||p.startsWith(e+'/'))))reject('MANIFEST_PATH_CONFLICT');
  strict(raw.commands,Object.keys(raw.commands??{}));
  const commands={};
  if(Object.keys(raw.commands).length>8)reject('COMMAND_INVALID');
  for(const [id,command] of Object.entries(raw.commands)){
    strict(command,['argv','timeoutMs','maxOutputBytes']);
    // First generic executor supports only a reviewed immutable Node entrypoint,
    // not npm lifecycle scripts, shell strings, eval, flags or model-chosen argv.
    if(!/^[a-z][a-z0-9-]{0,31}$/.test(id)||!Array.isArray(command.argv)||command.argv.length!==2
      ||command.argv[0]!=='node'||!raw.immutable.includes(command.argv[1])||!command.argv[1].endsWith('.mjs')
      ||!integer(command.timeoutMs,30000)||!integer(command.maxOutputBytes,16384))reject('COMMAND_INVALID');
    commands[id]={...command,argv:[...command.argv]};
  }
  if(!Array.isArray(raw.surfaces)||new Set(raw.surfaces).size!==raw.surfaces.length
    ||!raw.surfaces.includes('capabilities')||raw.surfaces.some(s=>!['capabilities','skills','context','output-shadow'].includes(s)))reject('SURFACES_INVALID');
  if(raw.capabilityProfile!==undefined&&!['workspace-core','smoke-expanded'].includes(raw.capabilityProfile))reject('CAPABILITY_PROFILE_INVALID');
  if(raw.verifier!==undefined){strict(raw.verifier,['root','entrypoint']);reviewedPath(raw.verifier.root);reviewedPath(raw.verifier.entrypoint);}
  return JSON.parse(JSON.stringify({...raw,include,commands}));
}
export async function regularRoot(root){
  const absolute=resolve(root),actual=await realpath(absolute),info=await lstat(absolute);
  if(!info.isDirectory()||info.isSymbolicLink()||actual.toLowerCase()!==absolute.toLowerCase())reject('WORKSPACE_LINK_REJECTED');
  return absolute;
}
export async function checkedFile(root,name){
  reviewedPath(name);await regularRoot(root);let cursor=resolve(root);
  for(const part of name.split('/')){cursor=join(cursor,part);const st=await lstat(cursor);if(st.isSymbolicLink())reject('WORKSPACE_LINK_REJECTED');}
  if(!(await lstat(cursor)).isFile())reject('WORKSPACE_FILE_REJECTED');return cursor;
}
export async function readBounded(root,name,maxBytes){
  const path=await checkedFile(root,name),handle=await open(path,'r');
  try{
    const before=await handle.stat();if(before.size>maxBytes)reject('WORKSPACE_SIZE_LIMIT');
    const bytes=Buffer.alloc(maxBytes+1);let size=0;
    while(size<bytes.length){const result=await handle.read(bytes,size,bytes.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}
    if(size>maxBytes)reject('WORKSPACE_SIZE_LIMIT');
    const after=await lstat(path);
    if(after.isSymbolicLink()||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)reject('WORKSPACE_CHANGED');
    if(bytes.subarray(0,size).includes(0))reject('WORKSPACE_BINARY_REJECTED');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));}catch{reject('WORKSPACE_BINARY_REJECTED');}
    return {text,bytes:size,hash:sha256(text)};
  }finally{await handle.close();}
}
export async function prepareOwnedWorkspace(raw,{manifestDirectory,runsRoot}){
  const manifest=workspaceManifest(raw),source=await regularRoot(resolve(manifestDirectory,manifest.sourceRoot));
  const files=[],contents=new Map();let total=0;
  for(const path of manifest.include){const data=await readBounded(source,path,manifest.limits.maxFileBytes);total+=data.bytes;
    if(total>manifest.limits.maxTotalBytes)reject('WORKSPACE_TOTAL_LIMIT');files.push({path,hash:data.hash,bytes:data.bytes});contents.set(path,data.text);}
  await mkdir(runsRoot,{recursive:true});const base=await regularRoot(runsRoot);
  // A destination inside a reviewed source would violate source-read-only.
  const rel=relative(source,base);if(!rel||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))reject('DESTINATION_INSIDE_SOURCE');
  const runRoot=await mkdtemp(join(base,'run-')),workspaceRoot=join(runRoot,'workspace');await mkdir(workspaceRoot);
  const info=await lstat(runRoot);
  const state={manifest,source,runRoot,workspaceRoot,base,ino:info.ino,active:0,disposed:false};
  const handle=Object.freeze({id:sha256(runRoot),runRoot,workspaceRoot,manifestHash:sha256(manifest),taskHash:sha256(manifest.task),
    startStateHash:sha256(files),files:Object.freeze(files.map(Object.freeze))});handles.set(handle,state);
  try{
    for(const {path,hash} of files){const current=await readBounded(source,path,manifest.limits.maxFileBytes);if(current.hash!==hash)reject('SOURCE_CHANGED');
      const target=join(workspaceRoot,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,contents.get(path),{flag:'wx'});}
    return handle;
  }catch(error){await disposeOwnedWorkspace(handle);throw error;}
}
export function ownedState(handle){const s=handles.get(handle);if(!s||s.disposed)reject('WORKSPACE_NOT_OWNED');return s;}
export async function workspaceSnapshot(handle){
  const s=ownedState(handle);await regularRoot(s.workspaceRoot);const files=[];
  async function walk(dir,prefix=''){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const name=prefix+entry.name;if(entry.isSymbolicLink())reject('WORKSPACE_LINK_REJECTED');
      if(entry.isDirectory()){if(!s.manifest.include.some(p=>p.startsWith(name+'/')))reject('UNREVIEWED_DIRECTORY');await walk(join(dir,entry.name),name+'/');}
      else{if(!s.manifest.include.includes(name))reject('UNREVIEWED_FILE');const data=await readBounded(s.workspaceRoot,name,s.manifest.limits.maxFileBytes);files.push({path:name,hash:data.hash,bytes:data.bytes});}
      if(files.length>s.manifest.limits.maxFiles)reject('WORKSPACE_SIZE_LIMIT');
    }
  }
  await walk(s.workspaceRoot);
  if(files.length!==s.manifest.include.length||files.reduce((n,f)=>n+f.bytes,0)>s.manifest.limits.maxTotalBytes)reject('WORKSPACE_POLICY_FAILED');
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return files;
}
export async function verifyWorkspacePolicy(handle){
  const s=ownedState(handle),files=await workspaceSnapshot(handle),modified=files.filter(f=>handle.files.find(x=>x.path===f.path)?.hash!==f.hash).map(f=>f.path);
  const immutableChanged=modified.filter(p=>s.manifest.immutable.includes(p));
  let sourceUnchanged=true;for(const f of handle.files){try{if((await readBounded(s.source,f.path,s.manifest.limits.maxFileBytes)).hash!==f.hash)sourceUnchanged=false;}catch{sourceUnchanged=false;}}
  return {passed:!immutableChanged.length&&sourceUnchanged,sourceUnchanged,immutableChanged,modified,finalStateHash:sha256(files)};
}
export async function disposeOwnedWorkspace(handle){
  const s=ownedState(handle);if(s.active)reject('WORKSPACE_PROCESS_ACTIVE');
  await regularRoot(s.base);await regularRoot(s.runRoot);
  if(dirname(s.runRoot)!==s.base||(await lstat(s.runRoot)).ino!==s.ino)reject('CLEANUP_OWNERSHIP_FAILED');
  // rm does not follow directory links; source is never a cleanup target.
  await rm(s.runRoot,{recursive:true});s.disposed=true;return {disposed:true,remainingOwnedProcesses:0};
}
