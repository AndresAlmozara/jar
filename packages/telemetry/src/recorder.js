import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createEnvelope, fingerprint } from "./schema.js";
import { readTelemetryConfig, readTelemetryIdentity, readTelemetryKey, telemetryConfigHash } from "./config.js";

const ORDINARY_LIMIT=8*1024;
const ROUTING_LIMIT=64*1024;

function currentStudy(config) {
  try {
    const studies=fs.readdirSync(path.join(config.root,"studies"),{withFileTypes:true}).filter(x=>x.isDirectory()).map(entry=>{try{return JSON.parse(fs.readFileSync(path.join(config.root,"studies",entry.name,"manifest.json"),"utf8"))}catch{return null}}).filter(Boolean).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
    return studies.at(-1)?.studyId||null;
  } catch { return null; }
}

function boundedEnvelope(envelope,limit) {
  let body=JSON.stringify(envelope);
  if (Buffer.byteLength(body)<=limit) return {envelope,body};
  const payload=envelope.payload||{},summary={};
  for (const key of ["kind","phase","outcome","reason","code","hook_kind","duration_ms","telemetry_overhead_ms","state","mode","selected_count","materialized_count","full_count","partial_count","absent_count","tool_name","tool_category","scope","usage_source","label"]) if (payload[key]!==undefined) summary[key]=payload[key];
  const reduced={...envelope,truncation:{...(envelope.truncation||{}),observation_truncated:true,original_bytes:Buffer.byteLength(body),limit_bytes:limit},payload:{...summary,observation_truncated:true}};
  body=JSON.stringify(reduced);
  if (Buffer.byteLength(body)>limit) throw Object.assign(new Error("telemetry envelope exceeds hard bound"),{code:"JAR_TELEMETRY_ENVELOPE_TOO_LARGE"});
  return {envelope:reduced,body};
}

function spoolBytes(root) { try{return fs.readdirSync(root,{withFileTypes:true}).filter(x=>x.isFile()&&!x.name.endsWith(".tmp")).reduce((total,entry)=>{try{return total+fs.statSync(path.join(root,entry.name)).size}catch{return total}},0)}catch{return 0} }

export class TelemetryRecorder {
  constructor({jarHome,current,adapterId="jar-runtime",adapterVersion="1",hostRuntimeVersion=null,dataOrigin="production"}={}) {
    this.jarHome=jarHome;this.current=current||{};this.adapterId=adapterId;this.adapterVersion=adapterVersion;this.hostRuntimeVersion=hostRuntimeVersion;this.dataOrigin=dataOrigin;
    try {this.config=readTelemetryConfig({jarHome});this.identity=readTelemetryIdentity({jarHome});this.key=readTelemetryKey({jarHome});this.ready=Boolean(this.config?.enabled&&this.identity?.installationId&&this.key);this.studyId=this.ready?currentStudy(this.config):null}
    catch(error){this.config=null;this.identity=null;this.key=null;this.ready=false;this.studyId=null;this.initializationError=error.code||"JAR_TELEMETRY_INITIALIZATION_FAILED"}
  }

  id(namespace,value) { return value==null||!this.key?null:`hmac-sha256:${fingerprint(this.key,namespace,value)}`; }

  record(eventName,input={}) {
    if (!this.ready) return {recorded:false,reason:this.initializationError|| (this.config?.enabled===false?"disabled":"not_configured")};
    const started=performance.now(),envelope=createEnvelope({
      ...input,event_name:eventName,installation_id:this.identity.installationId,runtime_id:input.runtime_id||this.current.runtimeId||null,
      jar_source_commit:input.jar_source_commit||this.current.sourceCommit||null,config_hash:telemetryConfigHash(this.config),adapter_id:this.adapterId,
      adapter_version:this.adapterVersion,host_runtime_version:this.hostRuntimeVersion,study_id:input.study_id||this.studyId,data_origin:input.data_origin||this.dataOrigin,
    },{key:this.key});
    const limit=eventName==="routing.observed"?ROUTING_LIMIT:ORDINARY_LIMIT,{envelope:bounded,body}=boundedEnvelope(envelope,limit);
    const stem=`${Date.now()}-${process.pid}-${randomBytes(8).toString("hex")}`,file=`${stem}.json`,target=path.join(this.config.spoolRoot,file),temporary=`${target}.tmp`;
    fs.mkdirSync(this.config.spoolRoot,{recursive:true});
    const used=this.spoolBytes??spoolBytes(this.config.spoolRoot),essential=eventName==="hook.finished"||eventName==="session.observed"||eventName==="telemetry.health";this.spoolBytes=used;
    if(used+Buffer.byteLength(body)>this.config.spoolLimitBytes+(essential?1024*1024:0)){const loss=path.join(this.config.spoolRoot,`${stem}.loss`);try{fs.writeFileSync(loss,JSON.stringify({schema:"jar.telemetry.loss.v1",at:new Date().toISOString(),reason:"spool_capacity",eventName,count:1}),{encoding:"utf8",mode:0o600,flag:"wx"})}catch{}return {recorded:false,reason:"spool_capacity",knownLoss:1,overheadMs:performance.now()-started}}
    try { fs.writeFileSync(temporary,`${body}\n`,{encoding:"utf8",mode:0o600,flag:"wx"});fs.renameSync(temporary,target); }
    finally { try { fs.rmSync(temporary,{force:true}); } catch {} }
    const locators=(input.privateLocators||[]).filter(item=>["repository","file","transcript"].includes(item?.kind)&&typeof item.value==="string"&&item.value.length<=32768).slice(0,100).map(item=>({schema:"jar.telemetry.private-locator.v1",eventId:bounded.event_id,kind:item.kind,id:item.id||this.id(`${item.kind}-locator`,item.value),value:item.value,observedAt:bounded.observed_at_utc}));
    this.spoolBytes+=Buffer.byteLength(body)+1;
    if(locators.length){const locatorTarget=path.join(this.config.spoolRoot,`${stem}.locator`),locatorTemporary=`${locatorTarget}.tmp`,locatorBody=`${JSON.stringify(locators)}\n`;try{fs.writeFileSync(locatorTemporary,locatorBody,{encoding:"utf8",mode:0o600,flag:"wx"});fs.renameSync(locatorTemporary,locatorTarget);this.spoolBytes+=Buffer.byteLength(locatorBody)}finally{try{fs.rmSync(locatorTemporary,{force:true})}catch{}}}
    return {recorded:true,eventId:bounded.event_id,file,locatorCount:locators.length,bytes:Buffer.byteLength(body),overheadMs:performance.now()-started};
  }

  recordBestEffort(eventName,input={}) {
    try { return this.record(eventName,input); }
    catch (error) { return {recorded:false,reason:error.code||"recording_failed"}; }
  }
}

export function recorderForHook(options={}) {
  return new TelemetryRecorder({jarHome:options.jarHome,current:options.current,adapterId:"codex-hook-native",adapterVersion:"1",hostRuntimeVersion:options.hostRuntimeVersion||null,dataOrigin:options.dataOrigin||"production"});
}
