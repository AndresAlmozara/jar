import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {strategyIdentity} from "../benchmark/run.mjs";
import {DATASET_IDENTITY,SUITES} from "./datasets.mjs";
import {buildPlan} from "./plan.mjs";
import {CAMPAIGN_ROOT,REPO,fileHash,loadSpec,sha,writeJson} from "./common.mjs";

const git=(cwd,...args)=>{const r=spawnSync("git",["-c",`safe.directory=${cwd.replaceAll("\\","/")}`,...args],{cwd,encoding:"utf8"});if(r.status!==0)throw Object.assign(Error("GIT_IDENTITY_FAILED"),{code:"GIT_IDENTITY_FAILED",stderr:r.stderr,args});return r.stdout.trim();};
function canonicalWorktree(){const rows=git(REPO,"worktree","list","--porcelain").split(/\r?\n\r?\n/).map(block=>Object.fromEntries(block.split(/\r?\n/).map(line=>{const at=line.indexOf(" ");return at<0?[line,true]:[line.slice(0,at),line.slice(at+1)];})));return rows.find(x=>x.branch==="refs/heads/main")?.worktree??null;}
export function validateIdentity(){
  const spec=loadSpec(),checks=[],expected=new Map(spec.treatments.filter(x=>x.treatmentHash).map(x=>[x.id,x]));
  for(const [id,frozen] of expected){const identity=strategyIdentity(REPO,id),actual=sha(JSON.stringify(identity));checks.push({kind:"treatment",id,expected:frozen.treatmentHash,actual,pass:actual===frozen.treatmentHash});if(frozen.m6Hash)checks.push({kind:"component",id:`${id}:M6`,expected:frozen.m6Hash,actual:identity.m6.sha256,pass:identity.m6.sha256===frozen.m6Hash});if(frozen.m8Hash)checks.push({kind:"component",id:`${id}:M8`,expected:frozen.m8Hash,actual:identity.m8.sha256,pass:identity.m8.sha256===frozen.m8Hash});}
  const files={"r2":path.join(REPO,"packages/repository-context/src/evidence-efficiency-r2.js"),"gate":path.join(REPO,"evals/component-diagnostics/shadow-gate.mjs"),"runner":path.join(REPO,"evals/component-diagnostics/live.mjs"),"evaluator":path.join(REPO,"evals/component-diagnostics/product-evaluator.mjs"),"datasets":path.join(REPO,"evals/component-diagnostics/datasets.mjs"),"mechanism":path.join(REPO,"evals/component-diagnostics/mechanism.mjs"),"controller":path.join(REPO,"evals/component-diagnostics/controller.mjs")},fileExpected={r2:spec.treatments.find(x=>x.id==="v1+m6-evidence-r2").sourceHash,gate:spec.shadowGate.sourceHash,runner:spec.evaluationIdentity.runnerHash,evaluator:spec.evaluationIdentity.evaluatorHash,datasets:spec.evaluationIdentity.datasetsSourceHash,mechanism:spec.evaluationIdentity.mechanismRunnerHash,controller:spec.evaluationIdentity.controllerHash};
  for(const [id,file] of Object.entries(files)){const actual=fileHash(file),want=fileExpected[id];checks.push({kind:"source",id,expected:want,actual,pass:actual===want});}
  for(const key of ["m6","m8","products","suiteRegistry"]){const actual=DATASET_IDENTITY[key],want=spec.datasetIdentity[key];checks.push({kind:"dataset",id:key,expected:want,actual,pass:actual===want});}
  const planHash=sha(JSON.stringify(buildPlan({r2Qualified:true})));checks.push({kind:"plan",id:"generated-plan",expected:spec.evaluationIdentity.planHash,actual:planHash,pass:planHash===spec.evaluationIdentity.planHash});checks.push({kind:"suite",id:"registrations",expected:3,actual:SUITES.length,pass:SUITES.length===3});
  const canonical=canonicalWorktree();if(canonical){for(const [id,ref,want] of [["main","HEAD",spec.source.canonicalV1Commit],["origin/main","origin/main",spec.source.canonicalV1Commit],["daily-driver-tag",`${spec.source.dailyDriverTag}^{commit}`,spec.source.canonicalV1Commit]]){let actual=null;try{actual=git(canonical,"rev-parse",ref);}catch{}checks.push({kind:"canonical-ref",id,expected:want,actual,pass:actual===want});}}
  else checks.push({kind:"canonical-ref",id:"main-worktree",expected:"present",actual:null,pass:false});
  const report={schemaVersion:"jar.component-diagnostics.identity.v1",status:checks.every(x=>x.pass)?"PASS":"FAIL",specHash:spec.freeze.specHash,canonicalWorktree:canonical,checks};writeJson(path.join(CAMPAIGN_ROOT,"experiment-identity.json"),report);if(report.status!=="PASS")throw Object.assign(Error("DIAGNOSTIC_IDENTITY_FAILED"),{code:"DIAGNOSTIC_IDENTITY_FAILED",report});return report;
}
