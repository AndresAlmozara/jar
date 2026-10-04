import path from "node:path";
import { newId } from "../packages/core/src/ids.js";
import { JsonlTelemetryStore } from "../packages/telemetry/src/jsonl-store.js";
import { LocalRepositoryAdapter, DeterministicContextStrategy, OkoContextStrategy, ContextShadowTournament } from "../packages/repository-context/src/index.js";

export const CONTEXT_STRATEGIES=["context/deterministic-v1","context/oko-v1"];
// Label-independent connectivity-free integration mock; not semantic evidence.
export const offlineContextEngine=()=>({noul:async()=>({probability_true:0.8,probability_false:0.2})});
export function createContextStrategies(engine=offlineContextEngine(),strategyId=null) {
  if(strategyId&&!CONTEXT_STRATEGIES.includes(strategyId))throw new TypeError("Unknown context strategy ID");
  return [new DeterministicContextStrategy(),new OkoContextStrategy({decisionEngine:engine})].filter(s=>!strategyId||s.id===strategyId);
}
export async function runContextShadow({repoRoot,taskText,strategyId=null,traceDir=null}) {
  if(typeof taskText!=="string"||!taskText.trim())throw new TypeError("--task is required");
  if(!repoRoot)throw new TypeError("--repo-root is required");
  const strategies=createContextStrategies(offlineContextEngine(),strategyId);
  const repository=await new LocalRepositoryAdapter(repoRoot).snapshot();
  const store=traceDir?new JsonlTelemetryStore(path.join(traceDir,"events.jsonl")):null;
  const execution_mode="offline-synthetic";
  const result=await new ContextShadowTournament({onTelemetry:store?e=>store.append({...e,execution_mode}):null})
    .run({task:{id:newId("task"),text:taskText},repository,strategies});
  return {version:result.version,execution_mode,shadow:true,task_id:result.task_id,tournament_run_id:result.tournament_run_id,
    repository_snapshot_id:repository.id,repository_id:repository.repositoryId,recording:result.recording,
    trace_file:store?.filePath??null,results:result.results.map(a=>a.summary)};
}
export function formatContextShadow(result) {
  return [`Context Shadow (${result.execution_mode}) — ${result.tournament_run_id}`,...result.results.map(a=>
    `${a.strategy_id}\n  ${a.outcome} / ${a.reason}\n  files: ${a.observable_file_count}; candidates: ${a.generated_candidate_count??"unknown"}; shortlist: ${a.shortlist_count??"unknown"}; selected: ${a.selected_count}\n  IDs: ${a.selected_candidate_ids.join(", ")||"—"}\n  mock calls: ${a.decision_calls?.attempted??"unknown"}; latency: ${a.latency_ms.toFixed(1)} ms`),
    `Telemetry: ${result.recording.status}${result.trace_file?` (${result.trace_file})`:""}`].join("\n\n");
}
