import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {redactor,atomic,json,treeHash,acquireLock,DiagnosticError} from '../lib/common.mjs';
import {normalizeNoulQuestions,compatibleClient} from '../lib/typesafe-compat.mjs';
import {runModelTurn} from '../lib/model-session.mjs';
import {schedule,executeConditions} from '../lib/orchestrator.mjs';
import {makePairs,renderReport,publish} from '../lib/report.mjs';
import {temporary,mockTransport} from './helpers.mjs';
import {benchmarkResultsRoot,parseArgs} from '../run.mjs';
import {TypeSafeClient} from '../../../packages/decision-providers/jev/src/typesafe-client.js';
const tasks=Array.from({length:5},(_,i)=>({task_id:String(i+1).padStart(2,'0'),order:i%2?'JAR_FIRST':'CONTROL_FIRST'}));
const baseThread={cwd:'C:/owned/workspace',model:'fixed-model',modelProvider:'jar_live',approvalPolicy:'never'};
async function turn(behavior='complete',opts={}){
  const t=mockTransport({thread:baseThread,behavior,...opts});
  const result=await runModelTurn({transport:t,thread:baseThread,inputs:[{text:'test'}],dynamicTools:[{name:'workspace_read'}],executeTool:async()=>({success:true}),emit:()=>{},scrub:redactor(),timeoutMs:100,rpcTimeoutMs:50,toolTimeoutMs:50,...opts});return {t,result};
}
test('Noul string repair is non-mutating and preserves YES wording',()=>{const raw={decision:{type:'noul',instructions:'Q',criteria:'Useful supporting work'}};
 const x=normalizeNoulQuestions(raw);assert.equal(raw.decision.criteria,'Useful supporting work');assert.deepEqual(x.questions.decision.criteria,{true:'Useful supporting work'});assert.equal(x.repairs,1);});
test('Valid Noul object remains unchanged',()=>{const raw={q:{type:'noul',criteria:{true:'yes',false:'no'}}};assert.deepEqual(normalizeNoulQuestions(raw),{questions:raw,repairs:0});});
test('Choice and Score are not rewritten',()=>{const raw={c:{type:'choice',criteria:{x:'x'}},s:{type:'score',criteria:['low','high']}};assert.deepEqual(normalizeNoulQuestions(raw),{questions:raw,repairs:0});});
test('Adapter crosses an object-only mock provider, unlike the old string request',async()=>{
 class Base {constructor(){this.model='test';}async systemOne(x){if(typeof x.questions.q.criteria!=='object')throw Error('422');return {model:'test',answers:{q:{type:'noul',noul:1}},usage:{input_tokens:1,output_tokens:1}};}}
 await assert.rejects(()=>new Base().systemOne({questions:{q:{type:'noul',criteria:'x'}}}),/422/);
 const {client}=compatibleClient(Base,{emit:()=>{},scrub:redactor()});assert.equal((await client.systemOne({questions:{q:{type:'noul',criteria:'x'}}})).answers.q.noul,1);
});
test('Active routing compatibility wrapper preserves the exact admitted JEV model pin',()=>{
 const {client}=compatibleClient(TypeSafeClient,{emit:()=>{},scrub:redactor(),fetchImpl:async()=>{throw Error('MUST_NOT_CALL');}});
 assert.equal(client.model,'jev-1.13.0');
});
test('Secret values, JWTs, Bearer headers and named credential fields are redacted',()=>{const s=redactor();s.add('EXACT_PRIVATE_VALUE');const x=s.clean({message:'EXACT_PRIVATE_VALUE Bearer abcdefghi',access_token:'secret',refreshToken:'secret',usage:{input_tokens:21}});
 assert(!JSON.stringify(x).includes('EXACT_PRIVATE_VALUE'));assert.equal(x.access_token,'[REDACTED]');assert.equal(x.refreshToken,'[REDACTED]');assert.equal(x.usage.input_tokens,21);});
test('Schedule has exactly 10 conditions in the accepted counterbalanced order',()=>assert.deepEqual(schedule(tasks).map(x=>x.condition),['CONTROL','JAR','JAR','CONTROL','CONTROL','JAR','JAR','CONTROL','CONTROL','JAR']));
test('All 10 simulated conditions complete',async()=>{let calls=0;const r=await executeConditions(schedule(tasks),{run:async()=>{calls++;return {outcome:'PASS'};}});assert.equal(calls,10);assert.equal(r.length,10);});
test('Functional FAIL continues through all 10',async()=>{let calls=0;await executeConditions(schedule(tasks),{run:async()=>{calls++;return {outcome:'FAIL'};}});assert.equal(calls,10);});
test('First INFRA_FAIL stops immediately and retains that result',async()=>{let calls=0,saved=[];await assert.rejects(()=>executeConditions(schedule(tasks),{run:async()=>({outcome:++calls===2?'INFRA_FAIL':'PASS'}),onResult:async x=>saved.push(x)}),/INFRA_FAIL_STOP/);assert.equal(calls,2);assert.equal(saved.length,2);});
test('Thrown run error is persisted as INFRA_FAIL and not retried',async()=>{let calls=0,saved=[];await assert.rejects(()=>executeConditions(schedule(tasks),{run:async()=>{calls++;throw Error('provider down');},onResult:async r=>saved.push(r)}),/INFRA_FAIL_STOP/);assert.equal(calls,1);assert.equal(saved[0].outcome,'INFRA_FAIL');});
test('Pre-run gate failure starts no model',async()=>{let calls=0;await assert.rejects(()=>executeConditions(schedule(tasks),{before:async()=>{throw Error('busy');},run:async()=>{calls++;return {outcome:'PASS'};}}),/busy/);assert.equal(calls,0);});
test('Post-run gate failure prevents next condition',async()=>{let calls=0;await assert.rejects(()=>executeConditions(schedule(tasks),{run:async()=>{calls++;return {outcome:'PASS'};},after:async()=>{throw Error('source changed');}}),/source changed/);assert.equal(calls,1);});
test('Cancellation before a condition starts no model',async()=>{let calls=0;await assert.rejects(()=>executeConditions(schedule(tasks),{cancelled:()=>true,run:async()=>{calls++;}}),/USER_INTERRUPTED/);assert.equal(calls,0);});
test('Completed turn retains observed usage and cleans runtime',async()=>{const {t,result}=await turn();assert.equal(result.status,'completed');assert.equal(result.usage.totalTokens,30);assert.equal(t.closed,1);assert.equal(result.verifierStatus,'not_run_by_model_driver');});
test('Failed provider turn is infrastructure, never functional FAIL',async()=>{const {result}=await turn('failed-turn');assert.equal(result.status,'infra_fail');assert.equal(result.failure.code,'TURN_NOT_COMPLETED');assert.equal(result.failure.details.turn.error.message,'provider denied');});
test('RPC provider error preserves original message',async()=>{const {result}=await turn('rpc-fail');assert.equal(result.failure.code,'APP_SERVER_RPC_FAILED');assert.match(result.failure.details.error.message,/Unauthorized/);});
test('Changed effective security profile is rejected',async()=>{const {result}=await turn('mismatch');assert.equal(result.failure.code,'EFFECTIVE_THREAD_MISMATCH');});
test('Unexpected approval is rejected, not auto-approved',async()=>{const {result}=await turn('approval');assert.equal(result.failure.code,'HUMAN_APPROVAL_REQUIRED');});
test('Undeclared dynamic tool is rejected',async()=>{let calls=0;const {result}=await turn('complete',{tools:[{name:'not_exposed'}],executeTool:async()=>{calls++;}});assert.equal(result.status,'infra_fail');assert.equal(calls,0);});
test('Parallel tool requests are executed sequentially',async()=>{let active=0,maximum=0,calls=0;
 const {result}=await turn('complete',{tools:[{name:'workspace_read'},{name:'workspace_read'}],executeTool:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,4));active--;calls++;return {success:true};}});
 assert.equal(result.status,'completed');assert.equal(calls,2);assert.equal(maximum,1);
});
test('Model timeout is bounded and runtime is disposed',async()=>{const {result,t}=await turn('stall',{timeoutMs:20});assert.equal(result.failure.code,'MODEL_TURN_TIMEOUT');assert.equal(t.closed,1);});
test('Cleanup failure invalidates completed model turn',async()=>{const {result}=await turn('complete',{cleanup:false});assert.equal(result.failure.code,'MODEL_CLEANUP_UNSETTLED');});
test('Startup failure is captured and disposed',async()=>{const {result,t}=await turn('start-fail');assert.equal(result.status,'infra_fail');assert.equal(t.closed,1);});
test('No verification deadline survives the model turn',async()=>{const {result}=await turn('complete',{timeoutMs:20});await new Promise(r=>setTimeout(r,35));assert.equal(result.status,'completed');assert.equal(result.verifierStatus,'not_run_by_model_driver');});
test('Early-failure report exists before a condition or log exists',()=>{const temp=temporary();try{const run=path.join(temp,'RUN');publish(run,temp,{status:'BLOCKED',pairs:[],runs:[],error:{code:'AUTH'},startedAt:'test'});assert(fs.existsSync(path.join(temp,'LATEST/RESULT.html')));assert.equal(json(path.join(temp,'LATEST/SUMMARY.json')).status,'BLOCKED');assert(fs.existsSync(path.join(temp,'LATEST/run.log')));}finally{fs.rmSync(temp,{recursive:true,force:true});}});
test('LATEST contains only artifacts from the current publication',()=>{const temp=temporary();try{const latest=path.join(temp,'LATEST');fs.mkdirSync(latest);fs.writeFileSync(path.join(latest,'stale.txt'),'old');publish(path.join(temp,'RUN'),temp,{status:'STARTING',pairs:[],runs:[],startedAt:'test'});assert.deepEqual(fs.readdirSync(latest).sort(),['RESULT.html','SUMMARY.json','run.log']);}finally{fs.rmSync(temp,{recursive:true,force:true});}});
test('Report escapes error HTML',()=>assert(!renderReport({status:'<script>bad</script>',pairs:[],runs:[]}).includes('<script>bad</script>')));
test('Atomic JSON handles paths with spaces and Unicode',()=>{const temp=temporary();try{const f=path.join(temp,'Español con espacios','file.json');atomic(f,{ok:true});assert.deepEqual(json(f),{ok:true});}finally{fs.rmSync(temp,{recursive:true,force:true});}});
test('Canonical orchestration routes generated results outside eval source',()=>{const repo=path.resolve('C:/repository with spaces');assert.equal(benchmarkResultsRoot(repo),path.join(repo,'.jar','benchmarks','smoke-test'));});
test('Canonical CLI accepts a custom run name with manual-single context',()=>assert.deepEqual(parseArgs(['--one','03-capability-exposure','JAR','--name','M8 HSCE Live Validation']),{repo:null,one:{task:'03-capability-exposure',condition:'JAR'},preflightOnly:false,stepwise:false,model:null,name:'M8 HSCE Live Validation'}));
test('Report surfaces human run label while LATEST publication remains unchanged',()=>{const temp=temporary();try{const run=path.join(temp,'RUN_new');fs.mkdirSync(run,{recursive:true});fs.writeFileSync(path.join(run,'run.log'),'ok');const summary={runId:'RUN_new',runLabel:'Readable Name',runSlug:'readable-name',status:'STARTING',pairs:[],runs:[],startedAt:'test'};publish(run,temp,summary);assert.match(fs.readFileSync(path.join(temp,'LATEST','RESULT.html'),'utf8'),/<h1>Readable Name<\/h1>/);assert.equal(json(path.join(temp,'LATEST','SUMMARY.json')).runSlug,'readable-name');}finally{fs.rmSync(temp,{recursive:true,force:true});}});
test('Active same-process lock is rejected',()=>{const temp=temporary();try{const f=path.join(temp,'lock.json');const release=acquireLock(f);assert.throws(()=>acquireLock(f),/ALREADY_RUNNING/);release();assert(!fs.existsSync(f));}finally{fs.rmSync(temp,{recursive:true,force:true});}});
function paired(outcome='PASS') {const common={outcome,mainModel:'m',runtimeVersion:'v',runtimeHash:'h',baselineId:'b',wallClockMs:10,toolCalls:2,plan:{startStateHash:'s',taskHash:'t',manifestHash:'x',capabilityMapping:[{toolName:'read'},{toolName:'write'}],selectedToolNames:['read','write']}};return [{...structuredClone(common),task_id:'01-skill-routing',condition:'CONTROL'},{...structuredClone(common),task_id:'01-skill-routing',condition:'JAR'}];}
const task=[{task_id:'01-skill-routing',focus:'SKILL_ROUTING'}];
test('Pair identity is checked before any comparison',()=>{const r=paired();r[1].plan.startStateHash='different';assert.equal(makePairs(task,r)[0].functional,'PAIR_IDENTITY_MISMATCH');});
test('M8 confounding is detected from real names, not positions',()=>{const r=paired();r[1].plan.selectedToolNames=['read'];assert.equal(makePairs(task,r)[0].diagnostic,'TREATMENT_CONFOUNDED');});
test('Failed correctness suppresses efficiency ratios',()=>assert.equal(makePairs(task,paired('FAIL'))[0].ratios,null));
test('Infrastructure is not compared as a model loss',()=>{const r=paired();r[1].outcome='INFRA_FAIL';assert.equal(makePairs(task,r)[0].functional,'INFRASTRUCTURE_FAILURE');});
test('Incomplete pair is left incomplete',()=>assert.equal(makePairs(task,paired().slice(0,1))[0].functional,'INCOMPLETE'));

const {routingMetrics}=await import('../lib/diagnostics.mjs');
test('Missing mechanism precision remains null, not fabricated as perfect',()=>{const r=routingMetrics({}, {surfaces:{},selectedToolNames:[]});assert.equal(r.skillPrecision,null);assert.equal(r.contextPrecision,null);assert.equal(r.capabilityRecall,null);});
test('Mechanism metrics use actual delivery, candidate sets and declared ground truth',()=>{const r=routingMetrics({skills:{required:['tdd'],distractors:['deploy']},capabilities:{required:['read','write'],distractors:['search']}},{surfaces:{skills:{candidates:['tdd','deploy'],items:[{id:'tdd'}]},context:{candidates:['a.js'],items:[]}},capabilityMapping:[{toolName:'read'},{toolName:'write'},{toolName:'search'}],selectedToolNames:['read','write'],modelInputHashes:[{channel:'skill-instructions',bytes:41}]},[{name:'read'}]);assert.equal(r.skillRecall,1);assert.equal(r.skillDistractorSuppression,1);assert.equal(r.skillPayloadBytes,41);assert.equal(r.capabilityRecall,1);assert.equal(r.capabilityPrecision,1);assert.equal(r.capabilityRetentionRatio,2/3);assert.equal(r.capabilityDistractorSuppression,1);assert.deepEqual(r.actualToolsCalled,['read']);});
