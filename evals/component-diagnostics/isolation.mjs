import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {liveProfile} from "../../packages/runtime-adapters/codex/src/live-profile.js";
import {CAMPAIGN_ROOT,sha,treeIdentity,writeJson,fileHash} from "./common.mjs";

const forbidden=["hooks","apps","plugins","remote_plugin","skill_search","tool_search","multi_agent","multi_agent_v2","memories","memory_tool"];
export function auditProfile(profile,{normalCodexHome=path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),".codex"))}={}){
  const c=profile.config,checks={ownedCodexHome:path.resolve(profile.codexHome)!==normalCodexHome,hooksDisabled:c["features.hooks"]===false,
    pluginsDisabled:c["features.plugins"]===false&&c["features.apps"]===false&&Object.keys(c.plugins??{}).length===0&&Object.keys(c.marketplaces??{}).length===0,
    mcpEmpty:Object.keys(c.mcp_servers??{}).length===0,skillsDisabled:c["skills.include_instructions"]===false&&c["skills.bundled.enabled"]===false&&c["cloud.skills.enabled"]===false,
    projectDocsDisabled:c.project_doc_max_bytes===0&&(c.project_doc_fallback_filenames??[]).length===0,historyDisabled:c["history.persistence"]==="none",
    environmentDenied:c["shell_environment_policy.inherit"]==="none"&&c.include_environment_context===false,
    completeFeatureDeny:forbidden.every(name=>c[`features.${name}`]===false),ephemeral:profile.thread.ephemeral===true&&(profile.thread.environments??[]).length===0&&(profile.thread.selectedCapabilityRoots??[]).length===0};
  return{status:Object.values(checks).every(Boolean)?"PASS":"FAIL",checks,configHash:profile.configHash,codexHomeHash:sha(path.resolve(profile.codexHome))};
}
export function createMeasuredProfile({workspaceRoot,codexHome,model="gpt-5.6-sol"}){
  const profile=liveProfile({workspaceRoot,codexHome,model,envKey:"JAR_ACCESS_TOKEN"}),audit=auditProfile(profile);
  if(audit.status!=="PASS")throw Object.assign(Error("MEASURED_PROFILE_CONTAMINATED"),{code:"MEASURED_PROFILE_CONTAMINATED",audit});
  return{profile,audit};
}
function protectedSnapshot(){
  const home=os.homedir(),codex=path.join(home,".codex"),jar=path.join(home,".jar"),runtime=path.join(home,".cache","codex-runtimes","codex-primary-runtime");
  return{normalCodexHomeConfig:fileHash(path.join(codex,"config.toml")),trust:fileHash(path.join(codex,"trust.json")),installedJar:treeIdentity(path.join(codex,"plugins","cache","jar-v1-local")),
    dailyDriverState:treeIdentity(path.join(jar,"state")),runtimePointer:treeIdentity(runtime,{exclude:["dependencies"]})};
}
export function proveIsolation(){
  const root=path.join(CAMPAIGN_ROOT,"isolation"),workspace=path.join(root,"workspace"),owned=path.join(root,"owned-codex-home");fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(owned,{recursive:true});
  const before=protectedSnapshot(),{profile,audit}=createMeasuredProfile({workspaceRoot:workspace,codexHome:owned});
  const canaryHome=path.join(root,"contaminated-canary-home"),canaryWorkspace=path.join(root,"canary-workspace");fs.mkdirSync(canaryHome,{recursive:true});fs.mkdirSync(canaryWorkspace,{recursive:true});
  const contaminated={...profile,codexHome:path.resolve(canaryHome),config:{...profile.config,"features.hooks":true,"features.plugins":true}};
  const canaryAudit=auditProfile(contaminated),canaryRejected=canaryAudit.status==="FAIL";
  const after=protectedSnapshot(),protectedUnchanged=JSON.stringify(before)===JSON.stringify(after),proof={schemaVersion:"jar.component-diagnostics.isolation.v1",status:audit.status==="PASS"&&canaryRejected&&protectedUnchanged?"PASS":"FAIL",mainModelTurnsStarted:0,
    evaluator:{role:"frozen-driver",personalJarEccContextAllowed:false,audit},measuredSessions:{profileFactory:"createMeasuredProfile",perEpisodeAuditRequired:true,intendedJarTreatmentRequired:true},
    canary:{description:"intentionally enabled personal hook/plugin flags",rejected:canaryRejected,audit:canaryAudit},protectedState:{before,after,unchanged:protectedUnchanged}};
  writeJson(path.join(root,"isolation-proof.json"),proof);if(proof.status!=="PASS")throw Object.assign(Error("PLUGIN_ISOLATION_NOT_PROVEN"),{code:"PLUGIN_ISOLATION_NOT_PROVEN",proof});return proof;
}
