import { sha256 } from "../../core/src/hash.js";
import { renderRoutingContext } from "./common.js";

// Keep routing evidence, but provider events alone own usage/model/per-call latency.
function routingEvidence(value) {
  if (Array.isArray(value)) return value.map(routingEvidence);
  if (!value || typeof value!=="object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key])=>!["call","provider","usage","raw","telemetry","invocation"].includes(key))
    .map(([key,item])=>[key,routingEvidence(item)]));
}

export function strategyConfiguration(strategy) {
  const fields=["limit","batchSize","concurrency","shortlistFloor","verificationThreshold","finalists","maxSelected","shortlistSize","fitThreshold"];
  const project=value=>Object.fromEntries(fields.filter(key=>typeof value[key]==="number").map(key=>[key,value[key]]));
  return {...project(strategy),...(strategy.hermes?{hermes:project(strategy.hermes)}:{})};
}

export function tournamentEvent(result,input) {
  const visible=input.runtime?.visibleSkills;
  return {event_type:"skill_shadow_run",task_id:result.task_id,tournament_run_id:result.tournament_run_id,
    session_id:result.session_id,version:result.version,shadow:true,execution:result.execution,
    task_hash:sha256(input.task),state_hash:sha256(renderRoutingContext(input.task,input.session)),
    state_rendering:"routing-context-v1; max 16000 characters",
    catalog_hash:input.catalog.hash,catalog_version:input.catalog.version??null,catalog_source:input.catalog.source,
    initial_candidate_count:input.catalog.skills.length,
    runtime_visibility:{state:Array.isArray(visible)?"known":"unknown",count:Array.isArray(visible)?visible.length:null},
    strategies:result.results.map(arm=>({strategy_id:arm.strategy_id,strategy_version:arm.strategy_version,strategy_invocation_id:arm.invocation_id}))};
}

export function strategyEvent(result,arm) {
  const {decision,candidates}=arm.proposal;
  return {event_type:"skill_shadow_result",task_id:result.task_id,session_id:result.session_id,
    tournament_run_id:result.tournament_run_id,strategy_id:arm.strategy_id,strategy_version:arm.strategy_version,
    strategy_invocation_id:arm.invocation_id,catalog_hash:result.catalog_hash,shadow:true,
    latency_ms:arm.latency_ms,configuration:arm.configuration,
    candidates:routingEvidence(candidates),decision:routingEvidence(decision)};
}
