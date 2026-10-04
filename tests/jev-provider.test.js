import test from "node:test";
import assert from "node:assert/strict";
import { JevDecisionEngine, TypeSafeClient, TypeSafeProviderError } from "../packages/decision-providers/jev/src/index.js";

const key="test-secret-api-key";
const response=(body,{status=200}={})=>({ok:status>=200&&status<300,status,json:async()=>body});
const usage={input_tokens:12,output_tokens:3};

test("model discovery normalizes TypeSafe metadata and authorizes safely",async()=>{let seen;const client=new TypeSafeClient({apiKey:key,fetchImpl:async(url,options)=>{seen={url,options};return response({models:[{name:"jev-latest",description:"Current",release_date:"2026-09-15"}]})}});assert.deepEqual(await client.listModels(),[{name:"jev-latest",description:"Current",releaseDate:"2026-09-15"}]);assert.equal(seen.url,"https://api.typesafe.ai/v1/models");assert.equal(seen.options.headers.Authorization,`Bearer ${key}`)});

test("Choice pins the admitted model and preserves decision metadata",async()=>{let body;const events=[];const client=new TypeSafeClient({apiKey:key,fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return response({model:"jev-1.13.0",answers:{decision:{type:"choice",choice:"database",confidence:0.84,probabilities:{database:0.7,testing:0.25,frontend:0.05}}},usage})}});const engine=new JevDecisionEngine({client,onTelemetry:(event)=>events.push(event)});const result=await engine.choice({taskId:"t",state:"migration failure",instructions:"Classify",criteria:{database:"DB",testing:"Tests",frontend:"UI"}});assert.deepEqual(body,{state:"migration failure",model:"jev-1.13.0",questions:{decision:{type:"choice",instructions:"Classify",criteria:{database:"DB",testing:"Tests",frontend:"UI"}}}});assert.equal(result.choice,"database");assert.deepEqual(result.probabilities,{database:0.7,testing:0.25,frontend:0.05});assert.equal(result.confidence,0.84);assert.deepEqual(result.usage,usage);assert.equal(result.provider.model,"jev-1.13.0");assert.equal(events[0].success,true);assert.equal(events[0].candidate_count,3);assert.equal(events[0].provider_model,"jev-1.13.0")});

test("Noul preserves probability without applying a boolean threshold",async()=>{const client=new TypeSafeClient({apiKey:key,fetchImpl:async()=>response({model:"jev-latest",answers:{decision:{type:"noul",noul:0.73}},usage})});const result=await new JevDecisionEngine({client}).noul({state:"message",instructions:"Is this relevant?"});assert.equal(result.probability_true,0.73);assert.equal(result.probability_false,0.27);assert.equal("value" in result,false)});

test("Score preserves expected score, rubric distribution, and confidence",async()=>{const answer={type:"score",score:1.7,confidence:0.9,legend:{0:"low",1:"medium",2:"high"},probabilities:{0:0.1,1:0.1,2:0.8}};const client=new TypeSafeClient({apiKey:key,fetchImpl:async()=>response({model:"jev-latest",answers:{decision:answer},usage})});const result=await new JevDecisionEngine({client}).score({state:"urgent",criteria:["low","medium","high"]});assert.equal(result.score,1.7);assert.equal(result.confidence,0.9);assert.deepEqual(result.legend,answer.legend);assert.deepEqual(result.probabilities,answer.probabilities)});

test("Noul batch maps stable question IDs and counts usage once per real request",async()=>{let body,calls=0;const events=[];
  const client=new TypeSafeClient({apiKey:key,fetchImpl:async(_url,options)=>{calls++;body=JSON.parse(options.body);return response({model:"jev-1.13.0",
    answers:{"family:workspace":{type:"noul",noul:.9},"family:assets":{type:"noul",noul:.05}},usage})}});
  const result=await new JevDecisionEngine({client,onTelemetry:event=>events.push(event)}).noulBatch({taskId:"batch-task",state:{task:"edit code"},questions:[
    {id:"family:workspace",instructions:"workspace?",criteria:{true:"yes",false:"no"}},
    {id:"family:assets",instructions:"assets?",criteria:{true:"yes",false:"no"}}]});
  assert.equal(calls,1);assert.equal(body.model,"jev-1.13.0");assert.deepEqual(Object.keys(body.questions),["family:workspace","family:assets"]);
  assert.equal(result.answers["family:workspace"].probability_true,.9);assert.equal(result.answers["family:assets"].probability_false,.95);
  assert.deepEqual(result.usage,usage);assert.equal(events.length,1);assert.equal(events[0].question_count,2);assert.equal(events[0].input_tokens,12);
  assert.deepEqual(events[0].question_ids,["family:workspace","family:assets"]);
});

test("Noul batch rejects duplicate IDs and reports partial invalid answers explicitly",async()=>{const events=[];
  const client=new TypeSafeClient({apiKey:key,fetchImpl:async()=>response({model:"jev-1.13.0",answers:{a:{type:"noul",noul:.9},b:{type:"noul",noul:2}},usage})});
  const engine=new JevDecisionEngine({client,onTelemetry:event=>events.push(event)});
  await assert.rejects(engine.noulBatch({state:"x",questions:[{id:"a"},{id:"a"}]}),/unique stable identifiers/);
  await assert.rejects(engine.noulBatch({state:"x",questions:[{id:"a"},{id:"b"}]}),error=>{assert.equal(error.code,"partial_response");assert.deepEqual(error.failedQuestionIds,["b"]);return true});
  assert.equal(events.length,1);assert.equal(events[0].success,false);assert.equal(events[0].error_code,"partial_response");
  assert.deepEqual(events[0].failed_question_ids,["b"]);assert.equal(events[0].input_tokens,null);
});

test("provider errors distinguish auth, rate limit, and invalid response without leaking secrets",async()=>{for (const [status,code] of [[401,"authentication_failure"],[429,"rate_limit"]]) {const client=new TypeSafeClient({apiKey:key,fetchImpl:async()=>response({}, {status})});await assert.rejects(client.listModels(),(error)=>error instanceof TypeSafeProviderError&&error.code===code&&!String(error.stack).includes(key))}const invalid=new TypeSafeClient({apiKey:key,fetchImpl:async()=>response({models:"wrong"})});await assert.rejects(invalid.listModels(),(error)=>error.code==="unexpected_response"&&!String(error.stack).includes(key))});

test("provider timeout is bounded and secret-safe",async()=>{const client=new TypeSafeClient({apiKey:key,timeoutMs:10,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}))});await assert.rejects(client.listModels(),(error)=>error.code==="timeout"&&!String(error.stack).includes(key))});

test("invalid primitive answer is rejected and failure telemetry is safe",async()=>{const events=[];const client=new TypeSafeClient({apiKey:key,fetchImpl:async()=>response({model:"jev-latest",answers:{decision:{type:"choice",choice:"database"}},usage})});const engine=new JevDecisionEngine({client,onTelemetry:(event)=>events.push(event)});await assert.rejects(engine.choice({state:"x",criteria:{database:"DB"}}),(error)=>error.code==="unexpected_response"&&!String(error.stack).includes(key));assert.equal(events[0].success,false);assert.equal(events[0].error_code,"unexpected_response");assert.equal(JSON.stringify(events).includes(key),false)});

test("missing API key is explicit",async()=>{const client=new TypeSafeClient({apiKey:"",fetchImpl:async()=>response({})});await assert.rejects(client.listModels(),(error)=>error.code==="missing_api_key")});
