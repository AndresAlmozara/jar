import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {strategyIdentity} from "../../benchmark/run.mjs";
import {sha256} from "../../../packages/core/src/hash.js";
import {buildPlan,SUITES} from "./plan.mjs";
import {CAMPAIGN_ROOT,EVIDENCE_REPO,REPO,fileHash,loadSpec,writeJson} from "./common.mjs";

const git=(cwd,...args)=>{const result=spawnSync("git",["-c",`safe.directory=${cwd.replaceAll("\\","/")}`,...args],{cwd,encoding:"utf8"});if(result.status!==0)throw Object.assign(Error("GIT_IDENTITY_FAILED"),{code:"GIT_IDENTITY_FAILED",stderr:result.stderr,args});return result.stdout.trim();};
function canonicalWorktree(){const rows=git(REPO,"worktree","list","--porcelain").split(/\r?\n\r?\n/).map(block=>Object.fromEntries(block.split(/\r?\n/).map(line=>{const at=line.indexOf(" ");return at<0?[line,true]:[line.slice(0,at),line.slice(at+1)];})));return rows.find(row=>row.branch==="refs/heads/main")?.worktree??null;}

export function validateIdentity(){
  const spec=loadSpec(),checks=[],plan=buildPlan();
  for(const treatment of spec.treatments){
    const identity=strategyIdentity(REPO,treatment.id),actual=sha256(identity);
    const diff=spawnSync("git",["-c",`safe.directory=${REPO.replaceAll("\\","/")}`,"diff","--exit-code","--ignore-cr-at-eol",spec.source.startingCheckpoint,"--",...treatment.sourceFiles],{cwd:REPO,encoding:"utf8"});
    const semanticUnchanged=diff.status===0;
    checks.push({kind:"treatment",id:treatment.id,expectedHistoricalHash:treatment.treatmentHash,currentPlatformMaterializationHash:actual,lineEndingInsensitiveSourceUnchanged:semanticUnchanged,pass:semanticUnchanged});
    if(treatment.m8Hash)checks.push({kind:"component",id:`${treatment.id}:M8`,expectedHistoricalHash:treatment.m8Hash,currentPlatformMaterializationHash:identity.m8.sha256,lineEndingInsensitiveSourceUnchanged:semanticUnchanged,pass:semanticUnchanged});
  }
  for(const [id,relative] of Object.entries(spec.evaluationIdentity.sources)){const actual=fileHash(path.join(REPO,relative)),expected=spec.evaluationIdentity.sourceHashes[id];checks.push({kind:"source",id,expected,actual,pass:actual===expected});}
  checks.push({kind:"plan",id:plan.planId,expected:spec.evaluationIdentity.planHash,actual:sha256(plan),pass:sha256(plan)===spec.evaluationIdentity.planHash});
  checks.push({kind:"suite",id:"v2-registrations",expected:2,actual:SUITES.length,pass:SUITES.length===2});
  const oldRoot=path.join(EVIDENCE_REPO,".jar","evaluation","component-diagnostics","m6-m8-permanent-v1"),oldState=path.join(oldRoot,"campaign-state.json");
  checks.push({kind:"superseded-evidence",id:"m8-v1-preserved",expected:"present",actual:fs.existsSync(oldState)?"present":"missing",pass:fs.existsSync(oldState)});
  const canonical=canonicalWorktree();
  if(canonical)for(const [id,ref,expected] of [["main","HEAD",spec.source.canonicalV1Commit],["origin/main","origin/main",spec.source.canonicalV1Commit],["daily-driver-tag",`${spec.source.dailyDriverTag}^{commit}`,spec.source.canonicalV1Commit]]){let actual=null;try{actual=git(canonical,"rev-parse",ref);}catch{}checks.push({kind:"canonical-ref",id,expected,actual,pass:actual===expected});}
  else checks.push({kind:"canonical-ref",id:"main-worktree",expected:"present",actual:null,pass:false});
  const report={schemaVersion:"jar.m8-diagnostics.identity.v2",status:checks.every(check=>check.pass)?"PASS":"FAIL",specHash:spec.freeze.specHash,startingCheckpoint:spec.source.startingCheckpoint,canonicalWorktree:canonical,checks};
  writeJson(path.join(CAMPAIGN_ROOT,"experiment-identity.json"),report);
  if(report.status!=="PASS")throw Object.assign(Error("M8_V2_IDENTITY_FAILED"),{code:"M8_V2_IDENTITY_FAILED",report});
  return report;
}
