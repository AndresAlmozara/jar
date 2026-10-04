import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROTOCOL_VERSION='jar.opsdesk-soft-v1.v1';
export const BENCHMARK_ID='opsdesk-soft-v1';
export const MODEL='gpt-5.6-sol';
export const REASONING_EFFORT='medium';

export const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export const normalizedRelative=(root,file)=>path.relative(root,file).replaceAll('\\','/');

export function hashFiles(root,files){
  const rows=files.map(file=>{
    const absolute=path.resolve(root,file);
    if(!absolute.startsWith(path.resolve(root)+path.sep)||!fs.statSync(absolute).isFile())throw Object.assign(Error('BENCHMARK_IDENTITY_FILE_INVALID'),{code:'BENCHMARK_IDENTITY_FILE_INVALID',file});
    return{path:normalizedRelative(root,absolute),sha256:sha(fs.readFileSync(absolute))};
  }).sort((a,b)=>a.path.localeCompare(b.path));
  return{sha256:sha(JSON.stringify(rows)),files:rows};
}

export function stableRuntimeIdentity(runtime={}){
  const selection=runtime.modelSelection??{},entry=selection.catalogEntry??{},toolProfile=selection.toolProfile??{};
  const sorted=value=>Array.isArray(value)?[...value].sort():value??null;
  return{runtimeVersion:runtime.runtimeVersion??null,runtimeHash:runtime.runtimeHash??null,nativeBaselineVerified:typeof runtime.nativeBaselineId==='string'&&runtime.nativeBaselineId.length>0,
    modelSelection:{model:selection.model??null,effort:selection.effort??null,reason:selection.reason??null,catalogSource:selection.catalogSource??null,
      catalogEntry:{model:entry.model??null,visible:entry.visible??null,retired:entry.retired??null,efforts:sorted(entry.efforts),inputModalities:sorted(entry.inputModalities)},
      toolProfile:{hash:toolProfile.hash??null,overrides:toolProfile.overrides??null},accessVerifiedByInference:selection.accessVerifiedByInference??null,extraRealInferenceCalls:selection.extraRealInferenceCalls??null}};
}

export function compatibilityEnvelope({fixture,task,publicTests,hiddenVerifier,deterministicSeeds,calibration,harness,frozenDependencySeed,cleanReplayContract,runtime,model=MODEL,reasoningEffort=REASONING_EFFORT,isolation}){
  return{schemaVersion:'jar.benchmark-control-compatibility.v1',benchmarkId:BENCHMARK_ID,protocolVersion:PROTOCOL_VERSION,fixture,task,publicTests,hiddenVerifier,deterministicSeeds,calibration,harness,frozenDependencySeed,cleanReplayContract,runtime:stableRuntimeIdentity(runtime),model,reasoningEffort,isolation};
}

function differences(expected,actual,prefix='',out=[]){
  if(expected===actual)return out;
  if(expected===null||actual===null||typeof expected!=='object'||typeof actual!=='object'){out.push({field:prefix||'$',expected,actual});return out;}
  if(Array.isArray(expected)||Array.isArray(actual)){
    if(!Array.isArray(expected)||!Array.isArray(actual)){out.push({field:prefix||'$',expected,actual});return out;}
    if(expected.length!==actual.length)out.push({field:`${prefix}.length`,expected:expected.length,actual:actual.length});
    for(let index=0;index<Math.min(expected.length,actual.length);index++)differences(expected[index],actual[index],`${prefix}[${index}]`,out);
    return out;
  }
  const keys=[...new Set([...Object.keys(expected),...Object.keys(actual)])].sort();
  for(const key of keys)differences(expected[key],actual[key],prefix?`${prefix}.${key}`:key,out);
  return out;
}

export function compareCompatibility(expected,actual){const mismatches=differences(expected,actual);return{compatible:mismatches.length===0,mismatches};}

export function assertCompatible(expected,actual){const result=compareCompatibility(expected,actual);if(!result.compatible)throw Object.assign(Error('CONTROL_BASELINE_STALE'),{code:'CONTROL_BASELINE_STALE',details:result});return result;}
