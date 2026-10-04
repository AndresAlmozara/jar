#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const jarHome=path.resolve(process.env.JAR_HOME||path.join(process.env.USERPROFILE||process.env.HOME||os.homedir(),".jar")),current=JSON.parse(await fsp.readFile(path.join(jarHome,"current.json"),"utf8")),runtime=await import(`${pathToFileURL(path.join(current.runtimeRoot,current.entrypoint)).href}?validation=${Date.now()}`),maintenance=await import(pathToFileURL(path.join(current.runtimeRoot,"packages/telemetry/src/maintenance.js")).href),configModule=await import(pathToFileURL(path.join(current.runtimeRoot,"packages/telemetry/src/config.js")).href),initialStudy=(await maintenance.telemetryStatus({jarHome})).study,root=await fsp.mkdtemp(path.join(os.tmpdir(),"jar-telemetry-activation-")),state=path.join(root,"state"),priorState=process.env.JAR_STATE_DIR,startedAt=new Date().toISOString();

async function lifecycle(directory,index){
  const common={session_id:`validation-session-${index}-${Date.now()}`,turn_id:`validation-turn-${index}`,cwd:directory,model:"validation-model",permission_mode:"default"},options={jarHome,current,dataOrigin:"validation"};
  await runtime.handleCodexHook({...common,hook_event_name:"SessionStart",source:"startup"},options);
  await runtime.handleCodexHook({...common,hook_event_name:"UserPromptSubmit",prompt:"Validate bounded telemetry lifecycle without inference."},options);
  await runtime.handleCodexHook({...common,hook_event_name:"PreToolUse",tool_name:"read",tool_use_id:`validation-call-${index}`,tool_input:{file_path:path.join(directory,"fixture.js")}},options);
  await runtime.handleCodexHook({...common,hook_event_name:"PostToolUse",tool_name:"read",tool_use_id:`validation-call-${index}`,tool_response:{status:"validation"}},options);
  await runtime.handleCodexHook({...common,hook_event_name:"Stop"},options);
  await runtime.handleCodexHook({...common,hook_event_name:"SessionEnd"},options);
}

try{
  process.env.JAR_STATE_DIR=state;
  const directories=[];
  for(let i=1;i<=2;i++){const directory=path.join(root,`git-${i}`);await fsp.mkdir(directory);await fsp.writeFile(path.join(directory,"fixture.js"),`export const fixture${i}=true;\n`);execFileSync("git",["init"],{cwd:directory,stdio:"ignore",windowsHide:true});directories.push(directory)}
  const plain=path.join(root,"plain");await fsp.mkdir(plain);await fsp.writeFile(path.join(plain,"fixture.js"),"export const plain=true;\n");directories.push(plain);
  for(let i=0;i<directories.length;i++)await lifecycle(directories[i],i+1);
  const maintained=await maintenance.maintainTelemetry({jarHome}),config=configModule.readTelemetryConfig({jarHome}),archive=await maintenance.readArchivedEvents(config),validation=archive.events.filter(event=>event.data_origin==="validation"&&event.observed_at_utc>=startedAt),repositories=new Set(validation.map(event=>event.repository_id).filter(Boolean)),sessions=new Set(validation.map(event=>event.session_id).filter(Boolean));
  const studyPreserved=maintained.study?.studyId===initialStudy?.studyId&&maintained.study?.t0===initialStudy?.t0,passed=repositories.size===3&&sessions.size===3&&validation.some(x=>x.event_name==="routing.observed")&&validation.some(x=>x.event_name==="tool.started")&&validation.some(x=>x.event_name==="tool.finished")&&studyPreserved;
  process.stdout.write(`${JSON.stringify({schema:"jar.telemetry.activation-validation.v1",passed,runtimeId:current.runtimeId,centralRoot:config.root,temporarySources:{gitRepositories:2,nonGitDirectories:1},observed:{events:validation.length,repositories:repositories.size,sessions:sessions.size},studyStatus:maintained.study?.status,t0:maintained.study?.t0,studyPreserved},null,2)}\n`);if(!passed)process.exitCode=2;
}finally{if(priorState===undefined)delete process.env.JAR_STATE_DIR;else process.env.JAR_STATE_DIR=priorState;await fsp.rm(root,{recursive:true,force:true})}
