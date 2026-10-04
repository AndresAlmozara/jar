#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 } from "../packages/core/src/hash.js";
import { readTelemetryConfig } from "../packages/telemetry/src/config.js";
import { runTelemetryCommand } from "../packages/telemetry/src/cli.js";

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const RUNTIME_SCHEMA="jar.runtime.schema.v1";
const MARKETPLACE="jar-v1-local";
const PLUGIN="jar-v1-codex";
const runtimePaths=[
  "package.json",
  "packages/core/src/hash.js","packages/core/src/ids.js",
  "packages/catalog-adapters/ecc/src/ecc-catalog-adapter.js",
  "packages/skill-routing/src/common.js","packages/skill-routing/src/invocation.js","packages/skill-routing/src/ecc-native.js",
  "packages/repository-context/src/contracts.js","packages/repository-context/src/common.js","packages/repository-context/src/invocation.js","packages/repository-context/src/candidates.js","packages/repository-context/src/local-repository.js","packages/repository-context/src/deterministic.js",
  "packages/telemetry/src/config.js","packages/telemetry/src/schema.js","packages/telemetry/src/recorder.js","packages/telemetry/src/metrics.js","packages/telemetry/src/maintenance.js","packages/telemetry/src/native-usage.js","packages/telemetry/src/zip.js","packages/telemetry/src/cli.js",
  "packages/runtime-adapters/codex/src/daily-driver.js"
];

const homeDefault=()=>process.env.JAR_HOME||path.join(process.env.USERPROFILE||process.env.HOME||os.homedir(),".jar");
async function copyFile(root,relative,destination){const target=path.join(destination,relative);await fsp.mkdir(path.dirname(target),{recursive:true});await fsp.copyFile(path.join(root,relative),target)}
async function atomicJson(file,value){await fsp.mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;await fsp.writeFile(temp,`${JSON.stringify(value,null,2)}\n`);await fsp.rename(temp,file)}
function sourceCommit(root){try{return execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","ignore"]}).trim()}catch{return "unknown"}}
function fileIdentity(root,relative){const data=fs.readFileSync(path.join(root,relative));return {path:relative.replaceAll("\\","/"),sha256:sha256(data.toString("base64")),size:data.length}}
function contentIdentity(files){return sha256(files.map(({path,sha256,size})=>({path,sha256,size})))}
async function copyTree(from,to){for(const entry of await fsp.readdir(from,{withFileTypes:true})){const source=path.join(from,entry.name),target=path.join(to,entry.name);if(entry.isDirectory()){await fsp.mkdir(target,{recursive:true});await copyTree(source,target)}else if(entry.isFile()){await fsp.mkdir(path.dirname(target),{recursive:true});await fsp.copyFile(source,target)}}}
function treeIdentity(root){const files=[];function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile()){const data=fs.readFileSync(file);files.push({path:path.relative(root,file).replaceAll("\\","/"),sha256:sha256(data.toString("base64")),size:data.length})}}}walk(root);return contentIdentity(files)}
function codexEnvironment(){const user=process.env.USERPROFILE||process.env.HOME||os.homedir();return {...process.env,USERPROFILE:user,CODEX_HOME:process.env.CODEX_HOME||path.join(user,".codex")}}
function codex(args){return spawnSync("codex",args,{encoding:"utf8",windowsHide:true,env:codexEnvironment()})}
function jsonFromStdout(result){try{return JSON.parse(result.stdout)}catch{return null}}
function pluginManifest(pluginRoot){
  for(const relative of ["plugin.json",path.join(".codex-plugin","plugin.json")]){
    const candidate=path.join(pluginRoot,relative);if(fs.existsSync(candidate))return JSON.parse(fs.readFileSync(candidate,"utf8"));
  }
  throw new Error(`Plugin manifest missing under ${pluginRoot}`);
}

async function installLauncher(jarHome){
  const binDir=path.join(jarHome,"bin");await fsp.mkdir(binDir,{recursive:true});
  const launcher=`#!/usr/bin/env node\nimport fs from "node:fs";import path from "node:path";import {fileURLToPath,pathToFileURL} from "node:url";\nconst home=process.env.JAR_HOME||path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");const current=JSON.parse(fs.readFileSync(path.join(home,"current.json"),"utf8"));const command=process.argv[2]||"status";let result;if(command==="telemetry"){const cli=await import(pathToFileURL(path.join(current.runtimeRoot,"packages/telemetry/src/cli.js")).href);result=await cli.runTelemetryCommand(process.argv[3],process.argv.slice(4),{jarHome:home})}else{const runtime=await import(pathToFileURL(path.join(current.runtimeRoot,current.entrypoint)).href);result=command==="doctor"?await runtime.doctorReport({jarHome:home,current}):await runtime.statusReport({jarHome:home,current})}process.stdout.write(JSON.stringify(result,null,2)+"\\n");process.exitCode=result.ok===false?2:0;\n`;
  await fsp.writeFile(path.join(binDir,"jar.mjs"),launcher);
  if(process.platform==="win32"){
    const commandPath=path.join(binDir,"jar.cmd"),marker=":: JAR_V1_OWNED_LAUNCHER";await fsp.writeFile(commandPath,`${marker}\r\n@node \"${path.join(binDir,"jar.mjs")}\" %*\r\n`);
    const script="$p=[Environment]::GetEnvironmentVariable('Path','User');$b=$env:JAR_BIN_PATH;if(-not (($p -split ';') -contains $b)){[Environment]::SetEnvironmentVariable('Path',(($p.TrimEnd(';')+';'+$b).Trim(';')),'User')}";
    spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,env:{...process.env,JAR_BIN_PATH:binDir}});
  }
}

function removeLauncherPath(jarHome){
  if(process.platform!=="win32")return;
  const script="$p=[Environment]::GetEnvironmentVariable('Path','User');$b=$env:JAR_BIN_PATH;$n=(($p -split ';' | Where-Object {$_ -and $_ -ne $b}) -join ';');[Environment]::SetEnvironmentVariable('Path',$n,'User')";
  spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,env:{...process.env,JAR_BIN_PATH:path.join(jarHome,"bin")}});
}

export async function buildInstallation({jarHome=homeDefault(),root=sourceRoot,register=true,launcher=register}={}){
  const commit=sourceCommit(root),files=runtimePaths.map(relative=>fileIdentity(root,relative)),contentHash=contentIdentity(files),runtimeId=`jar-v1-${commit.slice(0,12)}-${contentHash.slice(0,12)}-s1`;
  await fsp.mkdir(jarHome,{recursive:true});await atomicJson(path.join(jarHome,"ownership.json"),{schema:"jar.install.ownership.v1",owner:"jev-agentic-router",paths:["runtimes","marketplace","state","bin","private","telemetry-spool","current.json","config.json"]});
  const runtimeRoot=path.join(jarHome,"runtimes",runtimeId),manifestPath=path.join(runtimeRoot,"runtime-manifest.json");
  if(!fs.existsSync(manifestPath)){
    const stage=path.join(jarHome,"runtimes",`.stage-${process.pid}-${Date.now()}`);await fsp.mkdir(stage,{recursive:true});
    try{for(const relative of runtimePaths)await copyFile(root,relative,stage);const manifest={schema:RUNTIME_SCHEMA,product:"JAR V1",runtimeId,runtimeSchema:"1",sourceCommit:commit,contentHash,entrypoint:"packages/runtime-adapters/codex/src/daily-driver.js",files,createdAt:new Date().toISOString()};await atomicJson(path.join(stage,"runtime-manifest.json"),manifest);await fsp.rename(stage,runtimeRoot)}catch(error){await fsp.rm(stage,{recursive:true,force:true});throw error}
  }
  const current={schema:"jar.current.v1",product:"JAR V1",runtimeId,runtimeSchema:"1",sourceCommit:commit,contentHash,runtimeRoot,entrypoint:"packages/runtime-adapters/codex/src/daily-driver.js",activatedAt:new Date().toISOString()};await atomicJson(path.join(jarHome,"current.json"),current);
  const marketplaceRoot=path.join(jarHome,"marketplace"),pluginRoot=path.join(marketplaceRoot,"plugins",PLUGIN);await fsp.rm(pluginRoot,{recursive:true,force:true});await copyTree(path.join(root,"integrations","codex-plugin"),pluginRoot);
  await atomicJson(path.join(marketplaceRoot,".agents","plugins","marketplace.json"),{name:MARKETPLACE,interface:{displayName:"JAR Local"},plugins:[{name:PLUGIN,source:{source:"local",path:`./plugins/${PLUGIN}`},policy:{installation:"AVAILABLE",authentication:"ON_INSTALL"},category:"Developer Tools"}]});
  if(launcher)await installLauncher(jarHome);
  let telemetry={state:"launcher_not_installed"};
  if(launcher){
    let existing=null;try{existing=readTelemetryConfig({jarHome})}catch(error){telemetry={state:"malformed_config_preserved",code:error.code||"JAR_TELEMETRY_CONFIG_INVALID"}}
    if(telemetry.state!=="malformed_config_preserved"){
      if(existing?.enabled===false)telemetry={state:"explicitly_disabled_preserved"};
      else try{telemetry=await runTelemetryCommand("enable",["--root",existing?.root||path.join(root,".jar","telemetry"),"--study-days",String(existing?.initialStudyDays||14)],{jarHome})}catch(error){telemetry={state:"enablement_failed",code:error.code||"JAR_TELEMETRY_ENABLE_FAILED",message:error.message}}
    }
  }
  const registration={marketplace:"skipped",plugin:"skipped"};
  if(register){
    const listed=codex(["plugin","marketplace","list","--json"]),catalog=jsonFromStdout(listed);const present=Array.isArray(catalog)?catalog.some(x=>x.name===MARKETPLACE):JSON.stringify(catalog||{}).includes(MARKETPLACE);
    if(!present){const added=codex(["plugin","marketplace","add",marketplaceRoot,"--json"]);if(added.status!==0)throw new Error(`Marketplace registration failed: ${added.stderr||added.stdout}`);registration.marketplace="added"}else registration.marketplace="present";
    const installed=codex(["plugin","list","--json"]),plugins=jsonFromStdout(installed),pluginRecord=plugins?.installed?.find(x=>x.pluginId===`${PLUGIN}@${MARKETPLACE}`),pluginVersion=pluginManifest(pluginRoot).version;
    const cacheRoot=path.join(codexEnvironment().CODEX_HOME,"plugins","cache",MARKETPLACE,PLUGIN,pluginVersion),cacheCurrent=pluginRecord?.version===pluginVersion&&fs.existsSync(cacheRoot)&&treeIdentity(cacheRoot)===treeIdentity(pluginRoot);
    if(pluginRecord&&!cacheCurrent){const removed=codex(["plugin","remove",`${PLUGIN}@${MARKETPLACE}`,"--json"]);if(removed.status!==0)throw new Error(`Plugin refresh removal failed: ${removed.stderr||removed.stdout}`);registration.plugin="refreshed"}
    if(!pluginRecord||!cacheCurrent){const added=codex(["plugin","add",`${PLUGIN}@${MARKETPLACE}`,"--json"]);if(added.status!==0)throw new Error(`Plugin installation failed: ${added.stderr||added.stdout}`);if(registration.plugin!=="refreshed")registration.plugin="added"}else registration.plugin="present";
  }
  return {ok:true,runtimeId,sourceCommit:commit,contentHash,runtimeRoot,pluginRoot,marketplaceRoot,registration,telemetry,trustAction:"Start one Codex session, review the JAR hook definitions, and choose Trust."};
}

export async function uninstallInstallation({jarHome=homeDefault(),unregister=true}={}){
  let ownership;try{ownership=JSON.parse(await fsp.readFile(path.join(jarHome,"ownership.json"),"utf8"))}catch{throw new Error("Refusing to uninstall an unowned path")};if(ownership.schema!=="jar.install.ownership.v1"||ownership.owner!=="jev-agentic-router")throw new Error("Refusing to uninstall an unowned path");
  if(unregister){codex(["plugin","remove",`${PLUGIN}@${MARKETPLACE}`,"--json"]);codex(["plugin","marketplace","remove",MARKETPLACE,"--json"])}
  if(unregister)removeLauncherPath(jarHome);
  if(unregister&&process.platform==="win32"){try{const prefix=execFileSync("npm",["prefix","-g"],{encoding:"utf8",windowsHide:true}).trim(),commandPath=path.join(prefix,"jar.cmd");if(fs.existsSync(commandPath)&&fs.readFileSync(commandPath,"utf8").includes("JAR_V1_OWNED_LAUNCHER"))await fsp.rm(commandPath)}catch{}}
  await fsp.rm(jarHome,{recursive:true,force:true});return {ok:true,removed:jarHome};
}

async function report(command){
  const jarHome=homeDefault(),current=JSON.parse(await fsp.readFile(path.join(jarHome,"current.json"),"utf8")),runtime=await import(pathToFileURL(path.join(current.runtimeRoot,current.entrypoint)).href);
  return command==="doctor"?runtime.doctorReport({jarHome,current}):runtime.statusReport({jarHome,current});
}

if(path.resolve(process.argv[1]||"")===fileURLToPath(import.meta.url)){
  const command=process.argv[2]||"install",skip=process.argv.includes("--skip-register");let result;
  if(command==="install"||command==="update")result=await buildInstallation({register:!skip});
  else if(command==="uninstall")result=await uninstallInstallation({unregister:!skip});
  else if(command==="status"||command==="doctor")result=await report(command);
  else throw new Error(`Unknown Codex plugin manager command: ${command}`);
  process.stdout.write(`${JSON.stringify(await result,null,2)}\n`);
}
