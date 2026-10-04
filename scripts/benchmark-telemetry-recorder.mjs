#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enableTelemetry } from "../packages/telemetry/src/config.js";
import { TelemetryRecorder } from "../packages/telemetry/src/recorder.js";

const iterations=Number(process.argv[2]||500);
if(!Number.isInteger(iterations)||iterations<100)throw new Error("iterations must be an integer >= 100");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"jar-telemetry-overhead-")),jarHome=path.join(root,"jar"),store=path.join(root,"store");

function measure(recorder){
  const samples=[];
  for(let i=0;i<iterations;i++){
    const started=performance.now();
    recorder.recordBestEffort("hook.finished",{identifiers:{session:"session",turn:`turn-${i}`},correlation_status:"exact",data_origin:"validation",payload:{hook_kind:"Stop",outcome:"success"}});
    samples.push(performance.now()-started);
  }
  samples.sort((a,b)=>a-b);const at=p=>samples[Math.min(samples.length-1,Math.ceil(samples.length*p)-1)];
  return {iterations,p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),maxMs:samples.at(-1)};
}

try{
  await enableTelemetry({root:store,jarHome});
  const common={current:{runtimeId:"benchmark-runtime",sourceCommit:"validation"},adapterId:"benchmark",dataOrigin:"validation"};
  const disabled=measure(new TelemetryRecorder({...common,jarHome:path.join(root,"disabled")})),enabled=measure(new TelemetryRecorder({...common,jarHome}));
  process.stdout.write(`${JSON.stringify({schema:"jar.telemetry.overhead-benchmark.v1",hardwareMeasured:true,target:{p95Ms:10,p99Ms:50},disabled,enabled,passed:enabled.p95Ms<=10&&enabled.p99Ms<=50},null,2)}\n`);
  if(enabled.p95Ms>10||enabled.p99Ms>50)process.exitCode=2;
}finally{fs.rmSync(root,{recursive:true,force:true})}
