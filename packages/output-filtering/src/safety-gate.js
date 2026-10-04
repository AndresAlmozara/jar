import { sha256, stableStringify } from "../../core/src/hash.js";
import { assertFreshOutput, validateFilterProposal, outputRecoveryRef, lineCount } from "./contracts.js";
import { validateSegments, reconstructOutput } from "./segments.js";

/** Shadow only. hardKeepIds belongs to deterministic policy/the caller, NOT the
 * proposal. Recovery is checked by reading the archive, never a claimed boolean.
 * OutputArchive seam: recover(reference) -> exact FreshToolOutputObservation.
 * Future effect-time integration must recheck recovery; this is not a lease.
 */
export class OutputSafetyGate {
  async evaluate({observation, proposal, segments = [], hardKeepIds = [], archive = null}) {
    const result = (status, reason, parts = observation?.parts, recoveryAvailable = false) => ({
      shadow:true, effect:false, status, reason, observationId:observation?.id ?? null,
      parts, recoveryAvailable,
    });
    try { assertFreshOutput(observation); } catch { return result("would_fall_open", "invalid_observation"); }
    try { validateFilterProposal(proposal, observation); } catch { return result("would_reject", "invalid_proposal"); }
    if (!observation.supported) return result("would_fall_open", "unsupported_content");
    if (["error", "unsupported"].includes(proposal.outcome)) return result("would_fall_open", proposal.reason);
    try {
      // Capture before the archive await so a caller cannot change the checked
      // original, retained set or policy while recovery is in flight.
      observation = structuredClone(observation);
      proposal = structuredClone(proposal);
      segments = structuredClone(segments);
      hardKeepIds = structuredClone(hardKeepIds);
      validateSegments(observation, segments);
      const known = new Set(segments.map(s => s.id)), retained = new Set(proposal.retainedSegmentIds);
      if (proposal.retainedSegmentIds.some(id => !known.has(id)) || !Array.isArray(hardKeepIds)
          || hardKeepIds.some(id => !known.has(id))) return result("would_reject", "invalid_segment_identity");
      if (hardKeepIds.some(id => !retained.has(id))) return result("would_reject", "hard_keep_violation");
      if (proposal.outcome !== "reduced") {
        if (retained.size !== segments.length) return result("would_reject", "passthrough_mismatch");
        return result("would_apply", proposal.reason);
      }
      if (retained.size === segments.length) return result("would_reject", "not_a_reduction");
      if (["failed", "truncated", "sensitive", "completeRequested", "recoveryRead"].some(key => observation.source[key])
          || ["reference", "structured", "search", "listing", "unknown"].includes(observation.source.outputClass)
          || segments.some(s => s.start === s.end && !retained.has(s.id))) return result("would_reject", "unsafe_reduction");
      const parts = reconstructOutput(observation, segments, proposal.retainedSegmentIds);
      const chars = parts.reduce((sum, part) => sum + part.text.length, 0);
      if (chars === 0 || chars >= observation.chars) return result("would_reject", "invalid_reduction");
      if (proposal.recoveryRef !== outputRecoveryRef(observation) || typeof archive?.recover !== "function") return result("would_fall_open", "recovery_unavailable");
      try {
        const recovered = await archive.recover(proposal.recoveryRef);
        assertFreshOutput(recovered);
        if (recovered.id !== observation.id || stableStringify(recovered.parts) !== stableStringify(observation.parts)) return result("would_fall_open", "recovery_mismatch");
      } catch { return result("would_fall_open", "archive_failure"); }
      return result("would_apply", "reduced", parts, true);
    } catch { return result("would_reject", "invalid_segmentation"); }
  }
}

/** Deliberate projection: no source metadata, channels, arbitrary configuration,
 * text, errors or provider-owned probabilities/model/usage are logged. */
export function outputTelemetry({observation, proposal, decision, segments = []}) {
  assertFreshOutput(observation);
  validateFilterProposal(proposal, observation);
  const retainedChars = observation.supported ? decision.parts.reduce((n, p) => n + p.text.length, 0) : null;
  const retainedLines = observation.supported ? decision.parts.reduce((n, p) => n + lineCount(p.text), 0) : null;
  return {event_type:"output_filter_result", task_id:observation.taskId ?? observation.id,
    component:"output_filtering", shadow:true, observation_id:observation.id,
    tool_invocation_id:observation.toolInvocationId, session_id:observation.sessionId,
    proposal_id:proposal.id, strategy_id:proposal.strategy, strategy_version:proposal.strategy.match(/-(v\d+)$/)[1], contract_version:proposal.version,
    invocation_id:proposal.invocation.invocation_id, configuration_hash:sha256(proposal.configuration),
    outcome:proposal.outcome, reason:proposal.reason, gate_result:decision.status, gate_reason:decision.reason,
    recovery_ref:proposal.recoveryRef, recovery_available:decision.recoveryAvailable,
    original_chars:observation.chars, original_lines:observation.lines,
    retained_chars:retainedChars, retained_lines:retainedLines,
    removed_chars:observation.supported ? observation.chars - retainedChars : null,
    removed_lines:observation.supported ? observation.lines - retainedLines : null,
    reduction_ratio:observation.chars ? 1 - retainedChars / observation.chars : 0,
    segment_count:segments.length, proposed_retained_count:proposal.retainedSegmentIds.length};
}
