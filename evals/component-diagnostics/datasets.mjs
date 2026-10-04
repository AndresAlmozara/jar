import {sha256} from "../../packages/core/src/hash.js";

export const SUITES=Object.freeze([
  {id:"m8-operational-closure-v1",version:"1.0.0",module:"M8",contrast:"HIGH_CLOSURE/WIDE_INVENTORY versus LOW_CLOSURE/WIDE_INVENTORY"},
  {id:"m8-inventory-headroom-v1",version:"1.0.0",module:"M8",contrast:"HIGH_CLOSURE/WIDE_INVENTORY versus HIGH_CLOSURE/NARROW_INVENTORY"},
  {id:"m6-evidence-efficiency-v1",version:"1.0.0",module:"M6",contrast:"REFERENCE_V1 versus M6-r1 and the one qualified refinement"},
]);

const splitFor=index=>index<4?"development":index<6?"calibration":"evaluation-only";
const m6Families=[
  ["retry-delay","Bound retry delay to the configured ceiling","return Math.min(base ** attempt, ceiling)","Math.min"],
  ["config-merge","Preserve nested defaults when applying partial overrides","mergeNested(defaults, overrides)","mergeNested"],
  ["secret-redaction","Redact password and secret fields recursively","SENSITIVE_KEYS.has(key)","SENSITIVE_KEYS"],
  ["cache-expiry","Expire cached values using millisecond TTL units","now - savedAt <= ttlMs","ttlMs"],
  ["pagination-cursor","Advance the cursor only after accepting a page","cursor = response.nextCursor","nextCursor"],
  ["ledger-rounding","Round currency once at the settlement boundary","roundMoney(total)","roundMoney"],
  ["queue-dedupe","Deduplicate queued jobs by stable id before dispatch","seen.has(job.id)","seen.has"],
  ["negative-visible","Explain the current behavior without changing code","NO_CHANGE_REQUIRED","NO_CHANGE_REQUIRED"],
];
const paraphrases=["Implement the repair and verify it.","Fix the observed behavior without changing the public API.","Make the implementation satisfy the repository contract and tests."];

export const M6_CASES=Object.freeze(m6Families.flatMap(([family,need,implementation,needle],familyIndex)=>paraphrases.map((tail,variant)=>{
  const negative=family==="negative-visible";
  const implPath=`src/${family}.js`,testPath=`tests/${family}.test.js`;
  const late=`${"// unrelated setup\n".repeat(95)}\nexport function ${family.replaceAll("-","_")}(){ ${negative?"return true":implementation}; }\n`;
  const files=negative?{
    [implPath]:"export const documentedBehavior = true;\n",
    "README.md":"The requested behavior is already implemented. Inspect and explain; no repository evidence injection is necessary.\n",
    "docs/duplicate.md":"The requested behavior is already implemented. Inspect and explain; no repository evidence injection is necessary.\n",
  }:{
    [implPath]:late,
    [testPath]:`// contract evidence\n// expected implementation contains ${needle}\nexport const expected=${JSON.stringify(needle)};\n`,
    [`docs/${family}.md`]:`Contract: ${need}. This document is descriptive; executable source and tests are authoritative.\n`,
    "docs/misleading.md":"Legacy note: multiply delays and trust cached values indefinitely. This note is obsolete.\n",
  };
  if(familyIndex===6)files[`copies/${family}.js`]=late;
  const obligations=negative?[]:[
    {id:"implementation",alternatives:[{path:implPath,needle}]},
    {id:"contract",alternatives:[{path:testPath,needle},{path:`docs/${family}.md`,needle:need}]},
  ];
  return Object.freeze({id:`m6-${String(familyIndex+1).padStart(2,"0")}-${variant+1}`,family,variant,split:splitFor(familyIndex),
    task:`${need}. ${tail}`,files,obligations,alreadyVisible:variant===2?[`docs/${family}.md`]:[],negative,
    tags:[variant===0?"late-evidence":"paraphrase",familyIndex===6?"exact-duplicate":"complementary",negative?"no-retrieval-needed":"positive"]});
})));

const m8Families=["cache-repair","redaction-repair","migration-check","schema-repair","release-note","api-contract","permission-boundary","unknown-inventory"];
const conditionKinds=["precise","negated-control","investigation-discovery"];
export const M8_CASES=Object.freeze(m8Families.flatMap((family,familyIndex)=>conditionKinds.map((kind,variant)=>{
  const required=familyIndex===4?["workspace.inspect","documentation.modify"]:["workspace.inspect","workspace.modify","verification.execute"];
  return Object.freeze({id:`m8-${String(familyIndex+1).padStart(2,"0")}-${variant+1}`,family,variant,split:splitFor(familyIndex),kind,
    task:kind==="precise"?`Inspect the ${family} source, modify it, and execute verification.`:kind==="negated-control"?`Repair ${family}; do not publish, deploy, or merely inspect test history.`:`Repair ${family} according to repository requirements and confirm the result.`,
    requiredObligations:required,requiredScope:"diagnostic-workspace",unknownContract:familyIndex===7,wrongScope:familyIndex===6,
    tags:[kind,familyIndex===5?"and-requirements":"coverage",familyIndex===6?"wrong-scope":"valid-scope",familyIndex===7?"unknown":"complete"]});
})));

const jsPackage={"package.json":JSON.stringify({name:"diagnostic-product",private:true,type:"module",scripts:{test:"node --test",build:"node --check src/index.js"}},null,2)+"\n"};
export const PRODUCT_FAMILIES=Object.freeze({
  "m8-cache":{module:"M8",files:{...jsPackage,"README.md":"Cache entries use ttlMs in milliseconds. Repair src/index.js, preserve exports, and run tests.\n","src/index.js":"export function isFresh(savedAt,now,ttlMs){return now-savedAt<=ttlMs*1000}\n","index.test.js":"import test from 'node:test';import assert from 'node:assert/strict';import {isFresh} from './src/index.js';test('expires',()=>assert.equal(isFresh(0,1001,1000),false));\n"},
    high:"Inspect src/index.js, correct the millisecond TTL calculation, modify the implementation, and execute the tests.",low:"Fix the cache-expiry defect described by this repository and verify the repair.",gold:"now-savedAt<=ttlMs",knownGoodSource:"export function isFresh(savedAt,now,ttlMs){return now-savedAt<=ttlMs}\n"},
  "m8-redaction":{module:"M8",files:{...jsPackage,"README.md":"sanitize must recursively replace values whose key is token, password, or secret with [REDACTED]. Inspect, edit, and test the implementation.\n","src/index.js":"export function sanitize(value){if(Array.isArray(value))return value.map(sanitize);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='token'?'[REDACTED]':sanitize(v)]));return value}\n","index.test.js":"import test from 'node:test';import assert from 'node:assert/strict';import {sanitize} from './src/index.js';test('secrets',()=>assert.deepEqual(sanitize({password:'x',nested:{secret:'y'}}),{password:'[REDACTED]',nested:{secret:'[REDACTED]'}}));\n"},
    high:"Inspect the sanitizer, add recursive redaction for token, password, and secret keys, modify the source, and execute tests.",low:"Repair the sanitizer according to the repository contract and verify it.",gold:"['token','password','secret'].includes(k)",knownGoodSource:"const keys=new Set(['token','password','secret']);export function sanitize(value){if(Array.isArray(value))return value.map(sanitize);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,keys.has(k)?'[REDACTED]':sanitize(v)]));return value}\n"},
  "m6-retry":{module:"M6",files:{...jsPackage,"README.md":"Retry delays use exponential backoff capped by ceilingMs. The implementation and tests jointly define the behavior.\n","src/index.js":`${"// transport setup\n".repeat(90)}export function delay(attempt,base,ceilingMs){return Math.max(base**attempt,ceilingMs)}\n`,"index.test.js":"import test from 'node:test';import assert from 'node:assert/strict';import {delay} from './src/index.js';test('cap',()=>assert.equal(delay(5,2,10),10));\n","docs/legacy.md":"Old clients used a minimum delay floor; this is obsolete.\n"},task:"Repair the retry delay so exponential backoff never exceeds ceilingMs, preserve the API, and run tests.",gold:"Math.min(base**attempt,ceilingMs)",knownGoodSource:"export function delay(attempt,base,ceilingMs){return Math.min(base**attempt,ceilingMs)}\n"},
  "m6-merge":{module:"M6",files:{...jsPackage,"README.md":"applyConfig preserves nested defaults while applying partial nested overrides. Arrays replace rather than merge.\n","src/index.js":"export function applyConfig(defaults,overrides){return {...defaults,...overrides}}\n","index.test.js":"import test from 'node:test';import assert from 'node:assert/strict';import {applyConfig} from './src/index.js';test('nested',()=>assert.deepEqual(applyConfig({http:{timeout:10,retries:2}},{http:{timeout:20}}),{http:{timeout:20,retries:2}}));\n","src/helper.js":"export const isRecord=v=>v&&typeof v==='object'&&!Array.isArray(v);\n"},task:"Repair nested configuration merging, retain unoverridden defaults, replace arrays, and run tests.",gold:"recursive",knownGoodSource:"const record=v=>v&&typeof v==='object'&&!Array.isArray(v);export function applyConfig(defaults,overrides){if(!record(defaults)||!record(overrides))return overrides;const out={...defaults};for(const [key,value] of Object.entries(overrides))out[key]=record(value)&&record(defaults[key])?applyConfig(defaults[key],value):value;return out}\n"},
});

export const DATASET_IDENTITY=Object.freeze({m6:sha256(M6_CASES),m8:sha256(M8_CASES),products:sha256(PRODUCT_FAMILIES),suiteRegistry:sha256(SUITES)});
