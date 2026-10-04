import test from 'node:test';
import assert from 'node:assert/strict';
import {usageFromSnapshots,estimatedCreditEquivalent,comparableElapsedMs,decidePromotion} from './decision.mjs';

const policy={maxAdditionalJevUsdPerScenarioRun:.01,maxCumulativeRegressionPercent:5};
const checks=[{name:'a',pass:true},{name:'b',pass:true}];
const run=(scenario,extra={})=>({scenario,sessionStatus:'completed',infrastructureAnomaly:false,evaluationValid:true,buildPass:true,
  publicTestsPass:true,compatible:true,mechanismObserved:true,policyViolations:[],correctness:'CORRECT',checks,credits:100,elapsedMs:100000,jevUsd:.001,...extra});
const request=(overrides={})=>({goal:{type:'CORRECTNESS_ROBUSTNESS',independentRegression:{incumbentFails:true,candidatePasses:true}},
  scenarios:Object.fromEntries(['soft','hard'].map(s=>[s,{incumbent:run(s),candidate:run(s),origin:run(s)}])),budget:{exhausted:false},policy,...overrides});

test('rejects wrong product/scenario',()=>assert.equal(decidePromotion(request({scenarios:{...request().scenarios,soft:{...request().scenarios.soft,candidate:run('hard')}}})).code,'WRONG_PRODUCT_OR_SCENARIO'));
test('blocks incomplete session',()=>assert.equal(decidePromotion(request({scenarios:{...request().scenarios,soft:{...request().scenarios.soft,candidate:run('soft',{sessionStatus:'failed'})}}})).code,'SESSION_INCOMPLETE_OR_ANOMALOUS'));
test('missing cache blocks credit evidence',()=>assert.equal(estimatedCreditEquivalent({inputTokens:10,outputTokens:2},{uncachedInput:100,cachedInput:10,output:500}),null));
test('deduplicates cumulative usage snapshots instead of summing them',()=>{
  const usage=usageFromSnapshots([{threadId:'t',turnId:'x',total:{totalTokens:10,inputTokens:8,cachedInputTokens:4,outputTokens:2}},
    {threadId:'t',turnId:'x',total:{totalTokens:15,inputTokens:12,cachedInputTokens:8,outputTokens:3}}]);assert.equal(usage.totalTokens,15);
});
test('same passed count with a different failure rejects',()=>{
  const candidate=run('soft',{checks:[{name:'a',pass:false},{name:'b',pass:true},{name:'c',pass:true}]});
  assert.equal(decidePromotion(request({scenarios:{...request().scenarios,soft:{...request().scenarios.soft,candidate}}})).code,'PROTECTED_CHECK_REGRESSION');
});
test('stale control compatibility blocks',()=>assert.equal(decidePromotion(request({scenarios:{...request().scenarios,hard:{...request().scenarios.hard,candidate:run('hard',{compatible:false})}}})).code,'BASELINE_INCOMPATIBLE'));
test('one-scenario regression rejects even when the other improves',()=>{
  const scenarios=request().scenarios;scenarios.soft.candidate=run('soft',{credits:90});scenarios.hard.candidate=run('hard',{credits:106});
  assert.equal(decidePromotion(request({goal:{type:'CREDIT'},scenarios})).code,'CUMULATIVE_ORIGIN_REGRESSION');
});
test('exhausted budget checkpoints before evaluating results',()=>assert.equal(decidePromotion(request({budget:{exhausted:true}})).status,'CHECKPOINTED_BUDGET'));
test('derives routing-through-verification elapsed time from telemetry clock origin',()=>{
  const result=comparableElapsedMs([{timestamp:'2026-01-01T00:00:01.000Z',elapsed_ms:1000}], '2026-01-01T00:00:10.000Z');assert.equal(result.elapsedMs,10000);
});
