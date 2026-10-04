import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { sha256 } from "../../core/src/hash.js";

export const TELEMETRY_CONFIG_SCHEMA = "jar.telemetry.config.v1";
export const TELEMETRY_EVENT_SCHEMA = "jar.telemetry.event.v1";
export const METRIC_DEFINITION_VERSION = "jar.telemetry.metrics.v1";

export const DEFAULT_TELEMETRY_CONFIG = Object.freeze({
  schemaVersion: TELEMETRY_CONFIG_SCHEMA,
  enabled: true,
  mode: "metadata",
  reportTimezone: "Europe/Madrid",
  initialStudyDays: 14,
  continueAfterStudy: true,
  maintenanceMinutes: 30,
  capturePromptText: false,
  captureSourceText: false,
  captureToolBodies: false,
  nativeUsageEnrichment: "auto-local-validated",
  remoteExport: false,
  sampleCoreEvents: 1,
  rawRetentionDays: 45,
  summaryRetentionDays: 180,
  protectUnreviewedStudy: true,
  archiveWarningBytes: 1024 * 1024 * 1024,
  archiveLimitBytes: 2 * 1024 * 1024 * 1024,
  spoolLimitBytes: 256 * 1024 * 1024,
});

export function jarHome(options={}) {
  return path.resolve(options.jarHome || process.env.JAR_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".jar"));
}

export function expandHome(value) {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error("telemetry path is required"), {code:"JAR_TELEMETRY_PATH_REQUIRED"});
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function configPath(options={}) { return path.join(jarHome(options), "config.json"); }
export function identityPath(options={}) { return path.join(jarHome(options), "private", "telemetry-identity.json"); }
export function keyPath(options={}) { return path.join(jarHome(options), "private", "telemetry-hmac.key"); }

function integer(value, name, minimum=1) {
  if (!Number.isInteger(value) || value < minimum) throw Object.assign(new Error(`${name} is invalid`), {code:"JAR_TELEMETRY_CONFIG_INVALID", field:name});
  return value;
}

export function normalizeTelemetryConfig(input) {
  const merged={...DEFAULT_TELEMETRY_CONFIG,...input};
  if (merged.schemaVersion !== TELEMETRY_CONFIG_SCHEMA || merged.mode !== "metadata") throw Object.assign(new Error("unsupported telemetry configuration"), {code:"JAR_TELEMETRY_CONFIG_INVALID"});
  if (!path.isAbsolute(expandHome(merged.root))) throw Object.assign(new Error("telemetry root must be absolute"), {code:"JAR_TELEMETRY_ROOT_NOT_ABSOLUTE"});
  if (merged.capturePromptText || merged.captureSourceText || merged.captureToolBodies || merged.remoteExport) throw Object.assign(new Error("content capture and remote export are disabled for this profile"), {code:"JAR_TELEMETRY_UNSAFE_CONFIG"});
  if (merged.sampleCoreEvents !== 1) throw Object.assign(new Error("core events must not be sampled during the protected study"), {code:"JAR_TELEMETRY_UNSAFE_CONFIG"});
  for (const [key,min] of [["initialStudyDays",1],["maintenanceMinutes",1],["rawRetentionDays",1],["summaryRetentionDays",1],["archiveWarningBytes",1024],["archiveLimitBytes",1024],["spoolLimitBytes",1024]]) integer(merged[key],key,min);
  if (merged.archiveWarningBytes >= merged.archiveLimitBytes) throw Object.assign(new Error("archive warning must be below the hard limit"), {code:"JAR_TELEMETRY_CONFIG_INVALID"});
  return Object.freeze({...merged,root:path.resolve(expandHome(merged.root)),spoolRoot:path.resolve(expandHome(merged.spoolRoot || "~/.jar/telemetry-spool"))});
}

export function readJarConfig(options={}) {
  try { return JSON.parse(fs.readFileSync(configPath(options), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw Object.assign(new Error("JAR config is unreadable"), {code:"JAR_CONFIG_UNREADABLE"}); }
}

export function readTelemetryConfig(options={}) {
  const telemetry=readJarConfig(options).telemetry;
  return telemetry ? normalizeTelemetryConfig(telemetry) : null;
}

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), {recursive:true});
  const temporary=`${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try { await fsp.writeFile(temporary, `${JSON.stringify(value,null,2)}\n`, {encoding:"utf8",mode:0o600,flag:"wx"}); await fsp.rename(temporary,file); }
  finally { await fsp.rm(temporary,{force:true}); }
}

async function ensurePrivateIdentity(options={}) {
  const identityFile=identityPath(options),secretFile=keyPath(options);
  let identity;
  try { identity=JSON.parse(await fsp.readFile(identityFile,"utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    identity={schema:"jar.telemetry.identity.v1",installationId:`installation_${randomUUID()}`,createdAt:new Date().toISOString()};
    await atomicJson(identityFile,identity);
  }
  try { await fsp.access(secretFile,fs.constants.R_OK); }
  catch { await fsp.mkdir(path.dirname(secretFile),{recursive:true});await fsp.writeFile(secretFile,randomBytes(32).toString("base64"),{encoding:"utf8",mode:0o600,flag:"wx"}); }
  return identity;
}

async function latestStudy(root) {
  const studiesRoot=path.join(root,"studies");
  let entries=[];try{entries=await fsp.readdir(studiesRoot,{withFileTypes:true})}catch(error){if(error.code!=="ENOENT")throw error}
  const manifests=[];
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    const file=path.join(studiesRoot,entry.name,"manifest.json");
    try{manifests.push({file,manifest:JSON.parse(await fsp.readFile(file,"utf8"))})}catch(error){if(error.code!=="ENOENT")throw error}
  }
  return manifests.sort((a,b)=>String(a.manifest.createdAt||"").localeCompare(String(b.manifest.createdAt||""))).at(-1)||null;
}

export async function enableTelemetry({root,studyDays=14,jarHome:home,now=new Date()}={}) {
  const options={jarHome:home},existing=readJarConfig(options);
  const telemetry=normalizeTelemetryConfig({...existing.telemetry,root,spoolRoot:existing.telemetry?.spoolRoot || path.join(jarHome(options),"telemetry-spool"),initialStudyDays:Number(studyDays),enabled:true});
  const identity=await ensurePrivateIdentity(options),next={...existing,telemetry:{...telemetry}};
  await atomicJson(configPath(options),next);
  for (const relative of ["studies","manifests","events","derived","reports/daily","reports/studies","health","private","exports"]) await fsp.mkdir(path.join(telemetry.root,relative),{recursive:true});
  await fsp.mkdir(telemetry.spoolRoot,{recursive:true});
  let active=await latestStudy(telemetry.root),reusedStudy=Boolean(active);
  if(!active){
    const studyId=`study_${now.toISOString().slice(0,10).replaceAll("-","")}_${sha256({installationId:identity.installationId,at:now.toISOString()}).slice(0,12)}`,manifestFile=path.join(telemetry.root,"studies",studyId,"manifest.json"),manifest={schema:"jar.telemetry.study.v1",studyId,status:"INSTALLED_AWAITING_FIRST_REAL_EVENT",createdAt:now.toISOString(),t0:null,t1:null,days:telemetry.initialStudyDays,reviewedAt:null,protected:telemetry.protectUnreviewedStudy,configHash:telemetryConfigHash(telemetry),metricDefinitionVersion:METRIC_DEFINITION_VERSION};
    await atomicJson(manifestFile,manifest);active={file:manifestFile,manifest};
  }
  const healthFile=path.join(telemetry.root,"health","status.json");
  if(!fs.existsSync(healthFile))await atomicJson(healthFile,{schema:"jar.telemetry.health.v1",status:active.manifest.status,updatedAt:now.toISOString(),studyId:active.manifest.studyId,installationId:identity.installationId,knownLoss:{count:0,reasons:{}}});
  return {config:telemetry,identity,studyId:active.manifest.studyId,studyStatus:active.manifest.status,manifestFile:active.file,reusedStudy};
}

export async function disableTelemetry(options={}) {
  const existing=readJarConfig(options);
  if (!existing.telemetry) return {changed:false,enabled:false};
  const telemetry={...existing.telemetry,enabled:false};
  await atomicJson(configPath(options),{...existing,telemetry});
  return {changed:true,enabled:false,root:telemetry.root,spoolRoot:telemetry.spoolRoot};
}

export function telemetryConfigHash(config) {
  const safe={...config};
  return sha256(safe);
}

export function readTelemetryIdentity(options={}) {
  try { return JSON.parse(fs.readFileSync(identityPath(options),"utf8")); }
  catch { return null; }
}

export function readTelemetryKey(options={}) {
  try { return Buffer.from(fs.readFileSync(keyPath(options),"utf8").trim(),"base64"); }
  catch { return null; }
}

export async function writeJsonAtomic(file,value) { return atomicJson(file,value); }
