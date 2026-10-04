import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import {BENCHMARKS,DEFAULT_BENCHMARK_ID,benchmarkById} from '../registry.mjs';
import {parseArgs as parseScenarioArgs} from '../../scenario-run.mjs';
import {parseArgs as parseCanonicalArgs} from '../../run.mjs';
import {canonicalRoot as replicationRoot} from '../storage.mjs';
import {createIterationIdentity} from '../iteration-identity.mjs';
import {assessBaseline,BASELINE_POLICIES} from '../baseline-policy.mjs';
import {generateComparison} from '../comparison.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','opsdesk-v1-replication');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'benchmark.json'),'utf8'));

test('registry exposes stable hard and soft benchmark identities',()=>{
  assert.equal(DEFAULT_BENCHMARK_ID,'opsdesk-hard-v2.4');
  assert.equal(BENCHMARKS['opsdesk-hard-v2.4'].role,'CANONICAL_DEVELOPMENT');
  assert.equal(BENCHMARKS['opsdesk-soft-v1'].role,'LEGACY_DIAGNOSTIC');
  assert.equal(BENCHMARKS['opsdesk-hard-v2.4'].baselineAcceptancePolicy,'CORRECT_PRODUCT');
  assert.equal(BENCHMARKS['opsdesk-soft-v1'].baselineAcceptancePolicy,'DIAGNOSTIC_REFERENCE');
  assert.equal(benchmarkById().benchmarkId,'opsdesk-hard-v2.4');
  assert.equal(benchmarkById('opsdesk-v2.4').benchmarkId,'opsdesk-hard-v2.4');
  assert.equal(benchmarkById('opsdesk-v1-replication').benchmarkId,'opsdesk-soft-v1');
  assert.throws(()=>benchmarkById('missing'),error=>error.code==='BENCHMARK_UNKNOWN');
});

test('scenario selector supports stable IDs while canonical CLI remains unchanged',()=>{
  assert.equal(parseScenarioArgs(['--jar']).benchmark,'opsdesk-hard-v2.4');
  assert.equal(parseScenarioArgs(['--benchmark','opsdesk-soft-v1','--jar']).benchmark,'opsdesk-soft-v1');
  assert.equal(parseScenarioArgs(['--benchmark','opsdesk-hard-v2.4','--jar']).benchmark,'opsdesk-hard-v2.4');
  assert.equal(parseCanonicalArgs(['--jar']).mode,'jar');
  assert.throws(()=>parseCanonicalArgs(['--benchmark','opsdesk-v1-replication','--jar']),error=>error.code==='ARGUMENT_INVALID');
});

test('historical manifest is diagnostic and records the Git source',()=>{
  assert.equal(manifest.benchmarkId,'opsdesk-soft-v1');
  assert.equal(manifest.sourceCommit,'5f0591d31f5833eb2e45b2db2219b616a8af4b3a');
  assert.equal(manifest.originalPath,'evals/product-trial/');
  assert.equal(manifest.canonical,false);
  assert.equal(manifest.developmentEval,false);
  assert.equal(manifest.historicalReplication,true);
  assert.equal(manifest.provenanceStatus,'HISTORICAL_BENCHMARK_PROVENANCE_PARTIAL');
  assert.equal(manifest.baselineAcceptancePolicy,'DIAGNOSTIC_REFERENCE');
  assert.equal(manifest.semantics.hiddenAcceptanceChecks,21);
  assert.equal(manifest.semantics.lifecycleActivity,false);
});

test('legacy storage cannot collide with canonical storage',()=>{
  const repo=path.parse(process.cwd()).root==='/'?'/repo':'C:\\repo';
  assert.match(replicationRoot(repo).replaceAll('\\','/'),/\.jar\/benchmarks\/replication\/opsdesk-v1$/);
  assert.notEqual(replicationRoot(repo),path.join(repo,'.jar','benchmarks','canonical'));
});

test('soft automatic identity includes benchmark and strategy identity',()=>{
  const identity=createIterationIdentity({code:{head:'1234567890abcdef',shortHead:'1234567890ab',dirty:false,dirtyFingerprint:'clean'},strategies:{m5:{id:'m5'},m6:{id:'m6'},m7:{id:'m7'},m8:{id:'m8'}},clock:()=>new Date('2026-01-01T00:00:00Z'),randomBytes:()=>Buffer.from('010203','hex')});
  assert.match(identity.runId,/^JAR_opsdesk-soft-v1_/);
  assert.match(identity.runLabel,/JAR · OpsDesk Soft/);
  assert.equal(identity.technical.benchmarkId,'opsdesk-soft-v1');
});

test('soft diagnostic baseline admits complete incorrect products but rejects incomplete evidence',()=>{
  const complete={status:'COMPLETED',mainModelTurnsStarted:1,session:{status:'completed'},evaluation:{build:{pass:true,exitCode:0},publicTests:{pass:true,exitCode:0},acceptance:{passed:20,total:21,checks:Array.from({length:21},(_,index)=>({name:String(index),pass:index<20}))},evaluatorPreservedProduct:true},correctness:{correct:false,status:'INCORRECT'},routing:{controlBypassedJar:true},telemetry:{mainModelUsage:{totalTokens:10,inputTokens:8,cachedInputTokens:4,outputTokens:2,reasoningOutputTokens:1},wallTimeMs:5,timings:{toolCalls:1,uniqueToolsUsed:1},runtimeMetadata:{codexRuntimeHash:'hash',baselineId:'proof'}}};
  assert.equal(assessBaseline(complete,BASELINE_POLICIES.DIAGNOSTIC_REFERENCE).admitted,true);
  assert.equal(assessBaseline(complete,BASELINE_POLICIES.CORRECT_PRODUCT).admitted,false);
  delete complete.telemetry.mainModelUsage.outputTokens;
  assert.equal(assessBaseline(complete,BASELINE_POLICIES.DIAGNOSTIC_REFERENCE).admitted,false);
});

test('cross-benchmark report keeps soft and hard rows separate without aggregation',()=>{
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),'opsdesk-matrix-'));
  const condition=(status,tokens,passed,total)=>({status:'COMPLETED',correctness:{status},evaluation:{build:{pass:true},publicTests:{pass:true},acceptance:{passed,total}},telemetry:{mainModelUsage:{totalTokens:tokens},wallTimeMs:10,timings:{toolCalls:2},jevUsage:null}});
  try{
    for(const [root,id,protocol,control,jar] of [
      ['.jar/benchmarks/replication/opsdesk-v1','CONTROL_soft','jar.opsdesk-soft-v1.v1',condition('INCORRECT',12,20,21),condition('CORRECT',9,21,21)],
      ['.jar/benchmarks/canonical','CONTROL_hard','jar.canonical-product-benchmark.v2.4',condition('CORRECT',20,35,35),condition('CORRECT',18,35,35)]
    ]){
      const base=path.join(repo,root,'baseline',id),latest=path.join(repo,root,'LATEST');fs.mkdirSync(base,{recursive:true});fs.mkdirSync(latest,{recursive:true});fs.writeFileSync(path.join(repo,root,'baseline','ACTIVE.json'),JSON.stringify({relativeDirectory:id}));fs.writeFileSync(path.join(base,'BASELINE.json'),JSON.stringify({baselineId:id,protocolVersion:protocol,control}));fs.writeFileSync(path.join(latest,'SUMMARY.json'),JSON.stringify({runId:`JAR_${id}`,jar}));
    }
    const report=generateComparison(repo);
    assert.deepEqual(report.benchmarks.map(row=>row.benchmarkId),['opsdesk-soft-v1','opsdesk-hard-v2.4']);
    assert.equal(report.aggregation,null);
    assert.equal(report.benchmarks[0].controlCorrectness.status,'INCORRECT');
    assert.equal(report.benchmarks[1].controlCorrectness.status,'CORRECT');
    assert.equal(report.benchmarks.every(row=>row.validWithinBenchmarkComparison),true);
    assert.doesNotMatch(fs.readFileSync(path.join(repo,'.jar/benchmarks/COMPARISON.html'),'utf8'),/compositeScore|winnerScore/);
  }finally{fs.rmSync(repo,{recursive:true,force:true});}
});

test('recovered starter retains original weak public tests and hidden verifier stays outside it',()=>{
  for(const name of ['domain','io','storage','ui'])assert.match(fs.readFileSync(path.join(root,'starter','tests',`${name}.test.ts`),'utf8'),/expect\(true\)\.toBe\(true\)/);
  assert.equal(fs.existsSync(path.join(root,'starter','evaluator')),false);
  assert.equal(fs.existsSync(path.join(root,'evaluator','acceptance-runner.mts')),true);
});

test('legacy TypeScript loader resolves valid bundler-style extensionless imports',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opsdesk-v1-loader-'));
  try{
    fs.writeFileSync(path.join(dir,'value.ts'),'export const value:number=42;');
    fs.writeFileSync(path.join(dir,'main.ts'),"import {value} from './value';if(value!==42)throw Error('bad');");
    const loader=path.join(root,'evaluator','typescript-loader.mjs');
    const result=spawnSync(process.execPath,['--experimental-loader',new URL(`file:///${loader.replaceAll('\\','/')}`).href,path.join(dir,'main.ts')],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
