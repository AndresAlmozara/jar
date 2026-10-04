import { readdir,stat,readFile } from 'node:fs/promises';
import { delimiter,join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile=promisify(execFileCallback);
const VERSION=/\bcodex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/;
const canonical=value=>resolve(value).toLowerCase();

export function selectRuntimeCandidate(candidates,{version,sha256}={}){
  const usable=candidates.filter(candidate=>candidate.available===true&&candidate.version&&candidate.sha256);
  const exact=usable.find(candidate=>candidate.version===version&&candidate.sha256===sha256);
  if(exact)return {status:'ACCEPTED_RUNTIME_RESOLVED',candidate:exact,pathIsIdentity:false};
  return {status:usable.length?'RUNTIME_REVALIDATION_REQUIRED':'CODEX_RUNTIME_NOT_FOUND',candidate:usable[0]??null,pathIsIdentity:false};
}

async function defaultVersionReader(path,environment){
  const {stdout='',stderr=''}=await execFile(path,['--version'],{windowsHide:true,timeout:10000,maxBuffer:16384,
    env:{SystemRoot:environment.SystemRoot,WINDIR:environment.WINDIR}});
  const match=`${stdout} ${stderr}`.match(VERSION);if(!match)throw Error('CODEX_VERSION_UNRECOGNIZED');return match[1];
}
async function defaultHashReader(path){return createHash('sha256').update(await readFile(path)).digest('hex');}

export async function discoverCodexRuntimeCandidates({environment=process.env,versionReader=defaultVersionReader,
  hashReader=defaultHashReader,maxPathEntries=64,maxCacheEntries=64}={}){
  const paths=[],seen=new Set(),add=value=>{if(typeof value!=='string'||!value)return;const key=canonical(value);if(!seen.has(key)){seen.add(key);paths.push(resolve(value));}};
  const executable=process.platform==='win32'?'codex.exe':'codex';
  for(const directory of String(environment.PATH??'').split(delimiter).filter(Boolean).slice(0,maxPathEntries))add(join(directory,executable));
  if(typeof environment.LOCALAPPDATA==='string'&&environment.LOCALAPPDATA){
    const root=join(environment.LOCALAPPDATA,'OpenAI','Codex','bin');add(join(root,executable));
    try{const entries=(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()).slice(0,maxCacheEntries);
      for(const entry of entries)add(join(root,entry.name,executable));}catch{}
  }
  const candidates=[];
  for(const path of paths){
    try{const info=await stat(path);if(!info.isFile())continue;const [version,sha256]=await Promise.all([versionReader(path,environment),hashReader(path)]);
      candidates.push({path,version,sha256,size:info.size,available:true});
    }catch{}
  }
  return candidates.sort((a,b)=>a.path.localeCompare(b.path));
}
