import { newId } from "../../core/src/ids.js";
import { exposureInput, capabilityInvocation, exposureProposal, validateExposureProposal, freeze } from "./contracts.js";
import { capabilityEligibility } from "./eligibility.js";
import { capabilityTelemetry } from "./telemetry.js";
import { CapabilityPolicyGate } from "./policy-gate.js";

function normalize(result, input, invocation) {
  const p = validateExposureProposal(result?.proposal, input), counts = result.decisionCalls, refs = result.semanticRefs;
  const eligible = capabilityEligibility(input).eligibleIds ?? [];
  if (p.strategy !== invocation.caller || p.invocation.invocation_id !== invocation.invocation_id
      || p.invocation.session_id !== invocation.session_id
      || !counts || ![counts.attempted, counts.settled, counts.failed].every(n => Number.isSafeInteger(n) && n >= 0)
      || counts.attempted !== counts.settled || counts.failed > counts.settled
      || !Array.isArray(refs) || refs.length < counts.attempted
      || new Set(refs.map(ref=>ref?.call_id)).size !== counts.attempted
      || refs.some(r => !r || typeof r.call_id !== "string" || !r.call_id
        || (r.candidate_id !== undefined && !eligible.includes(r.candidate_id))
        || (r.subject_type !== undefined && !["family", "atom"].includes(r.subject_type))
        || (r.subject_type !== undefined && (typeof r.subject_id !== "string" || !r.subject_id))
        || (r.candidate_id === undefined) === (r.subject_type === undefined)
        || (r.request_id != null && typeof r.request_id !== "string"))
      || new Set(refs.map(r => r.call_id)).size !== refs.length
      || new Set(refs.map(r => r.candidate_id ?? `${r.subject_type}:${r.subject_id}`)).size !== refs.length
      || p.semanticCandidateIds.length !== refs.filter(r => r.candidate_id !== undefined).length
      || p.semanticCandidateIds.some(id => !refs.some(r => r.candidate_id === id))) throw new TypeError("Invalid capability arm accounting");
  return {proposal:structuredClone(p), decisionCalls:{attempted:counts.attempted, settled:counts.settled, failed:counts.failed},
    semanticRefs:refs.map(r => r.candidate_id !== undefined
      ? {candidate_id:r.candidate_id, call_id:r.call_id, request_id:r.request_id ?? null}
      : {subject_type:r.subject_type, subject_id:r.subject_id, call_id:r.call_id, request_id:r.request_id ?? null})};
}

/** Captured input, sequential isolated arms, independent authority, no winner. */
export class CapabilityShadowTournament {
  constructor({onTelemetry = null} = {}) { this.onTelemetry = onTelemetry; }
  async run({strategies, sessionId = null, ...rawInput}) {
    const input = exposureInput(structuredClone(rawInput));
    if (!Array.isArray(strategies) || !strategies.length || strategies.some(s => typeof s?.propose !== "function")
        || new Set(strategies.map(s => s.id)).size !== strategies.length) throw new TypeError("Unique capability arms required");
    const arms = strategies.map(s => ({propose:s.propose.bind(s), invocation:capabilityInvocation(s.id, undefined, sessionId)}));
    const run = {version:"capability.shadow.v1", tournament_run_id:newId("tournament"), task_id:input.task.id,
      inventory_id:input.inventory.id, execution:"sequential", shadow:true, actually_exposed:false, application:"not_applied", results:[]};
    for (const arm of arms) {
      const start = performance.now(); let result, failureStage = null, returned = false;
      try {
        result = await arm.propose({...structuredClone(input), invocationId:arm.invocation.invocation_id,
          sessionId, tournamentRunId:run.tournament_run_id});
        returned = true; result = normalize(result, input, arm.invocation);
      } catch {
        failureStage = returned ? "proposal_validation" : "strategy";
        const e = capabilityEligibility(input), unknown = e.state === "unknown";
        result = {proposal:exposureProposal({input, invocation:arm.invocation, eligibleIds:e.eligibleIds ?? [],
          proposedIds:e.eligibleIds ?? [], policyExcludedIds:e.exclusions.map(x => x.id),
          outcome:unknown ? "no_decision" : "error", reason:unknown ? "inventory_unknown" : "strategy_failure"}),
        decisionCalls:null, semanticRefs:[]};
      }
      const effective = new CapabilityPolicyGate().evaluate({input, proposal:result.proposal});
      const summary = {...capabilityTelemetry(input, result.proposal), event_type:"capability_shadow_result",
        tournament_run_id:run.tournament_run_id, eligible_count:effective.eligibility.eligibleIds?.length ?? null,
        semantic_candidate_count:result.decisionCalls === null ? null : result.proposal.semanticCandidateIds.length,
        policy_excluded_ids:effective.rejections.map(r => r.id),
        proposed_ids:input.inventory.state === "unknown" ? null : result.proposal.proposedIds,
        semantic_selected_ids:effective.semanticSelectedIds, effective_ids:effective.effectiveIds,
        effective_exposed_count:effective.effectiveIds?.length ?? null, withheld_ids:effective.withheldIds,
        overrides:effective.overrides, policy_rejections:effective.rejections, unresolved_required_ids:effective.unresolvedRequiredIds,
        schema_size_proxy:effective.schemaSizeProxy, decision_calls:result.decisionCalls, semantic_call_refs:result.semanticRefs,
        latency_ms:performance.now() - start, fallback:effective.fallback,
        failure_stage:failureStage ?? ({provider_failure:"provider", invalid_semantic_decision:"semantic_validation",
          limits_exceeded:"candidate_generation", inventory_unknown:"inventory"}[result.proposal.reason] ?? null)};
      run.results.push({...result, effective, summary});
    }
    run.recording = {status:this.onTelemetry ? "complete" : "disabled", errors:[]};
    if (this.onTelemetry) for (const {summary} of run.results) {
      try { await this.onTelemetry(freeze(structuredClone(summary))); }
      catch { run.recording.status = "incomplete"; run.recording.errors.push({invocation_id:summary.invocation_id, code:"recording_failed"}); }
    }
    return freeze(run);
  }
}
