import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../run.mjs';
import {json,redactor} from '../lib/common.mjs';
import {runCondition,preflightFixture,checkLifecycleContract,verifyFixture} from '../lib/bridge.mjs';
import {executeConditions,schedule} from '../lib/orchestrator.mjs';
import {makePairs} from '../lib/report.mjs';
import {temporary,fakeJar} from './helpers.mjs';
const config={...json(path.join(ROOT,'config/diagnostic.json')),model:'mock-model'};
async function withFake(options,fn){const temp=temporary();try{const d=fakeJar({root:ROOT,temp,...options});return await fn(d,temp);}finally{fs.rmSync(temp,{recursive:true,force:true});}}
const args=temp=>({repo:temp,root:ROOT,task:'03-capability-exposure',condition:'JAR',dir:path.join(temp,'evidence'),scrub:redactor(),config,idleOptions:{delayMs:0}});
test('Lifecycle contract accepts persistent infrastructure and rejects real sessions',()=>withFake({},async d=>{await checkLifecycleContract(d);assert.equal(d.metrics.executors,0);}));
test('CONTROL rejects JEV strategy contamination before main-model startup',()=>withFake({},async(d,temp)=>{
  const original=d.prepareOwnedInputs;d.prepareOwnedInputs=async(...a)=>{const p=await original(...a);p.surfaces.capabilities.strategy='capability/jev-selective-v1';return p;};
  const r=await runCondition(d,{...args(temp),condition:'CONTROL'});assert.equal(r.outcome,'INFRA_FAIL');assert.equal(d.metrics.models,0);assert.equal(d.metrics.executors,0);
}));
test('JAR rejects absent real decision evidence before main-model startup',()=>withFake({},async(d,temp)=>{
  const original=d.prepareOwnedInputs;d.prepareOwnedInputs=async(h,o)=>original(h,{...o,telemetry:{append(){}}});
  const r=await runCondition(d,{...args(temp),condition:'JAR'});assert.equal(r.outcome,'INFRA_FAIL');assert.equal(d.metrics.models,0);
}));
test('Preflight uses real preparation/staging interfaces but no model or VM',()=>withFake({},async(d,temp)=>{const r=await preflightFixture(d,args(temp));assert.equal(r.status,'READY');assert.equal(d.metrics.models,0);assert.equal(d.metrics.executors,0);assert.equal(d.metrics.verifiers,0);}));
test('PASS requires a completed model, settled executor, fresh verifier and matching details',()=>withFake({},async(d,temp)=>{const r=await runCondition(d,args(temp));assert.equal(r.outcome,'PASS',JSON.stringify(r.error));assert.equal(r.mainModelTurnsStarted,1);assert.equal(r.verifierDetails.pass,true);assert.equal(r.mainModelUsage.totalTokens,30);}));
test('Broken output with valid hidden verification is functional FAIL',()=>withFake({result:'FAIL'},async(d,temp)=>{const r=await runCondition(d,args(temp));assert.equal(r.outcome,'FAIL',JSON.stringify(r.error));assert.equal(r.verifierDetails.kind,'functional');}));
test('Model error is INFRA_FAIL and verifier does not run',()=>withFake({modelBehavior:'failed-turn'},async(d,temp)=>{const r=await runCondition(d,args(temp));assert.equal(r.outcome,'INFRA_FAIL');assert.equal(d.metrics.verifiers,0);assert.equal(r.error.code,'TURN_NOT_COMPLETED');}));
test('Verifier bootstrap exception is INFRA_FAIL, never functional FAIL',()=>withFake({verifierThrow:true},async(d,temp)=>{const r=await runCondition(d,args(temp));assert.equal(r.outcome,'INFRA_FAIL');assert.equal(r.error.code,'VERIFIER_BOOTSTRAP_NOT_OBSERVED');}));
test('Missing verifier detail blocks classification',()=>withFake({missingDetails:true},async(d,temp)=>{const r=await runCondition(d,args(temp));assert.equal(r.outcome,'INFRA_FAIL');assert.equal(r.error.code,'VERIFIER_DETAIL_MISSING');}));
test('Unsettled executor prevents verifier startup',()=>withFake({unsettled:true},async(d,temp)=>{const r=await runCondition(d,args(temp));assert.equal(r.outcome,'INFRA_FAIL');assert.equal(d.metrics.verifiers,0);}));
test('Post-run busy state invalidates result and stops progression',()=>withFake({postIdleFail:true},async(d,temp)=>{const r=await runCondition(d,args(temp));assert.equal(r.outcome,'INFRA_FAIL');assert.equal(r.error.code,'SANDBOX_POST_RUN_NOT_IDLE');}));
test('Receipt and log exclude the OAuth token',()=>withFake({},async(d,temp)=>{await runCondition(d,args(temp));for(const rel of ['receipt.json','events.jsonl'])assert(!fs.readFileSync(path.join(temp,'evidence',rel),'utf8').includes('FAKE_PRIVATE_TOKEN_NEVER_LOG'));}));
test('Mapping is derived from descriptors even in deliberately shuffled order',()=>withFake({},async(d,temp)=>{const r=await runCondition(d,args(temp));assert.equal(r.plan.capabilityMapping[0].toolName,'workspace_write');assert.equal(r.plan.capabilityMapping[0].capabilityId,'id-workspace_write');}));
test('All ten conditions through bridge + real canonical fixtures + real verifiers',()=>withFake({},async(d,temp)=>{
  const runs=[];
  await executeConditions(schedule(config.tasks),{run:async item=>runCondition(d,{...args(temp),task:item.task,condition:item.condition,dir:path.join(temp,item.task,item.condition)}),onResult:async r=>runs.push(r)});
  assert.equal(runs.length,10);assert(runs.every(r=>r.outcome==='PASS'));assert.equal(d.metrics.models,10);assert.equal(d.metrics.executors,10);assert.equal(d.metrics.verifiers,10);
  const pairs=makePairs(config.tasks,runs);assert(pairs.every(p=>p.validPair));assert.equal(pairs[3].diagnostic,'M7_SHADOW_ONLY_NOT_CAUSAL');
}));
