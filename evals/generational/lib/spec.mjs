import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const EVAL_ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT=path.resolve(EVAL_ROOT,'../..');
export const RESULT_STATUSES=Object.freeze(['PASS','FAIL','NOT_IMPLEMENTED','NOT_APPLICABLE','INFRA_FAILURE']);
export const PROVENANCE_CATEGORIES=Object.freeze(['NEW_INDEPENDENT','PRIOR_DEVELOPMENT','PRIOR_CAMPAIGN','SYNTHETIC_CONTRACT','ORACLE_FIXTURE']);
export const SPLITS=Object.freeze(['development','calibration','reserved','contract']);
export const MODULES=Object.freeze(['M5','M6','M7','M8']);
export const LEVELS=Object.freeze(['L0','L1','L2']);

const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
export const canonicalJson=value=>JSON.stringify(canonical(value));
export const hashValue=value=>sha(canonicalJson(value));
export const hashFile=file=>sha(fs.readFileSync(file));

function assert(condition,code,details={}){if(!condition)throw Object.assign(Error(code),{code,details});}
function string(value,label){assert(typeof value==='string'&&value.length>0,'GENERATIONAL_SPEC_STRING_INVALID',{label});return value;}
function strings(value,label,{allowEmpty=true}={}){
  assert(Array.isArray(value)&&(allowEmpty||value.length>0)&&value.every(item=>typeof item==='string'&&item),'GENERATIONAL_SPEC_STRING_ARRAY_INVALID',{label});
  assert(new Set(value).size===value.length,'GENERATIONAL_SPEC_DUPLICATE_VALUE',{label});return value;
}
function uniqueRows(rows,label){assert(Array.isArray(rows),'GENERATIONAL_SPEC_ROWS_INVALID',{label});const ids=new Set();for(const row of rows){string(row?.id,`${label}.id`);assert(!ids.has(row.id),'GENERATIONAL_SPEC_DUPLICATE_ID',{label,id:row.id});ids.add(row.id);}return ids;}

export function deterministicSplit(id,seed){
  const bucket=Number.parseInt(sha(`${seed}:${id}`).slice(0,8),16)%100;
  return bucket<50?'development':bucket<75?'calibration':'reserved';
}

function validateM5(label){
  strings(label.acceptablePrimarySkills,'M5.acceptablePrimarySkills');strings(label.requiredSupportingSkills,'M5.requiredSupportingSkills');
  strings(label.allowedSupportingSkills,'M5.allowedSupportingSkills');strings(label.requiredCandidateSkills,'M5.requiredCandidateSkills');
  assert(label.primarySkill===null||typeof label.primarySkill==='string','GENERATIONAL_M5_PRIMARY_INVALID',{id:label.id});
  assert(typeof label.abstained==='boolean','GENERATIONAL_M5_ABSTENTION_INVALID',{id:label.id});
  if(label.explicitSkills!==undefined)strings(label.explicitSkills,'M5.explicitSkills');
  assert(label.requiredSupportingSkills.every(id=>label.allowedSupportingSkills.includes(id)),'GENERATIONAL_M5_SUPPORT_GOLD_INVALID',{id:label.id});
}
function normalizeSet(value,label){return [...strings(value,label,{allowEmpty:true})].sort();}
function validateM6(label){
  strings(label.requiredCandidates,'M6.requiredCandidates');assert(Array.isArray(label.acceptableSelectedSets)&&label.acceptableSelectedSets.length>0,'GENERATIONAL_M6_ALTERNATIVES_INVALID',{id:label.id});
  const keys=label.acceptableSelectedSets.map((set,index)=>canonicalJson(normalizeSet(set,`M6.acceptableSelectedSets.${index}`)));
  assert(new Set(keys).size===keys.length,'GENERATIONAL_M6_DUPLICATE_ALTERNATIVE',{id:label.id});strings(label.requiredMaterialized,'M6.requiredMaterialized');
}
function validateM7(label){strings(label.requiredProperties,'M7.requiredProperties',{allowEmpty:false});}
function validateM8(label,fixture){
  strings(label.semanticObligations,'M8.semanticObligations',{allowEmpty:false});assert(Array.isArray(label.sufficientSets)&&label.sufficientSets.length>0,'GENERATIONAL_M8_ALTERNATIVES_INVALID',{id:label.id});
  const known=new Set(fixture.input.capabilities.map(item=>item.id)),seen=new Set();
  for(const [index,set] of label.sufficientSets.entries()){
    const normalized=normalizeSet(set,`M8.sufficientSets.${index}`),key=canonicalJson(normalized);assert(!seen.has(key),'GENERATIONAL_M8_DUPLICATE_ALTERNATIVE',{id:label.id});seen.add(key);
    assert(normalized.every(id=>known.has(id)),'GENERATIONAL_M8_UNKNOWN_CAPABILITY',{id:label.id,index});
  }
  strings(label.indispensable,'M8.indispensable');strings(label.policyForbidden,'M8.policyForbidden');
  assert(Array.isArray(label.invalidSets),'GENERATIONAL_M8_INVALID_SETS_INVALID',{id:label.id});for(const set of label.invalidSets)normalizeSet(set,'M8.invalidSets');
}

export function validateDataset({manifest,fixtures,gold}){
  assert(manifest?.schemaVersion==='jar.generational-mechanism-spec.v1','GENERATIONAL_MANIFEST_VERSION_INVALID');
  assert(fixtures?.schemaVersion==='jar.generational-mechanism-fixtures.v1','GENERATIONAL_FIXTURE_VERSION_INVALID');
  assert(gold?.schemaVersion==='jar.generational-mechanism-gold.v1','GENERATIONAL_GOLD_VERSION_INVALID');
  const fixtureIds=uniqueRows(fixtures.rows,'fixtures'),goldIds=uniqueRows(gold.labels,'gold');
  assert(fixtureIds.size===goldIds.size&&[...fixtureIds].every(id=>goldIds.has(id)),'GENERATIONAL_FIXTURE_GOLD_MISMATCH');
  const byFixture=new Map(fixtures.rows.map(row=>[row.id,row]));
  for(const row of fixtures.rows){
    assert(MODULES.includes(row.module),'GENERATIONAL_MODULE_INVALID',{id:row.id,module:row.module});strings(row.levels,`${row.id}.levels`,{allowEmpty:false});assert(row.levels.every(level=>LEVELS.includes(level)),'GENERATIONAL_LEVEL_INVALID',{id:row.id});
    assert(SPLITS.includes(row.split),'GENERATIONAL_SPLIT_INVALID',{id:row.id,split:row.split});assert(PROVENANCE_CATEGORIES.includes(row.provenance),'GENERATIONAL_PROVENANCE_INVALID',{id:row.id});string(row.task,`${row.id}.task`);
    if(row.split!=='contract')assert(row.split===deterministicSplit(row.id,manifest.splitPolicy.seed),'GENERATIONAL_SPLIT_ASSIGNMENT_INVALID',{id:row.id,expected:deterministicSplit(row.id,manifest.splitPolicy.seed),actual:row.split});
  }
  for(const label of gold.labels){const fixture=byFixture.get(label.id);assert(label.module===fixture.module,'GENERATIONAL_MODULE_MISMATCH',{id:label.id});if(label.module==='M5')validateM5(label);else if(label.module==='M6')validateM6(label);else if(label.module==='M7')validateM7(label);else validateM8(label,fixture);}
  assert(Array.isArray(manifest.l0Contracts)&&manifest.l0Contracts.length>0,'GENERATIONAL_L0_EMPTY');uniqueRows(manifest.l0Contracts,'l0Contracts');
  return true;
}

const manifestCore=manifest=>{const copy=structuredClone(manifest);delete copy.freeze;return copy;};
export function computeIdentity({manifest,fixtures,gold}){
  const codeFiles=manifest.identityInputs.evaluatorFiles.map(relative=>path.resolve(REPO_ROOT,relative));
  const evaluatorFiles=codeFiles.map((file,index)=>({path:manifest.identityInputs.evaluatorFiles[index],sha256:hashFile(file)}));
  const evaluatorHash=hashValue(evaluatorFiles),fixtureHash=hashValue(fixtures),goldHash=hashValue(gold);
  const adapterHashes=Object.fromEntries(Object.entries(manifest.generations).map(([id,profile])=>[id,hashValue({adapterFile:hashFile(path.resolve(REPO_ROOT,profile.adapterFile)),profile})]));
  const specHash=hashValue({manifest:manifestCore(manifest),fixtureHash,goldHash,evaluatorHash,adapterHashes,jevModel:manifest.jevModel});
  return{specId:manifest.specId,specHash,fixtureHash,goldHash,evaluatorHash,adapterHashes,jevModel:manifest.jevModel};
}

export function loadFrozenSpec({verifyFreeze=true}={}){
  const manifest=readJson(path.join(EVAL_ROOT,'spec.json')),fixtures=readJson(path.join(EVAL_ROOT,'fixtures.json')),gold=readJson(path.join(EVAL_ROOT,'gold.json'));
  validateDataset({manifest,fixtures,gold});const identity=computeIdentity({manifest,fixtures,gold});
  if(verifyFreeze)for(const key of ['specHash','fixtureHash','goldHash','evaluatorHash'])assert(manifest.freeze?.[key]===identity[key],'GENERATIONAL_FREEZE_MISMATCH',{key,expected:manifest.freeze?.[key],actual:identity[key]});
  if(verifyFreeze)assert(canonicalJson(manifest.freeze?.adapterHashes)===canonicalJson(identity.adapterHashes),'GENERATIONAL_ADAPTER_FREEZE_MISMATCH',{expected:manifest.freeze?.adapterHashes,actual:identity.adapterHashes});
  return{manifest,fixtures,gold,identity};
}

export function datasetSummary(spec){
  const countBy=key=>Object.fromEntries([...new Set(spec.fixtures.rows.map(row=>row[key]))].sort().map(value=>[value,spec.fixtures.rows.filter(row=>row[key]===value).length]));
  return{fixtures:spec.fixtures.rows.length,goldLabels:spec.gold.labels.length,provenance:countBy('provenance'),splits:countBy('split'),modules:countBy('module'),l0Contracts:spec.manifest.l0Contracts.length};
}
