import { newId } from "../../core/src/ids.js";
import { assertFreshOutput, freshOutput, currentOutputTask, outputInvocation, filterProposal, validateFilterProposal } from "./contracts.js";
import { segmentOutput, validateSegments } from "./segments.js";
import { outputHardKeeps } from "./policy.js";
import { OutputSafetyGate, outputTelemetry } from "./safety-gate.js";

const stages = {provider_failure:"provider", invalid_semantic_decision:"semantic", segmentation_limit:"segmentation",
  archive_failure:"archive", recovery_unavailable:"archive", filter_failure:"reconstruction", unsafe_output:"hard_rule", uncertain:"semantic"};
function cloneObservation(observation) {
  // Do not serialize opaque payloads, even for tournament isolation. Their
  // descriptors are immutable and never eligible for reduction/semantics.
  return freshOutput(Object.fromEntries(["toolInvocationId", "capabilityId", "taskId", "sessionId", "sequence", "source", "parts"].map(key => [key, observation[key]])));
}
function validateCalls(calls) {
  if (!calls || ![calls.attempted, calls.settled, calls.failed].every(n => Number.isSafeInteger(n) && n >= 0)
      || calls.attempted !== calls.settled || calls.failed > calls.settled) throw new TypeError("Unsettled output strategy calls");
}

/** Sequential observations only: no winner, runtime adapter, promotion or write
 * to original tool output. A collector independently recomputes gate decisions;
 * it never trusts a strategy-supplied effective result or telemetry object.
 */
export class OutputShadowTournament {
  constructor({onTelemetry = null} = {}) { this.onTelemetry = onTelemetry; }
  async run({observation, task, strategies}) {
    assertFreshOutput(observation);
    const captured = cloneObservation(observation), capturedTask = task ? currentOutputTask(task) : undefined;
    if (!Array.isArray(strategies) || !strategies.length || strategies.some(s => !s || typeof s.propose !== "function"
        || !/^output\/[a-z][a-z0-9-]*-v\d+$/.test(s.id)) || new Set(strategies.map(s => s.id)).size !== strategies.length) throw new TypeError("Unique output strategies required");
    const arms = strategies.map(s => ({id:s.id, propose:s.propose.bind(s), archive:s.archive}));
    const run = {version:"output.shadow.v1", tournament_run_id:newId("tournament"), observation_id:captured.id,
      task_id:captured.taskId ?? capturedTask?.id ?? captured.id, shadow:true, execution:"sequential", results:[]};
    for (const arm of arms) {
      const invocation = outputInvocation(arm.id, captured), start = performance.now();
      let result, normalizationFailure = false;
      try {
        result = await arm.propose({observation:cloneObservation(captured), ...(capturedTask ? {task:{...capturedTask}} : {}), invocationId:invocation.invocation_id});
        validateFilterProposal(result?.proposal, captured); validateSegments(captured, result.segments); validateCalls(result.decisionCalls);
        if (result.proposal.strategy !== arm.id || result.proposal.invocation.invocation_id !== invocation.invocation_id) throw new TypeError("Wrong output arm identity");
        const known = new Set(result.segments.map(s => s.id));
        if (result.semanticRefs !== undefined && (!Array.isArray(result.semanticRefs)
            || result.semanticRefs.some(ref => !known.has(ref.segment_id) || typeof ref.call_id !== "string"
              || (ref.request_id !== undefined && typeof ref.request_id !== "string")))) throw new TypeError("Invalid semantic references");
        if ((result.semanticRefs?.length ?? 0) !== result.decisionCalls.attempted
            || new Set((result.semanticRefs ?? []).map(ref => ref.call_id)).size !== result.decisionCalls.attempted) throw new TypeError("Invalid semantic call accounting");
        result = {proposal:structuredClone(result.proposal), segments:structuredClone(result.segments),
          decisionCalls:{attempted:result.decisionCalls.attempted, settled:result.decisionCalls.settled, failed:result.decisionCalls.failed},
          semanticRefs:structuredClone(result.semanticRefs ?? [])};
      } catch {
        normalizationFailure = true;
        const segments = segmentOutput(captured, {maxChars:Math.max(1, captured.chars ?? 1), maxSegments:captured.parts.length});
        result = {segments, proposal:filterProposal({observation:captured, invocation, outcome:"error", reason:"filter_failure", retainedSegmentIds:segments.map(s => s.id)}), decisionCalls:null, semanticRefs:[]};
      }
      const hardKeepIds = outputHardKeeps(captured, result.segments);
      const decision = await new OutputSafetyGate().evaluate({observation:captured, proposal:result.proposal, segments:result.segments, hardKeepIds, archive:arm.archive});
      const reduced = decision.status === "would_apply" && result.proposal.outcome === "reduced";
      const summary = {...outputTelemetry({observation:captured, proposal:result.proposal, segments:result.segments, decision}),
        tournament_run_id:run.tournament_run_id, retained_segment_ids:reduced ? [...result.proposal.retainedSegmentIds] : result.segments.map(s => s.id),
        retained_segment_count:reduced ? result.proposal.retainedSegmentIds.length : result.segments.length,
        semantic_candidate_count:normalizationFailure ? null : result.semanticRefs.length,
        semantic_call_refs:result.semanticRefs.map(ref => ({segment_id:ref.segment_id, call_id:ref.call_id, request_id:ref.request_id ?? null})),
        decision_calls:result.decisionCalls, latency_ms:performance.now() - start,
        failure_stage:normalizationFailure ? "normalization" : decision.status === "would_reject" ? "gate"
          : ["recovery_mismatch", "archive_failure", "recovery_unavailable"].includes(decision.reason) ? "archive" : stages[result.proposal.reason] ?? null};
      run.results.push({...result, decision, summary});
    }
    run.recording = {status:this.onTelemetry ? "complete" : "disabled", errors:[]};
    if (this.onTelemetry) for (const result of run.results) {
      try { await this.onTelemetry(result.summary); }
      catch { run.recording.status = "incomplete"; run.recording.errors.push({invocation_id:result.summary.invocation_id, code:"recording_failed"}); }
    }
    return run;
  }
}
