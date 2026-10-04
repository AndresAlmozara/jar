import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {PRODUCT_FAMILIES} from "../datasets.mjs";
import {materializeProduct,evaluateProduct} from "../product-evaluator.mjs";
import {validateIdentity} from "./identity.mjs";
import {proveIsolation} from "./isolation.mjs";
import {runPairPreflight} from "./pair-identity.mjs";
import {runNegativeRegressions,runV1Preservation} from "./regression.mjs";
import {dryRun,markAcceptance} from "./controller.mjs";
import {CAMPAIGN_ROOT,writeJson} from "./common.mjs";

async function calibrateM8Products(){const rows=[];for(const family of ["m8-cache","m8-redaction"]){const definition=PRODUCT_FAMILIES[family],starter=fs.mkdtempSync(path.join(os.tmpdir(),"jar-m8-v2-starter-")),good=fs.mkdtempSync(path.join(os.tmpdir(),"jar-m8-v2-good-"));try{materializeProduct(family,starter);materializeProduct(family,good);fs.writeFileSync(path.join(good,"src","index.js"),definition.knownGoodSource);const broken=await evaluateProduct(family,starter),knownGood=await evaluateProduct(family,good);rows.push({family,pass:!broken.correct&&knownGood.correct,starter:broken,knownGood});}finally{fs.rmSync(starter,{recursive:true,force:true});fs.rmSync(good,{recursive:true,force:true});}}return{status:rows.every(row=>row.pass)?"PASS":"FAIL",rows};}
export async function runPreflight(){const identity=validateIdentity(),isolation=proveIsolation(),negative=runNegativeRegressions(),v1Preservation=await runV1Preservation(),productCalibration=await calibrateM8Products(),pairPreflight=runPairPreflight(),plan=dryRun(),checks={identity:identity.status==="PASS",isolation:isolation.status==="PASS",negativeRegression:negative.status==="PASS",v1Preservation:v1Preservation.status==="PASS",productCalibration:productCalibration.status==="PASS",pairPreflight:pairPreflight.status==="PASS"&&pairPreflight.passedPairs===12,plan:plan.plannedPairs===12&&plan.plannedValidTurns===24,zeroProductTurns:plan.mainModelTurnsStarted===0};const report={schemaVersion:"jar.m8-diagnostics.pre-live-acceptance.v2",status:Object.values(checks).every(Boolean)?"M8_V2_FROZEN_READY":"FAIL",mainModelTurnsStarted:0,checks,identity,isolation,negativeRegression:negative,v1Preservation,productCalibration,pairPreflight,controllerRehearsal:plan};writeJson(path.join(CAMPAIGN_ROOT,"pre-live-acceptance.json"),report);markAcceptance({status:report.status,mainModelTurnsStarted:0,report:"pre-live-acceptance.json"});if(report.status!=="M8_V2_FROZEN_READY")throw Object.assign(Error("M8_V2_PREFLIGHT_FAILED"),{code:"M8_V2_PREFLIGHT_FAILED",report});return report;}
