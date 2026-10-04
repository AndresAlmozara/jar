import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { sha256 } from "../../core/src/hash.js";
import { readTelemetryConfig, readTelemetryIdentity, writeJsonAtomic } from "./config.js";
import { validateEnvelope } from "./schema.js";
import { dailyGroups, deriveTables, jsonl, markdownReport, selectReviewQueue, summarizeEvents } from "./metrics.js";
import { createZip } from "./zip.js";

const readJson=async file=>JSON.parse(await fsp.readFile(file,"utf8"));
const safeDateDirectory=value=>/^\d{4}-\d{2}-\d{2}$/.test(value);

async function walk(root,predicate=()=>true) {
  const output=[];if(!fs.existsSync(root))return output;
  for(const entry of await fsp.readdir(root,{withFileTypes:true})){const file=path.join(root,entry.name);if(entry.isDirectory())output.push(...await walk(file,predicate));else if(entry.isFile()&&predicate(file))output.push(file)}
  return output.sort();
}

async function acquireLock(root) {
  const lock=path.join(root,".maintenance.lock");
  try { await fsp.mkdir(lock,{recursive:false});await fsp.writeFile(path.join(lock,"owner.json"),JSON.stringify({pid:process.pid,at:new Date().toISOString()}));return lock; }
  catch (error) {
    if(error.code!=="EEXIST")throw error;const age=Date.now()-(await fsp.stat(lock)).mtimeMs;if(age<60*60*1000)throw Object.assign(new Error("telemetry maintenance already running"),{code:"JAR_TELEMETRY_MAINTENANCE_LOCKED"});
    await fsp.rm(lock,{recursive:true,force:true});await fsp.mkdir(lock);return lock;
  }
}

function eventDay(event,timeZone){return new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(event.occurred_at_utc||event.observed_at_utc))}

async function spoolBatch(config) {
  const files=(await fsp.readdir(config.spoolRoot,{withFileTypes:true})).filter(x=>x.isFile()&&x.name.endsWith(".json")).map(x=>path.join(config.spoolRoot,x.name)).sort(),events=[],invalid=[],duplicates=[],seen=new Set();
  for(const manifest of await walk(path.join(config.root,"events"),file=>file.endsWith(".manifest.json"))){try{for(const id of (await readJson(manifest)).eventIds||[])seen.add(id)}catch{}}
  for(const file of files){try{const stat=await fsp.stat(file);if(stat.size>70*1024)throw Object.assign(new Error("spool item oversized"),{code:"oversized"});const event=await readJson(file),valid=validateEnvelope(event);if(!valid.ok)throw Object.assign(new Error(valid.reason),{code:valid.reason});if(seen.has(event.event_id)){duplicates.push({eventId:event.event_id,file});continue}seen.add(event.event_id);events.push({event,file})}catch(error){invalid.push({file,reason:error.code||"invalid"})}}
  for(const duplicate of duplicates)await fsp.rm(duplicate.file,{force:true});
  return {events,invalid,duplicates};
}

async function transferPrivateLocators(config) {
  const files=(await fsp.readdir(config.spoolRoot,{withFileTypes:true})).filter(x=>x.isFile()&&x.name.endsWith(".locator")).map(x=>path.join(config.spoolRoot,x.name)).sort(),target=path.join(config.root,"private","locators.jsonl"),existing=new Set(),rows=[];
  if(fs.existsSync(target)){for(const line of (await fsp.readFile(target,"utf8")).split(/\r?\n/).filter(Boolean)){try{const row=JSON.parse(line);existing.add(`${row.kind}|${row.id}|${row.value}`)}catch{}}}
  for(const file of files){try{const items=JSON.parse(await fsp.readFile(file,"utf8"));for(const row of items){const key=`${row.kind}|${row.id}|${row.value}`;if(!existing.has(key)){existing.add(key);rows.push(row)}}await fsp.rm(file,{force:true})}catch{}}
  if(rows.length){await fsp.mkdir(path.dirname(target),{recursive:true});await fsp.appendFile(target,jsonl(rows),{encoding:"utf8",mode:0o600})}return rows.length;
}

async function collectLosses(config) {const files=(await fsp.readdir(config.spoolRoot,{withFileTypes:true})).filter(x=>x.isFile()&&x.name.endsWith(".loss")).map(x=>path.join(config.spoolRoot,x.name)),reasons={};let count=0;for(const file of files){try{const row=await readJson(file),amount=Number.isInteger(row.count)?row.count:1;count+=amount;reasons[row.reason||"unknown"]=(reasons[row.reason||"unknown"]||0)+amount;await fsp.rm(file,{force:true})}catch{}}return {count,reasons}}

async function writeChunks(config,batch) {
  const groups=new Map();for(const item of batch.events){const day=eventDay(item.event,config.reportTimezone);if(!groups.has(day))groups.set(day,[]);groups.get(day).push(item)}
  const chunks=[];
  for(const [day,items] of groups){items.sort((a,b)=>a.event.event_id.localeCompare(b.event.event_id));const body=jsonl(items.map(x=>x.event)),hash=sha256(body),directory=path.join(config.root,"events",day),file=path.join(directory,`part-${hash.slice(0,20)}.jsonl.gz`),manifest=path.join(directory,`part-${hash.slice(0,20)}.manifest.json`);await fsp.mkdir(directory,{recursive:true});
    if(!fs.existsSync(file)){const temporary=`${file}.${process.pid}.tmp`;await fsp.writeFile(temporary,gzipSync(Buffer.from(body),{level:9}));await fsp.rename(temporary,file)}
    const verified=sha256(gunzipSync(await fsp.readFile(file)).toString("utf8"));if(verified!==hash)throw Object.assign(new Error("telemetry chunk checksum mismatch"),{code:"JAR_TELEMETRY_CHUNK_CHECKSUM"});
    if(!fs.existsSync(manifest))await writeJsonAtomic(manifest,{schema:"jar.telemetry.chunk.v1",day,eventCount:items.length,eventIds:items.map(x=>x.event.event_id),uncompressedSha256:hash,file:path.basename(file)});
    chunks.push({day,file,manifest,eventCount:items.length,hash});
  }
  for(const item of batch.events)await fsp.rm(item.file,{force:true});return chunks;
}

export async function readArchivedEvents(config) {
  const files=await walk(path.join(config.root,"events"),file=>file.endsWith(".jsonl.gz")),events=[],duplicates=[];const seen=new Set();
  for(const file of files){const lines=gunzipSync(await fsp.readFile(file)).toString("utf8").split(/\r?\n/).filter(Boolean);for(const line of lines){const event=JSON.parse(line);if(seen.has(event.event_id)){duplicates.push(event.event_id);continue}seen.add(event.event_id);events.push(event)}}
  events.sort((a,b)=>a.observed_at_utc.localeCompare(b.observed_at_utc)||a.event_id.localeCompare(b.event_id));return {events,duplicates,files};
}

async function activeStudy(config) {
  const roots=await fsp.readdir(path.join(config.root,"studies"),{withFileTypes:true}),files=roots.filter(x=>x.isDirectory()).map(x=>path.join(config.root,"studies",x.name,"manifest.json")).filter(file=>fs.existsSync(file));if(!files.length)return null;
  const manifests=await Promise.all(files.map(readJson));return manifests.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).at(-1);
}

function installedRuntime(jarHome) {
  try {const current=JSON.parse(fs.readFileSync(path.join(jarHome,"current.json"),"utf8"));return {runtimeId:current.runtimeId||null,sourceCommit:current.sourceCommit||null,contentHash:current.contentHash||null}}
  catch{return null}
}

function recordRuntimeProvenance(study,events,current,now) {
  const transitions=Array.isArray(study.runtimeTransitions)?[...study.runtimeTransitions]:[],seen=new Set(transitions.map(x=>`${x.runtimeId||""}|${x.sourceCommit||""}`));
  for(const event of events){
    if(!event.runtime_id)continue;const key=`${event.runtime_id}|${event.jar_source_commit||""}`;if(seen.has(key))continue;
    transitions.push({observedAt:event.observed_at_utc,runtimeId:event.runtime_id,sourceCommit:event.jar_source_commit||null,contentHash:null,source:"telemetry_event"});seen.add(key);
  }
  if(current?.runtimeId){
    const key=`${current.runtimeId}|${current.sourceCommit||""}`,existing=transitions.find(x=>`${x.runtimeId||""}|${x.sourceCommit||""}`===key);
    if(existing){if(!existing.contentHash&&current.contentHash)existing.contentHash=current.contentHash;if(existing.source==="telemetry_event")existing.confirmedByInstalledPointerAt=now.toISOString()}
    else transitions.push({observedAt:now.toISOString(),runtimeId:current.runtimeId,sourceCommit:current.sourceCommit,contentHash:current.contentHash,source:"installed_pointer"});
  }
  study.runtimeTransitions=transitions;return study;
}

async function updateStudy(config,events,now,jarHome) {
  const study=await activeStudy(config);if(!study)return null;
  if(!study.t0){const first=events.find(x=>x.data_origin==="production"&&x.event_name==="routing.observed");if(first){study.t0=first.observed_at_utc;study.t1=new Date(new Date(study.t0).getTime()+study.days*86400000).toISOString();study.status="ACTIVE";study.activatedByEventId=first.event_id}}
  if(study.t1&&now.toISOString()>=study.t1&&study.status==="ACTIVE")study.status="READY_FOR_REVIEW";
  recordRuntimeProvenance(study,events,installedRuntime(jarHome),now);
  study.updatedAt=now.toISOString();await writeJsonAtomic(path.join(config.root,"studies",study.studyId,"manifest.json"),study);return study;
}

async function writeDerivedAndReports(config,events,duplicates,study,now) {
  const tables=deriveTables(events);for(const [name,rows] of Object.entries(tables))await fsp.writeFile(path.join(config.root,"derived",`${name}.jsonl`),jsonl(rows),"utf8");
  for(const [day,items] of dailyGroups(events,config.reportTimezone)){const metrics=summarizeEvents(items,{timeZone:config.reportTimezone,asOf:now.toISOString()});metrics.data_health.duplicate_count=duplicates.length;await writeJsonAtomic(path.join(config.root,"reports","daily",`${day}.json`),metrics);await fsp.writeFile(path.join(config.root,"reports","daily",`${day}.md`),markdownReport(metrics,{title:`JAR telemetry daily report — ${day}`}),"utf8")}
  if(study?.t0){const metrics=summarizeEvents(events,{timeZone:config.reportTimezone,asOf:now.toISOString(),windowStart:study.t0,windowEnd:study.t1});metrics.data_health.duplicate_count=duplicates.length;const directory=path.join(config.root,"reports","studies",study.studyId);await fsp.mkdir(directory,{recursive:true});await writeJsonAtomic(path.join(directory,"metrics.json"),metrics);await fsp.writeFile(path.join(directory,"REPORT.md"),markdownReport(metrics,{title:`JAR telemetry study — ${study.studyId}`}),"utf8");await fsp.writeFile(path.join(directory,"review-queue.jsonl"),jsonl(selectReviewQueue(events.filter(x=>x.observed_at_utc>=study.t0&&x.observed_at_utc<study.t1),metrics)),"utf8")}
  return tables;
}

async function directoryBytes(root) { let total=0;for(const file of await walk(root)){try{total+=(await fsp.stat(file)).size}catch{}}return total }

async function applyRetention(config,study,now) {
  const eventRoot=path.resolve(config.root,"events"),threshold=new Date(now.getTime()-config.rawRetentionDays*86400000).toISOString().slice(0,10),deleted=[];
  for(const entry of await fsp.readdir(eventRoot,{withFileTypes:true})){if(!entry.isDirectory()||!safeDateDirectory(entry.name)||entry.name>=threshold)continue;const protectedDay=study?.protected&&!study.reviewedAt&&study.t0&&entry.name>=study.t0.slice(0,10)&&entry.name<=study.t1.slice(0,10);if(protectedDay)continue;const target=path.resolve(eventRoot,entry.name);if(path.dirname(target)!==eventRoot)continue;await fsp.rm(target,{recursive:true,force:true});deleted.push(entry.name)}
  const reportRoot=path.resolve(config.root,"reports","daily"),summaryThreshold=new Date(now.getTime()-config.summaryRetentionDays*86400000).toISOString().slice(0,10);if(fs.existsSync(reportRoot))for(const entry of await fsp.readdir(reportRoot,{withFileTypes:true})){const day=entry.name.slice(0,10);if(!entry.isFile()||!safeDateDirectory(day)||day>=summaryThreshold)continue;const target=path.resolve(reportRoot,entry.name);if(path.dirname(target)===reportRoot)await fsp.rm(target,{force:true})}
  return deleted;
}

export async function maintainTelemetry({jarHome,now=new Date()}={}) {
  const config=readTelemetryConfig({jarHome});if(!config)throw Object.assign(new Error("telemetry is not configured"),{code:"JAR_TELEMETRY_NOT_CONFIGURED"});const lock=await acquireLock(config.spoolRoot),started=performance.now();
  try {const archiveBefore=await directoryBytes(config.root),batch=await spoolBatch(config),hardAtStart=archiveBefore>=config.archiveLimitBytes;let deferredCount=0;if(hardAtStart){const essential=new Set(["hook.finished","session.observed","telemetry.health"]),ready=batch.events.filter(x=>essential.has(x.event.event_name));deferredCount=batch.events.length-ready.length;batch.events=ready}const chunks=await writeChunks(config,batch),privateLocatorCount=await transferPrivateLocators(config),losses=await collectLosses(config),archive=await readArchivedEvents(config),study=await updateStudy(config,archive.events,now,jarHome),tables=await writeDerivedAndReports(config,archive.events,archive.duplicates,study,now),deletedDays=await applyRetention(config,study,now),spoolFiles=(await fsp.readdir(config.spoolRoot)).filter(x=>x.endsWith(".json")).length,archiveBytes=await directoryBytes(config.root),capacityState=archiveBytes>=config.archiveLimitBytes?"hard_limit":archiveBytes>=config.archiveWarningBytes?"warning":"ok",health={schema:"jar.telemetry.health.v1",status:capacityState==="hard_limit"?"CAPACITY_LIMIT":"HEALTHY",updatedAt:now.toISOString(),studyId:study?.studyId||null,studyStatus:study?.status||null,ingestedEvents:batch.events.length,deferredOptionalEvents:deferredCount,privateLocatorCount,invalidSpoolItems:batch.invalid.length,duplicates:archive.duplicates.length+batch.duplicates.length,spoolFiles,archiveBytes,capacityState,knownLoss:losses,lastMaintenanceDurationMs:performance.now()-started,deletedDays,nativeParserAvailability:"explicit_adapter_fields_only",coverage:{codex_hooks:"covered_when_installed",opencode:"observer_only",cloud:"NOT_COVERED",remote_hosts:"NOT_COVERED"}};await writeJsonAtomic(path.join(config.root,"health","status.json"),health);return {ok:true,health,chunks,tables:{turns:tables.turns.length,sessions:tables.sessions.length,tools:tables.tools.length},study};}
  finally {await fsp.rm(lock,{recursive:true,force:true})}
}

export async function telemetryStatus({jarHome}={}) {
  const config=readTelemetryConfig({jarHome});if(!config)return {ok:false,status:"NOT_CONFIGURED"};let health=null;try{health=await readJson(path.join(config.root,"health","status.json"))}catch{}let study=null;try{study=await activeStudy(config)}catch{}return {ok:true,status:config.enabled?(health?.status||"ENABLED_AWAITING_MAINTENANCE"):"DISABLED",enabled:config.enabled,root:config.root,spoolRoot:config.spoolRoot,reportTimezone:config.reportTimezone,study,health};
}

export async function telemetryDoctor({jarHome,runtimeIdentity=null,scheduler=null}={}) {
  const status=await telemetryStatus({jarHome});if(!status.ok)return status;const config=readTelemetryConfig({jarHome}),identity=readTelemetryIdentity({jarHome}),spoolEntries=fs.existsSync(config.spoolRoot)?await fsp.readdir(config.spoolRoot,{withFileTypes:true}):[],spoolFiles=spoolEntries.filter(x=>x.isFile()&&x.name.endsWith(".json")).length,latestSpool=spoolEntries.filter(x=>x.isFile()).map(x=>path.join(config.spoolRoot,x.name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]||null,checks={configuration:{ok:true,schemaVersion:config.schemaVersion,enabled:config.enabled},identity:{ok:Boolean(identity?.installationId)},root:{ok:fs.existsSync(config.root),path:config.root},spool:{ok:fs.existsSync(config.spoolRoot),path:config.spoolRoot,pendingFiles:spoolFiles,lastRecorderActivity:latestSpool?fs.statSync(latestSpool).mtime.toISOString():null},privacy:{ok:!config.capturePromptText&&!config.captureSourceText&&!config.captureToolBodies&&!config.remoteExport},nativeUsage:{ok:true,state:"explicit_adapter_fields_only",transcriptParser:"UNAVAILABLE_UNVALIDATED"},scheduler:scheduler||{ok:null,state:"not_inspected"},runtime:{ok:Boolean(runtimeIdentity),identity:runtimeIdentity},capacity:{ok:status.health?.capacityState!=="hard_limit",archiveBytes:status.health?.archiveBytes??null},knownLoss:{count:(status.health?.knownLoss?.count??0)+(status.health?.invalidSpoolItems??0),reasons:status.health?.knownLoss?.reasons||{}}};return {ok:Object.values(checks).filter(x=>x.ok!==null).every(x=>x.ok!==false),status:status.status,lastMaintenanceActivity:status.health?.updatedAt||null,coverage:status.health?.coverage||null,checks,study:status.study};
}

export async function exportStudy({jarHome,studyId}={}) {
  const config=readTelemetryConfig({jarHome});if(!config)throw Object.assign(new Error("telemetry is not configured"),{code:"JAR_TELEMETRY_NOT_CONFIGURED"});const id=studyId||(await activeStudy(config))?.studyId;if(!id)throw Object.assign(new Error("study not found"),{code:"JAR_TELEMETRY_STUDY_NOT_FOUND"});
  const relativeFiles=[`studies/${id}/manifest.json`,`reports/studies/${id}/REPORT.md`,`reports/studies/${id}/metrics.json`,`reports/studies/${id}/review-queue.jsonl`],entries=[];for(const relative of relativeFiles){const file=path.join(config.root,...relative.split("/"));if(fs.existsSync(file))entries.push({name:relative,data:await fsp.readFile(file)})}
  entries.push({name:"EXPORT-MANIFEST.json",data:JSON.stringify({schema:"jar.telemetry.export.v1",studyId,sanitized:true,privateLocatorsIncluded:false,hmacKeyIncluded:false,files:entries.map(x=>x.name)},null,2)+"\n"});const target=path.join(config.root,"exports",`${id}-sanitized.zip`);await fsp.mkdir(path.dirname(target),{recursive:true});await fsp.writeFile(target,createZip(entries,{date:new Date(0)}));return {ok:true,studyId,file:target,entries:entries.map(x=>x.name),privateLocatorsIncluded:false};
}

export async function reportStudy({jarHome,studyId}={}) {const config=readTelemetryConfig({jarHome});if(!config)throw Object.assign(new Error("telemetry is not configured"),{code:"JAR_TELEMETRY_NOT_CONFIGURED"});const id=studyId||(await activeStudy(config))?.studyId;if(!id)throw Object.assign(new Error("study not found"),{code:"JAR_TELEMETRY_STUDY_NOT_FOUND"});const file=path.join(config.root,"reports","studies",id,"REPORT.md");if(!fs.existsSync(file))await maintainTelemetry({jarHome});return {ok:true,studyId:id,file,markdown:await fsp.readFile(file,"utf8")};}
