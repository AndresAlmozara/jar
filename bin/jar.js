#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { EccCatalogAdapter } from "../packages/catalog-adapters/ecc/src/ecc-catalog-adapter.js";
import { JsonlTelemetryStore } from "../packages/telemetry/src/jsonl-store.js";
import { replayTask } from "../packages/evals/src/replay.js";
import { OpenCodeObserver } from "../packages/runtime-adapters/opencode/src/observer.js";
import { JevDecisionEngine, TypeSafeClient } from "../packages/decision-providers/jev/src/index.js";
import { runSkillShadow, formatSkillShadow } from "./skill-shadow.js";
import { runContextShadow, formatContextShadow } from "./context-shadow.js";
import { runCapabilityShadow, formatCapabilityShadow } from "./capability-shadow.js";
import { runAssistCommand, formatAssist } from "./codex-assist.js";
import { prepareLiveCommand } from './codex-live-prepare.js';
import { prepareLiveV1 } from './codex-live-v1.js';
import { jevEnvironmentAuth } from '../packages/runtime-adapters/codex/src/live-profile.js';
import { ChatGptAuthService, ChatGptAuthError, runtimeAuthFromStatus } from '../packages/auth/chatgpt/src/index.js';
import { statusReport, doctorReport } from '../packages/runtime-adapters/codex/src/daily-driver.js';
import { runTelemetryCommand, telemetryUsage } from '../packages/telemetry/src/cli.js';

function arg(name, fallback=null) {
  const i=process.argv.indexOf(name);
  return i>=0 ? process.argv[i+1] : fallback;
}
function has(name){return process.argv.includes(name)}
function out(value){process.stdout.write(`${typeof value==="string"?value:JSON.stringify(value,null,2)}\n`)}
function usage(){out(`JAR 0.1.0\n\nCommands:\n  jar status\n  jar doctor\n  ${telemetryUsage().replaceAll("\n","\n  ")}\n  jar catalog inspect --ecc-root <path> [--json]\n  jar catalog validate --ecc-root <path>\n  jar jev probe [--trace-dir <path>]\n  jar trace show <task-id> [--trace-dir <path>]\n  jar trace attach-catalog <task-id> --ecc-root <path> [--trace-dir <path>]\n  jar replay <task-id> [--trace-dir <path>]\n  jar demo trace\n`)}

async function main(){
  const [,,group,cmd,...rest]=process.argv;
  if(group==='status'){out(await statusReport());return;}
  if(group==='doctor'){const result=await doctorReport();out(result);if(!result.ok)process.exitCode=2;return;}
  if(group==='telemetry'){const result=await runTelemetryCommand(cmd,rest);out(result);if(result.ok===false)process.exitCode=2;return;}
  if(group==='auth'){
    const allowed=new Set(['--json']);for(const value of rest)if(!allowed.has(value))throw new TypeError('Unknown auth option');
    const service=new ChatGptAuthService();
    if(cmd==='chatgpt'){out({status:'authenticated',...(await service.signIn())});return;}
    if(cmd==='status'){out(await service.status());return;}
    if(cmd==='logout'){out(await service.logout());return;}
    throw new TypeError('Unknown auth command');
  }
  if(group==='assist' && cmd==='codex' && !has('--help')){
    if(has('--manifest')){
      const values=new Set(['--manifest','--mode','--provider','--strategy','--auth-mode','--env-key','--model']),switches=new Set(['--prepare','--execute-live','--allow-network','--json']);
      const seen=new Set();for(let i=0;i<rest.length;i++){const flag=rest[i];if(seen.has(flag)||(!values.has(flag)&&!switches.has(flag)))throw Error('Unknown or duplicate live preparation option');seen.add(flag);
        if(values.has(flag)){if(!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Missing preparation value');i++;}}
      if(['environment','jar-oauth'].includes(arg('--auth-mode'))){
        let mainAuth=null,acquireAccessToken=null;
        if(arg('--auth-mode')==='jar-oauth'){
          if(has('--env-key'))throw Error('JAR_OAUTH_ENV_KEY_IS_INTERNAL');
          const service=new ChatGptAuthService(),status=await service.status();mainAuth=runtimeAuthFromStatus(status);
          acquireAccessToken=()=>service.usableAccessToken();
        }
        out(await prepareLiveV1({manifestPath:arg('--manifest'),mode:arg('--mode','ASSIST'),prepareOnly:has('--prepare'),
          executeLive:has('--execute-live'),allowNetwork:has('--allow-network'),provider:arg('--provider','offline'),strategy:arg('--strategy','deterministic'),
          envKey:arg('--env-key','JAR_ACCESS_TOKEN'),model:arg('--model'),mainAuth,acquireAccessToken}));return;
      }
      if(has('--env-key')||has('--model'))throw Error('ENVIRONMENT_AUTH_MODE_REQUIRED');
      out(await prepareLiveCommand({manifestPath:arg('--manifest'),mode:arg('--mode','ASSIST'),prepareOnly:has('--prepare'),executeLive:has('--execute-live'),allowNetwork:has('--allow-network'),provider:arg('--provider','offline'),authMode:arg('--auth-mode',null)}));return;
    }
    const allowed=new Set(['--task','--inventory','--mode','--strategy','--prepare','--surfaces','--json']);
    for(let i=0;i<rest.length;i++){
      if(!allowed.has(rest[i]))throw new TypeError('Unknown Codex Assist option');
      if(!['--prepare','--json'].includes(rest[i])){if(!rest[i+1]||rest[i+1].startsWith('--'))throw new TypeError('Missing Assist option value');i++;}
    }
    const result=await runAssistCommand({taskText:arg('--task'),inventorySource:arg('--inventory'),mode:arg('--mode','ASSIST'),
      provider:arg('--strategy','deterministic'),prepareOnly:has('--prepare'),surfaces:arg('--surfaces','none')});
    out(has('--json')?result:formatAssist(result));if(result.status==='failed')process.exitCode=2;return;
  }
  if(!group||group==='help'||has('--help'))out('  jar assist codex --task "..." --inventory fixture|coding-fixture [--mode ASSIST|CONTROL] [--strategy deterministic|jev-mock] [--surfaces none|skills,context,output-shadow] [--prepare] [--json] (pinned isolated fixture only; coding-fixture uses scripted loopback provider, not live reasoning; output stays Shadow; --prepare stages with zero runtime/provider calls; no live auth/network support)');
  if(!group||group==='help'||has('--help'))out('  jar auth chatgpt | jar auth status | jar auth logout');
  if(!group||group==='help'||has('--help'))out('  jar assist codex --manifest <reviewed-workspace.json> --prepare --auth-mode jar-oauth --model <model> [--mode ASSIST|CONTROL] [--strategy deterministic|jev-live] [--json] (zero provider calls; live execution additionally requires --provider live --execute-live --allow-network)');
  if(group==="capability" && cmd==="shadow" && !has("--help")){
    if(has("--live") || has("--trace-dir"))throw new TypeError("Capability Shadow is offline and read-only");
    const result=await runCapabilityShadow({taskText:arg("--task"),inventorySource:arg("--inventory")});
    out(has("--json")?result:formatCapabilityShadow(result));
    if(result.results.some(r=>r.outcome==="error"))process.exitCode=2;
    return;
  }
  if (!group || group==="help" || has("--help")) out('  jar capability shadow --task "..." --inventory <fixture|file.json> [--json] (offline, read-only)');
  if (!group || group==="help" || has("--help")){usage();out('  jar skill shadow --task "..." --ecc-root <path> [--strategy <id>] [--offline] [--json] [--trace-dir <path>]\n  ECC_ROOT may supply --ecc-root. Default is live Shadow; --offline is synthetic verification only.\n  jar context shadow --repo-root <path> --task "..." [--strategy <id>] [--json] [--trace-dir <path>]\n  Context is offline-only; no writes unless --trace-dir is supplied.');return;}
  if(group==="context" && cmd==="shadow"){
    if(has("--live"))throw new TypeError("Context Shadow CLI is offline-only");
    const result=await runContextShadow({repoRoot:arg("--repo-root"),taskText:arg("--task"),strategyId:arg("--strategy"),traceDir:arg("--trace-dir")});
    out(has("--json")?result:formatContextShadow(result));
    if(result.recording.status==="incomplete"||result.results.some(a=>["error","unsupported"].includes(a.outcome)))process.exitCode=2;
    return;
  }
  if(group==="skill" && cmd==="shadow"){
    const result=await runSkillShadow({taskText:arg("--task"),eccRoot:arg("--ecc-root",process.env.ECC_ROOT),strategyId:arg("--strategy"),offline:has("--offline"),traceDir:arg("--trace-dir",path.join(process.cwd(),".jar","traces"))});
    out(has("--json")?result:formatSkillShadow(result));
    if(result.recording.status==="incomplete"||result.results.some(arm=>arm.outcome==="error"))process.exitCode=2;
    return;
  }
  if(group==="catalog"){
    const root=arg("--ecc-root",process.cwd()); const a=new EccCatalogAdapter(root);
    if(cmd==="inspect"){
      const s=await a.snapshot();
      if(has("--json")) out(s); else out({source:s.source,hash:s.hash,counts:{skills:s.skills.length,agents:s.agents.length,components:s.components.length,profiles:Object.keys(s.profiles).length},skills:s.skills.map(x=>({id:x.id,description:x.description.slice(0,120)}))});
      return;
    }
    if(cmd==="validate"){ const r=await a.validate(); out(r); process.exitCode=r.ok?0:2; return; }
  }
  if(group==="jev" && cmd==="probe"){
    const readiness=jevEnvironmentAuth();
    if(!readiness.credentialPresent){out({ok:false,status:'JEV_AUTHORIZATION_REQUIRED',provider:'typesafe',model:readiness.model,
      envKey:readiness.envKey,requests:0,usage:null});process.exitCode=2;return;}
    const traceDir=arg("--trace-dir",path.join(process.cwd(),".jar","traces"));
    const store=new JsonlTelemetryStore(path.join(traceDir,"events.jsonl"));
    const client=new TypeSafeClient();
    const engine=new JevDecisionEngine({client,onTelemetry:(event)=>store.append(event)});
    const models=await engine.listModels();
    const result=await engine.choice({taskId:`jev-probe-${Date.now()}`,state:"Fix a failing PostgreSQL migration and add regression tests.",instructions:"Which area best describes this task?",criteria:{database:"Database schema, migrations, or persistence",testing:"Tests or test infrastructure",frontend:"User interface work",documentation:"Documentation-only work"}});
    out({ok:true,available_models:models.map((model)=>model.name),model:result.provider.model,latency_ms:result.latency_ms,choice:result.choice,probabilities:result.probabilities,confidence:result.confidence,usage:result.usage});
    return;
  }
  if(group==="trace" && cmd==="show"){
    const taskId=rest[0]; if(!taskId) throw new Error("task id required");
    const dir=arg("--trace-dir",path.join(process.cwd(),".jar","traces"));
    const store=new JsonlTelemetryStore(path.join(dir,"events.jsonl")); out(store.byTask(taskId)); return;
  }
  if(group==="trace" && cmd==="attach-catalog"){
    const taskId=rest[0]; if(!taskId) throw new Error("task id required");
    const root=arg("--ecc-root"); if(!root) throw new Error("--ecc-root is required");
    const dir=arg("--trace-dir",path.join(process.cwd(),".jar","traces"));
    const store=new JsonlTelemetryStore(path.join(dir,"events.jsonl"));
    const catalog=await new EccCatalogAdapter(root).snapshot();
    store.append({event_type:"catalog_snapshot",task_id:taskId,catalog_version:catalog.hash,payload:catalog});
    out({ok:true,taskId,catalogHash:catalog.hash}); return;
  }
  if(group==="replay"){
    const taskId=cmd; if(!taskId) throw new Error("task id required");
    const dir=arg("--trace-dir",path.join(process.cwd(),".jar","traces"));
    const store=new JsonlTelemetryStore(path.join(dir,"events.jsonl"));
    const replay=replayTask(store.readAll(),taskId); if(!replay){process.exitCode=2;out({error:"task not found",taskId});return;} out(replay); return;
  }
  if(group==="demo" && cmd==="trace"){
    const observer=new OpenCodeObserver({directory:process.cwd()});
    observer.onSessionCreated({id:"demo-session"});
    const taskId=observer.onPrompt({text:"Fix the failing persistence test and add coverage."});
    observer.onContext({tools:{read:{},bash:{},edit:{}}});
    observer.onToolBefore({tool:"read",input:{file_path:"src/persistence.ts"}});
    observer.onFileEdited({path:"src/persistence.ts"});
    observer.onToolAfter({tool:"read"});
    observer.onSessionIdle({});
    const fixtureRoot=path.resolve(path.dirname(new URL(import.meta.url).pathname),"../fixtures/ecc-mini");
    const catalog=await new EccCatalogAdapter(fixtureRoot).snapshot();
    observer.store.append({event_type:"catalog_snapshot",task_id:taskId,catalog_version:catalog.hash,payload:catalog});
    out({ok:true,taskId,traceFile:observer.traceFile,catalogHash:catalog.hash}); return;
  }
  usage(); process.exitCode=2;
}
main().catch((e)=>{if(e instanceof ChatGptAuthError){console.error(e.code);}
  else console.error(e.stack||e.message||String(e));process.exitCode=1});
