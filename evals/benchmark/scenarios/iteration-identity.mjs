import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {BENCHMARK_ID,PROTOCOL_VERSION,sha} from './protocol.mjs';

const MATERIAL_PREFIXES=['evals/benchmark/scenario-run.mjs','evals/benchmark/scenarios/','evals/benchmark/lib/routing.mjs','evals/benchmark/lib/tools.mjs','evals/benchmark/lib/correctness.mjs','evals/_shared/','evals/smoke-test/lib/','packages/capability-exposure/','packages/repository-context/','packages/skill-routing/','packages/runtime-adapters/codex/src/assist-strategy.js','packages/runtime-adapters/src/contracts.js'];
const relevant=p=>MATERIAL_PREFIXES.some(prefix=>p===prefix||p.startsWith(prefix));
const git=(repo,args)=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8',maxBuffer:64*1024*1024});if(r.status!==0)throw Object.assign(Error('GIT_IDENTITY_UNAVAILABLE'),{code:'GIT_IDENTITY_UNAVAILABLE',stderr:r.stderr});return r.stdout;};

export function fingerprintMaterial({trackedDiff='',untracked=[]}={}){
  const records=[{kind:'tracked-diff',sha256:sha(trackedDiff)}];
  for(const item of [...untracked].sort((a,b)=>a.path.localeCompare(b.path)))records.push({kind:'untracked',path:item.path.replaceAll('\\','/'),sha256:sha(item.content)});
  return sha(JSON.stringify(records));
}

export function repositoryCodeIdentity(repo){
  const head=git(repo,['rev-parse','HEAD']).trim();
  const trackedDiff=git(repo,['diff','--binary','HEAD','--',...MATERIAL_PREFIXES]);
  const names=git(repo,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean).filter(relevant);
  const untracked=names.map(name=>({path:name,content:fs.readFileSync(path.join(repo,name))}));
  const dirtyFingerprint=fingerprintMaterial({trackedDiff,untracked});
  return{head,shortHead:head.slice(0,12),dirty:trackedDiff.length>0||untracked.length>0,dirtyFingerprint,materialPrefixes:MATERIAL_PREFIXES};
}

export function createIterationIdentity({code,strategies,annotation=null,clock=()=>new Date(),randomBytes=crypto.randomBytes}){
  const technical={benchmarkId:BENCHMARK_ID,protocolVersion:PROTOCOL_VERSION,code:{head:code.head,dirtyFingerprint:code.dirtyFingerprint},strategies};
  const fingerprint=sha(JSON.stringify(technical));
  const timestamp=clock().toISOString();
  const runSlug=`JAR_opsdesk-soft-v1_${code.shortHead}_${fingerprint.slice(0,12)}`;
  const runId=`${runSlug}_${timestamp.replace(/[:.]/g,'-')}_${randomBytes(3).toString('hex')}`;
  return{schemaVersion:'jar.benchmark-iteration-identity.v1',benchmarkId:BENCHMARK_ID,runId,runLabel:`JAR · OpsDesk Soft · M5 ${strategies.m5?.id} · M6 ${strategies.m6?.id} · M7 ${strategies.m7?.id} · M8 ${strategies.m8?.id} · Git ${code.shortHead}${code.dirty?` + dirty:${code.dirtyFingerprint.slice(0,10)}`:''}`,runSlug,codeIdentity:technical.code,strategyIdentity:strategies,benchmarkProtocolVersion:PROTOCOL_VERSION,annotation:annotation?String(annotation).slice(0,160):null,timestamp,fingerprint,technical};
}
