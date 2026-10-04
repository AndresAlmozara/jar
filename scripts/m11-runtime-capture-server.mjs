import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const [planPath, outputPath, candidatePath, readyPath, startupFailurePath, serverStatePath, ...extra] = process.argv.slice(2);
if (!planPath || !outputPath || !candidatePath || !readyPath || !startupFailurePath || !serverStatePath || extra.length) throw new Error("Invalid startup arguments");
async function recordStartupFailure(errorCode){try{await writeFile(startupFailurePath,`${JSON.stringify({schemaVersion:"m11.capture-server-start-failure.v1",errorCode})}\n`,{flag:"wx"});}catch{}}
const startupError=code=>Object.assign(new Error("Capture server startup failed"),{startupCode:code});
const serverError=code=>Object.assign(new Error(code),{m11Code:code});
const state={schemaVersion:"m11.capture-server-state.v3",failureCode:null,validationDiagnosticsSchemaVersion:null,validationFailureCodes:[],requestObserved:false,requestMethodMatch:null,requestPathMatch:null,requestValidationPassed:false,httpResponseStarted:false,responseCreatedSent:false,responseCompletedSent:false,responseStreamClosed:false,captureCandidateCreated:false,captureCandidateComplete:false,captureCandidatePersisted:false};
let stateWrites=Promise.resolve();
const persistState=()=>{const snapshot=`${JSON.stringify(state)}\n`;stateWrites=stateWrites.then(()=>writeFile(serverStatePath,snapshot));return stateWrites;};
const finishResponse=response=>new Promise((resolve,reject)=>{response.once("finish",resolve);response.once("error",reject);response.end();});
let server;
try {
  let plan;
  try { plan=JSON.parse(await readFile(planPath,"utf8")); } catch { throw startupError("PLAN_LOAD_FAILURE"); }
  const expectedMode=plan?.mode, expectedKey=expectedMode==="baseline"?"baselineDynamicTools":expectedMode==="filtered"?"filteredDynamicTools":null;
  const expectedNames=["tool_alpha","tool_beta","tool_gamma"];
  if(!plan||Object.keys(plan).sort().join(",")!=="dynamicToolsKey,expected,expectedBuiltins,mode,outputFile,schemaVersion"
    ||plan.schemaVersion!=="m11.runtime-capture-plan.v1"||plan.dynamicToolsKey!==expectedKey
    ||!Array.isArray(plan.expectedBuiltins)||plan.expectedBuiltins.length!==0||basename(outputPath)!==plan.outputFile
    ||!plan.expected||Object.keys(plan.expected).sort().join(",")!==expectedNames.join(",")
    ||Object.values(plan.expected).some(value=>!("PRESENT"===value||"ABSENT"===value))
    ||plan.expected.tool_alpha!=="PRESENT"||plan.expected.tool_gamma!=="PRESENT"
    ||(expectedMode==="baseline"?plan.expected.tool_beta!=="PRESENT":plan.expected.tool_beta!=="ABSENT")) throw startupError("PLAN_VALIDATION_FAILURE");
  let buildRealAdmission,captureRuntimeRequest,inspectRuntimeCaptureValidation,observeTool,serializeCapture,buildSyntheticResponsesEvents;
  try {
    ({buildRealAdmission}=await import("./m11-evaluate-runtime-admission.mjs"));
    ({captureRuntimeRequest,inspectRuntimeCaptureValidation,observeTool,serializeCapture}=await import("../packages/request-capture/src/capture.js"));
    ({buildSyntheticResponsesEvents}=await import("./m11-synthetic-responses.mjs"));
  } catch { throw startupError("SERVER_SCRIPT_START_FAILURE"); }
  const admitted=await buildRealAdmission();
  if(admitted.outcome.state!=="ADMITTED_COMPLETE_FOR_SCOPE") throw startupError("SERVER_SCRIPT_START_FAILURE");
  let consumed=false;
  server=http.createServer((request,response)=>{
    (async()=>{
      let phase="request-validation";
      try {
        state.requestMethodMatch=request.method==="POST";state.requestPathMatch=request.url==="/v1/responses";
        if(consumed||!state.requestMethodMatch||!state.requestPathMatch){
          if(!state.requestMethodMatch)state.validationFailureCodes.push("REQUEST_METHOD_MISMATCH");
          if(!state.requestPathMatch)state.validationFailureCodes.push("REQUEST_PATH_MISMATCH");
          throw serverError("PROVIDER_REQUEST_VALIDATION_FAILURE");
        }
        consumed=true;state.requestObserved=true;await persistState();
        const chunks=[];let bytes=0;
        for await(const chunk of request){bytes+=chunk.length;if(bytes>2*1024*1024)throw serverError("PROVIDER_REQUEST_VALIDATION_FAILURE");chunks.push(chunk);}
        const raw=Buffer.concat(chunks).toString("utf8"),requestHash=createHash("sha256").update(raw).digest("hex");
        const observation=captureRuntimeRequest({raw,headers:request.headers,
          runtime:{family:"codex",installationId:"m11-pinned",surface:"sandbox",runtimeVersion:"0.158.0-alpha.2.1",adapterVersion:"m11",evidence:[{kind:"runtime_process",ref:"dynamic-preflight"}]},
          providerProtocol:"openai-responses-http",requestScope:"initial-request-static-context",
          invocationId:`m11-${plan.mode}`,turnId:`m11-${plan.mode}-turn`,ordinal:1,plan:null,mappings:[],unknownContributor:false,
          admission:admitted.outcome,captureEvidence:{kind:"model_context",ref:`m11-${plan.mode}-loopback`,requestHash,
            binaryHash:admitted.outcome.facts.binaryHash,configHash:admitted.outcome.facts.configHash,
            correlationId:admitted.outcome.correlationId,invocationId:`m11-${plan.mode}`,turnId:`m11-${plan.mode}-turn`,ordinal:1}});
        const expectedToolNames=Object.entries(plan.expected).filter(([,value])=>value==="PRESENT").map(([name])=>name);
        const diagnostics=inspectRuntimeCaptureValidation(observation,{expectedToolNames,
          expectedModelHash:"a701703e3b2ec1df4b83c0caa07fd60b4f30410e8af8f33ef736a87c3fc526a3"});
        const {schemaVersion:validationDiagnosticsSchemaVersion,...safeDiagnostics}=diagnostics;
        state.validationDiagnosticsSchemaVersion=validationDiagnosticsSchemaVersion;Object.assign(state,safeDiagnostics);
        state.captureCandidateCreated=true;state.captureCandidateComplete=observation.completeness==="COMPLETE";await persistState();
        if(!state.captureCandidateComplete)throw serverError("PROVIDER_REQUEST_VALIDATION_FAILURE");
        for(const [name,expected] of Object.entries(plan.expected))if(observeTool(observation,name)!==expected)throw serverError("PROVIDER_REQUEST_VALIDATION_FAILURE");
        if(observation.tools.some(tool=>!Object.hasOwn(plan.expected,tool.nativeId)))throw serverError("PROVIDER_REQUEST_VALIDATION_FAILURE");
        const serialized=serializeCapture(observation);state.requestValidationPassed=true;await persistState();

        phase="response-start";
        response.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-store","connection":"close"});
        state.httpResponseStarted=true;await persistState();
        phase="response-stream";
        for(const event of buildSyntheticResponsesEvents()){
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          if(event.type==="response.created")state.responseCreatedSent=true;
          if(event.type==="response.completed")state.responseCompletedSent=true;
          await persistState();
        }
        await finishResponse(response);state.responseStreamClosed=true;await persistState();

        phase="capture-finalization";
        await writeFile(candidatePath,serialized,{flag:"wx"});state.captureCandidatePersisted=true;await persistState();
        server.close();
      } catch(error) {
        const fallback=phase==="request-validation"?"PROVIDER_REQUEST_VALIDATION_FAILURE":phase==="response-start"?"PROVIDER_RESPONSE_START_FAILURE":phase==="response-stream"?"PROVIDER_RESPONSE_PROTOCOL_FAILURE":"CAPTURE_FINALIZATION_FAILURE";
        state.failureCode=typeof error?.m11Code==="string"?error.m11Code:fallback;
        try{await persistState();}catch{}
        if(!response.headersSent){response.writeHead(400,{"content-type":"application/json","connection":"close"});response.end(JSON.stringify({error:"CAPTURE_REJECTED"}));}
        else if(!response.writableEnded)response.destroy();
        server.close();process.stderr.write(`${state.failureCode}\n`);process.exitCode=2;
      }
    })();
  });
  server.on("connect",socket=>socket.destroy());server.on("upgrade",(_,socket)=>socket.destroy());
  await new Promise((resolveReady,rejectReady)=>{
    server.once("error",()=>rejectReady(startupError("LOOPBACK_BIND_FAILURE")));
    server.listen(43187,"127.0.0.1",async()=>{try{await writeFile(readyPath,"READY\n",{flag:"wx"});resolveReady();}catch{rejectReady(startupError("READY_FILE_WRITE_FAILURE"));server.close();}});
  });
  setTimeout(()=>{server.close();process.exitCode=3;},60000).unref();
} catch(error) {
  const code=typeof error?.startupCode==="string"?error.startupCode:"SERVER_SCRIPT_START_FAILURE";
  await recordStartupFailure(code);if(server)server.close();process.exitCode=2;
}
