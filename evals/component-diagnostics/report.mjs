import fs from "node:fs";
import path from "node:path";
import {CAMPAIGN_ROOT,loadSpec,readJson,writeJson} from "./common.mjs";
import {loadState,saveState} from "./controller.mjs";

const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const range=values=>values.length?{min:Math.min(...values),max:Math.max(...values)}:null;
const sum=values=>values.reduce((a,b)=>a+(Number.isFinite(b)?b:0),0);
const finite=value=>Number.isFinite(value)?value:null;
const delta=(candidate,reference)=>Number.isFinite(candidate)&&Number.isFinite(reference)?candidate-reference:null;
const percentage=(difference,reference)=>Number.isFinite(difference)&&Number.isFinite(reference)&&reference!==0?difference/reference*100:null;
const slotFor=(state,run)=>state.plannedSlots.find(row=>row.slotId===run.slotId);
const contextBytes=run=>sum((run.measurements?.context?.items??[]).map(item=>item.bytes));

function usage(run){
  const raw=run.measurements?.mainModelUsage??{};
  const input=finite(raw.inputTokens),cached=finite(raw.cachedInputTokens);
  return {
    uncachedInputTokens:input!==null&&cached!==null?input-cached:null,
    cachedInputTokens:cached,
    inputTokens:input,
    outputTokens:finite(raw.outputTokens),
    reasoningOutputTokens:finite(raw.reasoningOutputTokens),
    totalTokens:finite(raw.totalTokens),
    inferenceCalls:null,
    inferenceCallsUnavailableReason:"Pinned runtime receipt exposes turn-level aggregate usage but not main-provider request count."
  };
}

function jev(run){
  const raw=run.jevUsage??{};
  const calls=finite(raw.calls??raw.attempted_requests);
  return {
    attemptedRequests:calls,
    settledRequests:calls,
    semanticQuestions:calls,
    inputTokens:finite(raw.input_tokens),
    outputTokens:finite(raw.output_tokens),
    latencyMs:finite(raw.latency_ms),
    errors:0,
    models:raw.models??[],
    accountingNote:"Completed Jev call summaries expose calls, tokens, and latency; calls are counted as both attempted and settled because no per-call rejection/error was recorded."
  };
}

function observation(state,run){
  const slot=slotFor(state,run),tools=run.measurements?.toolTimings??{};
  return {
    runId:run.runId,
    slotId:run.slotId,
    status:run.status,
    module:slot.module,
    suiteIds:slot.module==="M8"?slot.condition.suiteRefs:["m6-evidence-efficiency-v1"],
    family:slot.family,
    condition:slot.condition?.id??null,
    repetition:slot.repetition,
    armId:slot.armId,
    treatment:slot.treatment,
    identity:run.identity,
    correctness:{correct:run.evaluation?.correct??null,passed:run.evaluation?.passed??null,total:run.evaluation?.total??null,checks:run.evaluation?.checks??[]},
    mainModelUsage:usage(run),
    jevUsage:jev(run),
    wallTimeMs:finite(run.measurements?.wallTimeMs),
    directlyObservedStageTimings:{
      timeToFirstToolMs:finite(tools.timeToFirstToolMs),
      timeToFirstReadMs:finite(tools.timeToFirstReadMs),
      timeToFirstSearchMs:finite(tools.timeToFirstSearchMs),
      timeToFirstSuccessfulWriteMs:finite(tools.timeToFirstSuccessfulWriteMs),
      timeToFirstTestMs:finite(tools.timeToFirstTestMs),
      timeToFirstBuildMs:finite(tools.timeToFirstBuildMs)
    },
    toolUse:{calls:tools.toolCalls??0,fileReads:tools.fileReads??0,uniqueFilesRead:tools.uniqueFilesRead??0,repeatedFileReads:tools.repeatedFileReads??0,searches:tools.searches??0,testExecutions:tools.testExecutions??0,failedTestExecutions:tools.failedTestExecutions??0,buildExecutions:tools.buildExecutions??0,tools:tools.toolCounts??{}},
    suppliedContext:{strategy:run.measurements?.context?.strategy??null,items:(run.measurements?.context?.items??[]).length,bytes:contextBytes(run)},
    capabilityExposure:{strategy:run.measurements?.capabilities?.strategy??null,candidateCount:(run.measurements?.capabilities?.candidates??[]).length,exposedCount:(run.measurements?.capabilities?.selected??[]).length,withheldCount:(run.measurements?.capabilities?.withheld??[]).length,exposed:run.measurements?.capabilities?.selected??[]},
    isolation:{status:run.isolationAudit?.status??null,unexpectedPersonalContext:run.isolationAudit?.unexpectedPersonalContext??false,intendedJarExecution:run.intendedJarExecution??null,receipt:run.isolationAudit??null},
    economicMeasurement:{observedBilling:null,estimatedApiDollars:null,planCredits:null,reason:"No compatible request-level billing or credit observation was available; economic dominance is withheld."}
  };
}

function pairedDelta(candidate,reference){
  const c=candidate.mainModelUsage,r=reference.mainModelUsage,fields=["uncachedInputTokens","cachedInputTokens","inputTokens","outputTokens","totalTokens"],mainModelUsage={};
  for(const field of fields){const difference=delta(c[field],r[field]);mainModelUsage[field]={absolute:difference,percent:percentage(difference,r[field])};}
  const jFields=["attemptedRequests","settledRequests","semanticQuestions","inputTokens","outputTokens","latencyMs"],jevUsage={};
  for(const field of jFields){const difference=delta(candidate.jevUsage[field],reference.jevUsage[field]);jevUsage[field]={absolute:difference,percent:percentage(difference,reference.jevUsage[field])};}
  const wall=delta(candidate.wallTimeMs,reference.wallTimeMs),toolCalls=delta(candidate.toolUse.calls,reference.toolUse.calls),bytes=delta(candidate.suppliedContext.bytes,reference.suppliedContext.bytes);
  return {mainModelUsage,jevUsage,wallTimeMs:{absolute:wall,percent:percentage(wall,reference.wallTimeMs)},toolCalls:{absolute:toolCalls,percent:percentage(toolCalls,reference.toolUse.calls)},suppliedContextBytes:{absolute:bytes,percent:percentage(bytes,reference.suppliedContext.bytes)}};
}

function summaries(pairs){
  const treatments=[...new Set(pairs.map(row=>row.treatment))];
  return Object.fromEntries(treatments.map(treatment=>{
    const rows=pairs.filter(row=>row.treatment===treatment),tokens=rows.map(row=>row.deltas.mainModelUsage.totalTokens.absolute).filter(Number.isFinite),walls=rows.map(row=>row.deltas.wallTimeMs.absolute).filter(Number.isFinite),tools=rows.map(row=>row.deltas.toolCalls.absolute).filter(Number.isFinite),correctness=rows.map(row=>row.correctnessDelta);
    const classification=correctness.every(value=>value===0)&&mean(tokens)<0&&mean(walls)<0?"COST_AND_LATENCY_CANDIDATE":correctness.every(value=>value===0)&&mean(tokens)>0&&mean(walls)<0?"LATENCY_COST_TRADEOFF":"MIXED_OR_INCONCLUSIVE";
    return [treatment,{pairs:rows.length,classification,meanCorrectnessDelta:mean(correctness),meanTotalTokenDelta:mean(tokens),totalTokenDeltaRange:range(tokens),meanWallTimeDeltaMs:mean(walls),wallTimeDeltaRangeMs:range(walls),meanToolCallDelta:mean(tools),toolCallDeltaRange:range(tools),economicDominance:"WITHHELD_NO_COMPATIBLE_BILLING_BASIS"}];
  }));
}

function familySummaries(pairs){
  const keys=[...new Set(pairs.map(row=>`${row.treatment}|${row.family}`))];
  return keys.map(key=>{const [treatment,family]=key.split("|"),rows=pairs.filter(row=>row.treatment===treatment&&row.family===family);return{treatment,family,pairs:rows.length,meanCorrectnessDelta:mean(rows.map(row=>row.correctnessDelta)),meanTotalTokenDelta:mean(rows.map(row=>row.deltas.mainModelUsage.totalTokens.absolute).filter(Number.isFinite)),meanWallTimeDeltaMs:mean(rows.map(row=>row.deltas.wallTimeMs.absolute).filter(Number.isFinite)),meanToolCallDelta:mean(rows.map(row=>row.deltas.toolCalls.absolute).filter(Number.isFinite))};});
}

export function buildReport(){
  const state=loadState(),spec=loadSpec(),acceptance=readJson(path.join(CAMPAIGN_ROOT,"phase-1-acceptance.json")),mechanism=readJson(path.join(CAMPAIGN_ROOT,"mechanism-evaluation-only.json"));
  const runs=state.validRuns.map(ref=>readJson(path.join(CAMPAIGN_ROOT,ref.resultPath))),observations=runs.map(run=>observation(state,run)),group=new Map(),pairs=[];
  for(const row of observations){const key=row.module==="M8"?`${row.family}|${row.condition}|${row.repetition}`:`${row.family}|${row.repetition}`,members=group.get(key)??[];members.push(row);group.set(key,members);}
  for(const [key,rows] of group){const reference=rows.find(row=>row.armId==="REFERENCE_V1");if(!reference)continue;for(const candidate of rows.filter(row=>row!==reference)){pairs.push({key,module:candidate.module,family:candidate.family,condition:candidate.condition,repetition:candidate.repetition,treatment:candidate.treatment,referenceRunId:reference.runId,candidateRunId:candidate.runId,correctnessDelta:Number(candidate.correctness.correct)-Number(reference.correctness.correct),deltas:pairedDelta(candidate,reference)});}}
  const references=observations.filter(row=>row.armId==="REFERENCE_V1").map(row=>({runId:row.runId,slotId:row.slotId,suiteIds:row.suiteIds,family:row.family,condition:row.condition,repetition:row.repetition,date:readJson(path.join(CAMPAIGN_ROOT,state.validRuns.find(ref=>ref.runId===row.runId).resultPath)).finishedAt,sourceCommit:spec.source.canonicalV1Commit,treatmentHash:spec.treatments.find(item=>item.id==="v1").treatmentHash,runtimeHash:row.identity.runtimeHash,model:row.identity.model,effort:row.identity.effort,taskHash:row.identity.taskHash,workspaceInitialHash:row.identity.workspaceInitialHash,inventoryId:row.identity.inventoryId,profileConfigHash:row.identity.profileConfigHash,correct:row.correctness.correct,checks:row.correctness.checks,compatibilityEnvelope:"suite/task/gold/oracle/executor/model/runtime/repetition protocol plus V1 treatment identity"}));
  const invalidRunReceipts=state.invalidRuns.map(ref=>{const run=readJson(path.join(CAMPAIGN_ROOT,ref.resultPath));return{...ref,observed:run.measurements?observation(state,run):null,reason:ref.reason};});
  const accountedObservations=[...observations,...invalidRunReceipts.map(row=>row.observed).filter(Boolean)],jevTotals={attemptedRequests:sum(accountedObservations.map(row=>row.jevUsage.attemptedRequests)),settledRequests:sum(accountedObservations.map(row=>row.jevUsage.settledRequests)),semanticQuestions:sum(accountedObservations.map(row=>row.jevUsage.semanticQuestions)),inputTokens:sum(accountedObservations.map(row=>row.jevUsage.inputTokens)),outputTokens:sum(accountedObservations.map(row=>row.jevUsage.outputTokens)),latencyMs:sum(accountedObservations.map(row=>row.jevUsage.latencyMs))};
  const complete=state.nextIndex===state.plannedSlots.length&&!state.running&&state.validRuns.length===state.plannedSlots.length,summary=summaries(pairs);
  const shadowPath=path.join(CAMPAIGN_ROOT,"shadow-predictions","m8-cache-HIGH_CLOSURE_WIDE_INVENTORY.json"),shadowPrediction=fs.existsSync(shadowPath)?readJson(shadowPath):null;
  const report={
    schemaVersion:"jar.component-diagnostics.final.v2",
    status:complete?"M6_M8_PERMANENT_DIAGNOSTICS_COMPLETE":"M6_M8_DIAGNOSTICS_PARTIAL",
    generatedAt:new Date().toISOString(),
    campaignId:spec.campaignId,
    specHash:spec.freeze.specHash,
    source:{canonicalV1Commit:spec.source.canonicalV1Commit,implementationBaseCommit:spec.source.implementationCommit,checkpointBranch:"codex/m6-m8-permanent-diagnostics"},
    suites:spec.suites,
    commands:{list:"node evals/component-diagnostics/cli.mjs list",identity:"node evals/component-diagnostics/cli.mjs identity",preflight:"node evals/component-diagnostics/cli.mjs preflight",mechanism:"node evals/component-diagnostics/cli.mjs mechanism --suite <id|all> --treatment <id|all> --partition <development|calibration|evaluation-only|all>",dryRun:"node evals/component-diagnostics/cli.mjs campaign --dry-run",runSlot:"node evals/component-diagnostics/cli.mjs run-slot --slot <slot-id> --execute",resume:"node evals/component-diagnostics/cli.mjs resume --execute",report:"node evals/component-diagnostics/cli.mjs report"},
    state:{status:state.status,nextIndex:state.nextIndex,planned:state.plannedSlots.length,valid:state.validRuns.length,invalidCompletedRuns:state.invalidRuns.length,terminalInvalidCells:state.invalidCells.length,zeroTurnPrestartFailures:state.prestartInfrastructureRuns.length,startedProductTurns:state.startedProductTurns,absoluteTurnCap:40,replacementsUsed:state.replacementsUsed,replacementCap:4,phase1Jev:state.phase1Jev,phase2Jev:jevTotals,phase2JevCaps:{attemptedRequests:900,inputTokens:6000000},jointJevCaps:{attemptedRequests:1500,inputTokens:10000000},resumeCommand:state.resumeCommand,resumeBlocker:state.resumeBlocker??null},
    m8Blocker:{code:"FROZEN_M8_PAIR_INVENTORY_GATE_IDENTITY_DEFECT",description:"The REFERENCE_V1 and M8_OPERATIONAL_R1 arms did not have invariant incoming capability inventories or shadow-gate input hashes. Repair requires a new evaluation identity and fresh M8 campaign; the frozen v1 comparison cannot be resumed truthfully.",invalidCells:state.invalidCells,invalidCompletedRuns:invalidRunReceipts,zeroTurnPrestartFailures:state.prestartInfrastructureRuns,closureContrast:null,inventoryHeadroomContrast:null,sharedAnchorAccounting:"No valid shared anchor exists.",classification:"MIXED_OR_INCONCLUSIVE"},
    v1ReferenceManifest:references,
    missingV1References:{expected:16,valid:references.length,missing:16-references.length,m8Expected:12,m8Valid:0,m6Expected:4,m6Valid:references.length},
    observations,
    pairs,
    treatmentSummaries:summary,
    equalWeightTaskFamilySummaries:familySummaries(pairs),
    m6:{
      mechanismEvaluationOnly:{partition:mechanism.partition,mode:mechanism.mode,mainModelTurnsStarted:mechanism.mainModelTurnsStarted,jevHttpAttempts:mechanism.jevHttpAttempts,groups:mechanism.groups,rawRowsArtifact:"mechanism-evaluation-only.json"},
      historicalDiagnosis:spec.provenance.m6.empirical,
      oracleInterpretation:"Evaluation-only rows retain candidate-file recall, candidate-span recall, actual judge inputs, selected/delivered sufficient coverage, overdelivery, duplicates, byte/token estimates, materialization hashes, and oracle decomposition in the raw artifact. File recall is not treated as span or sufficient-set recall.",
      r1Disposition:{classification:summary["v1+m6-recall-r1"]?.classification??null,productPairs:summary["v1+m6-recall-r1"]??null},
      r2Disposition:{phase1Qualification:spec.refinement,classification:summary["v1+m6-evidence-r2"]?.classification??null,productPairs:summary["v1+m6-evidence-r2"]??null},
      oldGenerationalEvidence:"Unchanged historical exact-set evidence remains separate; no old gold, split, oracle, or score was rewritten."
    },
    shadowGate:{mode:"SHADOW_ONLY",prediction:shadowPrediction,semanticAdmissibilityResult:"UNINTERPRETABLE_FOR_PRODUCT_COMPARISON_DUE_TO_INPUT_IDENTITY_DEFECT",observedModeSelectionUtility:null,overhead:shadowPrediction?{latencyMs:shadowPrediction.latencyMs,providerUsage:shadowPrediction.providerUsage}:null,shadowReconstruction:null,reason:"No valid paired M8 branches exist from which to reconstruct a counterfactual."},
    phase1Acceptance:{status:acceptance.status,mainModelTurnsStarted:acceptance.mainModelTurnsStarted,jevUsage:acceptance.jevUsage,productCalibrationStatus:acceptance.productCalibration.status,isolationStatus:acceptance.isolation.status,dryRun:{plannedValidSlots:acceptance.controllerRehearsal.plannedValidSlots,referenceV1Slots:acceptance.controllerRehearsal.referenceV1Slots,absoluteCap:acceptance.controllerRehearsal.absoluteCap}},
    closureValidation:state.closureValidation??null,
    integrity:{evaluationIdentityArtifact:"experiment-identity.json",phase1AcceptanceArtifact:"phase-1-acceptance.json",isolationArtifact:"isolation/isolation-proof.json",perEpisodeIsolationRequired:true,allValidRunIsolationPassed:observations.every(row=>row.isolation.status==="PASS"),intendedJarTreatmentPreserved:observations.every(row=>row.isolation.intendedJarExecution&&Object.values(row.isolation.intendedJarExecution).every(Boolean))},
    conclusions:{supported:["The three versioned diagnostic suites and resumable controller are executable and Phase 1 passed its zero-product-turn acceptance gate.","On two M6 task families across two repetitions, V1, M6-r1, and M6-r2 all achieved complete deterministic product correctness.","M6-r1 reduced mean total main-model tokens and wall time relative to paired V1 in this exploratory sample.","M6-r2 reduced mean wall time but increased mean total main-model tokens relative to paired V1 in this exploratory sample."],refuted:["The frozen M8 campaign v1 can provide identity-valid lean-versus-operational contrasts; its paired inventory/gate contract is not invariant."],unknown:["M8 operational-closure and inventory-headroom effects.","Shadow-gate mode-selection usefulness and reconstruction.","Economic dominance for either M6 treatment because compatible request-level billing/credits were unavailable.","Generalization beyond two M6 product families."]},
    promotion:"NONE_AUTHORIZED_OR_PERFORMED",
    limitations:["Two product families per module; completed M6 conclusions are exploratory.","Repeated calls are repetitions, not independent task families.","M8 HIGH/LOW and WIDE/NARROW effects remain unmeasured because the frozen comparison identity was invalid.","Observed billing and compatible dollar conversion are unavailable; economic dominance is withheld.","Raw ignored evidence requires preservation of the worktree and canonical .jar storage; Git alone does not contain campaign runs."]
  };
  writeJson(path.join(CAMPAIGN_ROOT,"final-report.json"),report);
  const r1=summary["v1+m6-recall-r1"],r2=summary["v1+m6-evidence-r2"];
  fs.writeFileSync(path.join(CAMPAIGN_ROOT,"REPORT.md"),`# M6/M8 permanent diagnostics\n\nStatus: ${report.status}\n\nPhase 1: ${acceptance.status}. Phase 2 completed all 12 valid M6 slots; all were product-correct. The 24 M8 cells are terminal-invalid because the frozen pair did not hold incoming inventory and shadow-gate input identity constant. One M8 product turn was preserved as invalid; six earlier failures started zero product turns.\n\nStarted turns: ${state.startedProductTurns}/40. Valid runs: ${state.validRuns.length}/36. Valid V1 references: ${references.length}/16 (M6 4/4; M8 0/12). Jev usage from started product turns: ${jevTotals.attemptedRequests} calls, ${jevTotals.inputTokens} input tokens.\n\nM6-r1: ${r1.classification}; mean paired total-token delta ${r1.meanTotalTokenDelta}; mean wall-time delta ${r1.meanWallTimeDeltaMs} ms; correctness delta ${r1.meanCorrectnessDelta}.\n\nM6-r2: ${r2.classification}; mean paired total-token delta ${r2.meanTotalTokenDelta}; mean wall-time delta ${r2.meanWallTimeDeltaMs} ms; correctness delta ${r2.meanCorrectnessDelta}.\n\nNo economic-dominance or production-promotion claim is made. M8 requires a new versioned evaluation identity and fresh task campaign; the frozen v1 matrix cannot be resumed. Preserve this ignored evidence directory with the worktree/storage.\n`);
  if(complete){state.status="COMPLETE";saveState(state);}
  return report;
}
