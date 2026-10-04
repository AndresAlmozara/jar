import path from "node:path";
import {validateIdentity} from "./identity.mjs";
import {proveIsolation} from "./isolation.mjs";
import {calibrateProducts} from "./product-evaluator.mjs";
import {runMechanism} from "./mechanism.mjs";
import {dryRun,markPhase1} from "./controller.mjs";
import {CAMPAIGN_ROOT,writeJson} from "./common.mjs";

export async function runPreflight(){
  const identity=validateIdentity(),isolation=proveIsolation(),calibration=await calibrateProducts(),development=await runMechanism({suite:"all",partition:"development"}),calibrationMechanism=await runMechanism({suite:"all",partition:"calibration"}),plan=dryRun(),r1d=development.groups["v1+m6-recall-r1"],r2d=development.groups["v1+m6-evidence-r2"],r1c=calibrationMechanism.groups["v1+m6-recall-r1"],r2c=calibrationMechanism.groups["v1+m6-evidence-r2"],
    qualified=[r1d,r2d,r1c,r2c].every(Boolean)&&r2d.fail===0&&r2c.fail===0&&r2d.means.deliveredSufficientCoverage>=r1d.means.deliveredSufficientCoverage&&r2c.means.deliveredSufficientCoverage>=r1c.means.deliveredSufficientCoverage&&r2d.means.deliveredBytes<r1d.means.deliveredBytes&&r2c.means.deliveredBytes<r1c.means.deliveredBytes,
    checks={identity:identity.status==="PASS",isolation:isolation.status==="PASS",productCalibration:calibration.status==="PASS",m6Cases:development.rows.filter(x=>x.treatment==="v1+m6-recall-r1"||x.treatment==="v1+m6-evidence-r2").length+calibrationMechanism.rows.filter(x=>x.treatment==="v1+m6-recall-r1"||x.treatment==="v1+m6-evidence-r2").length===36,m8Adapters:[development,calibrationMechanism].every(r=>r.groups["v1+m8-operational-r1"]?.fail===0),r2Qualified:qualified,plan36:plan.plannedValidSlots===36&&plan.referenceV1Slots===16,zeroProductTurns:plan.mainModelTurnsStarted===0};
  const report={schemaVersion:"jar.component-diagnostics.preflight.v1",status:Object.values(checks).every(Boolean)?"PERMANENT_DIAGNOSTICS_FROZEN_READY":"FAIL",mainModelTurnsStarted:0,jevUsage:{attempted:0,inputTokens:0},checks,identity,isolation,productCalibration:calibration,mechanism:{development,calibration:calibrationMechanism},controllerRehearsal:plan};
  writeJson(path.join(CAMPAIGN_ROOT,"phase-1-acceptance.json"),report);markPhase1({status:report.status,mainModelTurnsStarted:0,report:"phase-1-acceptance.json"});if(report.status!=="PERMANENT_DIAGNOSTICS_FROZEN_READY")throw Object.assign(Error("PHASE1_ACCEPTANCE_FAILED"),{code:"PHASE1_ACCEPTANCE_FAILED",report});return report;
}
