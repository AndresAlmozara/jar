import fs from "node:fs";
import path from "node:path";
import {buildPlan} from "./plan.mjs";
import {loadPairIdentity} from "./pair-identity.mjs";
import {CAMPAIGN_ROOT,STATE_PATH,loadSpec,now,readJson,writeJson} from "./common.mjs";

export function initialState(){
  const spec=loadSpec(),plan=buildPlan();
  return{schemaVersion:"jar.m8-diagnostics.campaign-state.v2",campaignId:spec.campaignId,specHash:spec.freeze.specHash,planId:plan.planId,status:"READY",createdAt:now(),updatedAt:now(),nextIndex:0,startedProductTurns:0,validProductTurns:0,invalidInfraTurns:0,zeroTurnPreflightRejects:0,zeroTurnSetupFailures:0,replacementsUsed:0,jevUsage:{attemptedRequests:0,inputTokens:0,outputTokens:0},reservedJev:{attemptedRequests:0,inputTokens:0},plannedSlots:plan.slots,validRuns:[],invalidRuns:[],running:null,acceptance:null,resumeCommand:"node evals/component-diagnostics/m8-v2/cli.mjs resume --execute"};
}
export function saveState(state){state.updatedAt=now();writeJson(STATE_PATH,state);return state;}
export function loadState({create=false}={}){if(!fs.existsSync(STATE_PATH)){if(!create)throw Object.assign(Error("M8_V2_STATE_MISSING"),{code:"M8_V2_STATE_MISSING"});return saveState(initialState());}const state=readJson(STATE_PATH),spec=loadSpec();if(state.specHash!==spec.freeze.specHash)throw Object.assign(Error("M8_V2_STATE_SPEC_MISMATCH"),{code:"M8_V2_STATE_SPEC_MISMATCH"});return state;}
export function dryRun(){const state=loadState({create:true});return{status:"DRY_RUN",mainModelTurnsStarted:0,plannedPairs:12,plannedValidTurns:state.plannedSlots.length,absoluteStartedTurnCap:28,commands:state.plannedSlots.map(slot=>`node evals/component-diagnostics/m8-v2/cli.mjs run-slot --slot ${slot.slotId} --execute`),resumeCommand:state.resumeCommand};}
export function productAttemptFor(invalidRuns,slotId){return invalidRuns.filter(row=>row.slotId===slotId&&row.mainModelTurnsStarted===1).length+1;}

export function beginSlot(slotId){
  const state=loadState({create:true});
  if(state.running)throw Object.assign(Error("STARTED_UNRESOLVED"),{code:"STARTED_UNRESOLVED",running:state.running});
  const slot=state.plannedSlots[state.nextIndex];
  if(!slot||slot.slotId!==slotId)throw Object.assign(Error("SLOT_OUT_OF_FROZEN_ORDER"),{code:"SLOT_OUT_OF_FROZEN_ORDER",expected:slot?.slotId,received:slotId});
  loadPairIdentity(slot.pairId);
  if(state.startedProductTurns+1>28)throw Object.assign(Error("STARTED_TURN_CAP"),{code:"STARTED_TURN_CAP"});
  if(state.reservedJev.attemptedRequests+slot.reservation.jevAttempts>600||state.reservedJev.inputTokens+slot.reservation.jevInputTokens>4000000)throw Object.assign(Error("M8_V2_JEV_RESERVATION_CAP"),{code:"M8_V2_JEV_RESERVATION_CAP"});
  const attempt=productAttemptFor(state.invalidRuns,slot.slotId);
  if(attempt>2)throw Object.assign(Error("REPLACEMENT_EXHAUSTED"),{code:"REPLACEMENT_EXHAUSTED"});
  if(attempt===2&&state.replacementsUsed>=4)throw Object.assign(Error("GLOBAL_REPLACEMENT_CAP"),{code:"GLOBAL_REPLACEMENT_CAP"});
  const runOrdinal=state.validRuns.length+state.invalidRuns.length+1,runId=`${String(runOrdinal).padStart(2,"0")}-m8v2-${Math.random().toString(16).slice(2,10)}`,runDir=path.join(CAMPAIGN_ROOT,"live-runs",runId);
  if(attempt===2)state.replacementsUsed++;
  state.reservedJev.attemptedRequests+=slot.reservation.jevAttempts;state.reservedJev.inputTokens+=slot.reservation.jevInputTokens;
  state.running={...slot,attempt,runId,runDir,claimedAt:now(),productTurnStarted:false,status:"CLAIMED"};state.status="RUNNING";saveState(state);return state.running;
}
export function markTurnStarted(runId){const state=loadState(),running=state.running;if(!running||running.runId!==runId)throw Object.assign(Error("RUN_RECEIPT_MISMATCH"),{code:"RUN_RECEIPT_MISMATCH"});if(!running.productTurnStarted){state.startedProductTurns++;running.productTurnStarted=true;running.startedAt=now();running.status="STARTED_UNRESOLVED";saveState(state);}return running;}

export function finishSlot(result){
  const state=loadState(),running=state.running;
  if(!running||running.runId!==result.runId)throw Object.assign(Error("RUN_RECEIPT_MISMATCH"),{code:"RUN_RECEIPT_MISMATCH"});
  state.reservedJev.attemptedRequests-=running.reservation.jevAttempts;state.reservedJev.inputTokens-=running.reservation.jevInputTokens;
  state.jevUsage.attemptedRequests+=result.jevUsage?.calls??result.jevUsage?.attempted_requests??0;state.jevUsage.inputTokens+=result.jevUsage?.input_tokens??0;state.jevUsage.outputTokens+=result.jevUsage?.output_tokens??0;
  const receipt={slotId:running.slotId,pairId:running.pairId,runId:running.runId,attempt:running.attempt,status:result.status,resultPath:path.relative(CAMPAIGN_ROOT,path.join(running.runDir,"result.json")).replaceAll("\\","/"),mainModelTurnsStarted:result.mainModelTurnsStarted??0,finishedAt:now()};
  if(result.status==="COMPLETE"&&receipt.mainModelTurnsStarted===1){state.validRuns.push(receipt);state.validProductTurns++;state.nextIndex++;state.status=state.nextIndex===state.plannedSlots.length?"AWAITING_REPORT":"READY";}
  else if(receipt.mainModelTurnsStarted===0){state.invalidRuns.push(receipt);state.zeroTurnSetupFailures++;state.status="SETUP_RECOVERY_REQUIRED";}
  else{state.invalidRuns.push(receipt);state.invalidInfraTurns++;state.status=running.attempt===1?"REPLACEMENT_READY":"INVALID_TERMINAL";if(running.attempt===2)state.nextIndex++;}
  state.running=null;return saveState(state);
}
export function markAcceptance(acceptance){const state=loadState({create:true});state.acceptance=acceptance;return saveState(state);}
