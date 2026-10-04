import test from "node:test";
import assert from "node:assert/strict";
import {buildPlan,SUITES} from "./plan.mjs";
import {canonicalConditionInventory,canonicalExposureInput,canonicalGateInput} from "./inventory.mjs";
import {assertPairIdentity} from "./pair-identity.mjs";
import {runNegativeRegressions,runV1Preservation} from "./regression.mjs";
import {productAttemptFor} from "./controller.mjs";

test("registers only the two superseding M8 v2 evaluators",()=>{assert.deepEqual(SUITES.map(row=>row.id),["m8-operational-closure-v2","m8-inventory-headroom-v2"]);assert.ok(SUITES.every(row=>row.version==="2.0.0"&&row.supersedes.endsWith("-v1")));});
test("freezes 12 pairs and 24 sequential M8 turns without M6",()=>{const plan=buildPlan();assert.equal(plan.pairs.length,12);assert.equal(plan.slots.length,24);assert.ok(plan.slots.every(row=>row.family.startsWith("m8-")&&!row.slotId.includes("M6")));assert.equal(plan.slots.filter(row=>row.armId==="REFERENCE_V1").length,12);assert.equal(plan.slots.filter(row=>row.armId==="M8_OPERATIONAL_R1").length,12);});
test("both arms admit the exact same canonical pre-treatment identity",()=>{const canonical=canonicalConditionInventory("BROAD"),task={id:"task",text:"Inspect, modify, and execute tests.",createdAt:"2026-10-03T00:00:00.000Z"},input=canonicalExposureInput({task,inventory:canonical.inventory}),gate=canonicalGateInput({taskText:task.text,mapping:canonical.mapping}),base={inventory:canonical.inventory,input,gate},check=assertPairIdentity({armId:"REFERENCE_V1",treatment:"v1",...base},{armId:"M8_OPERATIONAL_R1",treatment:"v1+m8-operational-r1",...base});assert.equal(check.pass,true);});
test("rejects treatment-dependent inventory and differing shadow inputs",()=>{const report=runNegativeRegressions();assert.equal(report.status,"PASS");assert.ok(report.cases.every(row=>row.rejected));});
test("preserves V1 strategy, selected native capabilities, and downstream schemas",async()=>{const report=await runV1Preservation();assert.equal(report.status,"PASS");assert.ok(report.rows.every(row=>row.operationalMetadataExcludedFromDynamicTools));});
test("zero-turn setup failures do not consume product replacement attempts",()=>{const rows=[{slotId:"slot",mainModelTurnsStarted:0},{slotId:"slot",mainModelTurnsStarted:0}];assert.equal(productAttemptFor(rows,"slot"),1);rows.push({slotId:"slot",mainModelTurnsStarted:1});assert.equal(productAttemptFor(rows,"slot"),2);});
