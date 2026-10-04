import path from "node:path";
import { newId } from "../packages/core/src/ids.js";
import { EccCatalogAdapter } from "../packages/catalog-adapters/ecc/src/ecc-catalog-adapter.js";
import { JsonlTelemetryStore } from "../packages/telemetry/src/jsonl-store.js";
import { JevDecisionEngine } from "../packages/decision-providers/jev/src/index.js";
import { SkillShadowTournament, EccNativeSkillStrategy, HermesTwoStageSkillStrategy, RetrievalRerankSkillStrategy, EccHermesSkillStrategy, EccHierarchySkillStrategy } from "../packages/skill-routing/src/index.js";

export const SKILL_STRATEGIES=["skill/ecc-native-v1","skill/hermes-two-stage-v1","skill/skillranker-v1","skill/ecc-hermes-v1","skill/ecc-hierarchy-v1"];

// Synthetic connectivity-free verification only; never presented as model judgment.
export function offlineSkillEngine() {
  return {choice:async input=>{
    const choice=Object.keys(input.criteria).find(id=>!id.startsWith("__"));
    return {choice,confidence:1,probabilities:{[choice]:1}};
  },noul:async()=>({probability_true:1,probability_false:0})};
}

export function createSkillStrategies(decisionEngine,strategyId=null) {
  if (strategyId&&!SKILL_STRATEGIES.includes(strategyId)) throw new TypeError("Unknown skill strategy ID");
  const classes=[EccNativeSkillStrategy,HermesTwoStageSkillStrategy,RetrievalRerankSkillStrategy,EccHermesSkillStrategy,EccHierarchySkillStrategy];
  return classes.filter((_,index)=>!strategyId||SKILL_STRATEGIES[index]===strategyId).map(Strategy=>new Strategy({decisionEngine}));
}

export async function runSkillShadow({taskText,eccRoot,strategyId=null,offline=false,traceDir=path.join(process.cwd(),".jar","traces")}) {
  if (typeof taskText!=="string"||!taskText.trim()) throw new TypeError("--task is required");
  if (!eccRoot) throw new TypeError("--ecc-root or ECC_ROOT is required");
  if (strategyId&&!SKILL_STRATEGIES.includes(strategyId)) throw new TypeError("Unknown skill strategy ID");
  const catalog=await new EccCatalogAdapter(eccRoot).snapshot();
  if (!catalog.skills.length) throw new TypeError("ECC catalog contains no skills");
  const events=[];const store=new JsonlTelemetryStore(path.join(traceDir,"events.jsonl"));
  const execution_mode=offline?"offline-synthetic":"live-shadow";
  const onTelemetry=event=>{events.push(event);return store.append({...event,execution_mode})};
  const engine=offline?offlineSkillEngine():new JevDecisionEngine({onTelemetry});
  const task={id:newId("task"),text:taskText,createdAt:new Date().toISOString()};
  // No ambient runtime/session is invented. Missing visibility remains unknown.
  const result=await new SkillShadowTournament({onTelemetry}).run({task,catalog,strategies:createSkillStrategies(engine,strategyId)});
  const summaries=result.results.map(arm=>{
    const d=arm.proposal.decision,p=d.provenance;
    const calls=events.filter(e=>e.event_type==="decision_provider_result"&&e.decision_context?.invocation_id===arm.invocation_id);
    const tokens=key=>p.jevCallCount===0?0:calls.length===p.jevCallCount&&calls.every(c=>Number.isInteger(c[key]))?calls.reduce((sum,c)=>sum+c[key],0):null;
    return {strategy_id:arm.strategy_id,invocation_id:arm.invocation_id,outcome:d.outcome,reason:d.reason,selected_skill_ids:d.selectedSkillIds,
      initial_candidates:p.initialCandidateCount??p.inputCandidateCount??catalog.skills.length,
      post_policy_candidates:p.remainingCandidateCount??p.postFilterCandidateCount??catalog.skills.length,
      selected_group:p.selectedGroupId??null,retrieval_shortlist:p.retrievalShortlist??null,
      hermes:p.hermes?{batchCount:p.hermes.batchCount,stage1Survivors:p.hermes.stage1Survivors,stage2:p.hermes.stage2?.map(({id,accepted})=>({id,accepted}))}:p.batchCount!==undefined?{batchCount:p.batchCount,stage1Survivors:p.stage1Survivors,stage2:p.stage2?.map(({id,accepted})=>({id,accepted}))}:null,
      provider_models:[...new Set(calls.map(c=>c.provider_model).filter(Boolean))],jev_calls:p.jevCallCount,decision_calls:p.decisionCalls,
      usage:{input_tokens:tokens("input_tokens"),output_tokens:tokens("output_tokens")},latency_ms:arm.latency_ms,error:d.error};
  });
  return {execution_mode,task_id:task.id,tournament_run_id:result.tournament_run_id,catalog_hash:catalog.hash,catalog_source:catalog.source,skill_count:catalog.skills.length,
    recording:result.recording,trace_file:store.filePath,results:summaries};
}

export function formatSkillShadow(result) {
  return [`Shadow only (${result.execution_mode}) — ${result.tournament_run_id}`,...result.results.map(arm=>
    `${arm.strategy_id}\n  outcome: ${arm.outcome}\n  selected: ${arm.selected_skill_ids.join(", ")||"—"}\n  reason: ${arm.reason}${arm.selected_group?`\n  group: ${arm.selected_group}`:""}\n  calls: ${arm.jev_calls??"unknown"}; latency: ${arm.latency_ms.toFixed(1)} ms`),
    `Telemetry: ${result.recording.status} (${result.trace_file})`].join("\n\n");
}
