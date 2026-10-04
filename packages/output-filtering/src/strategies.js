import { assertFreshOutput, freshOutput, currentOutputTask, outputInvocation, filterProposal, outputRecoveryRef } from "./contracts.js";
import { segmentOutput } from "./segments.js";
import { OutputSafetyGate, outputTelemetry } from "./safety-gate.js";
import { OUTPUT_LIMITS, outputBypass, outputHardKeeps, progressRetained } from "./policy.js";

function assertInput(input) {
  if (!input || Object.keys(input).some(key => !["observation", "task", "invocationId"].includes(key))) throw new TypeError("Fresh output input only");
  assertFreshOutput(input.observation);
  if (input.task !== undefined) {
    currentOutputTask(input.task);
    if (input.observation.taskId !== null && input.observation.taskId !== input.task.id) throw new TypeError("Task/output identity mismatch");
  }
}

function capture(observation) {
  return freshOutput(Object.fromEntries(["toolInvocationId", "capabilityId", "taskId", "sessionId", "sequence", "source", "parts"].map(key => [key, observation[key]])));
}

export class PassthroughOutputStrategy {
  id = "output/passthrough-v1";
  version = "v1";
  async propose(input) {
    assertInput(input);
    const observation = capture(input.observation), invocation = outputInvocation(this.id, observation, input.invocationId);
    // One range per part suffices for control, without semantic segmentation.
    const segments = segmentOutput(observation, {maxChars:Math.max(1, observation.chars ?? 1), maxSegments:observation.parts.length});
    const proposal = filterProposal({observation, invocation, outcome:observation.supported ? "passthrough" : "unsupported",
      reason:observation.supported ? "control" : "unsupported_content", retainedSegmentIds:segments.map(s => s.id)});
    const decision = await new OutputSafetyGate().evaluate({observation, proposal, segments});
    return {proposal, segments, hardKeepIds:segments.map(s => s.id), decision,
      telemetry:outputTelemetry({observation, proposal, segments, decision}), decisionCalls:{attempted:0, settled:0, failed:0}};
  }
}

export class DeterministicOutputStrategy {
  id = "output/deterministic-v1";
  version = "v1";
  method = "deterministic";
  constructor({archive = null, limits = {}, select = progressRetained} = {}) {
    this.archive = archive; this.select = select; this.limits = Object.freeze({...OUTPUT_LIMITS, ...limits});
    if (Object.keys(this.limits).some(key => !(key in OUTPUT_LIMITS))
        || !Object.values(this.limits).every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError("Invalid output limits");
  }
  async propose(input) {
    assertInput(input);
    const observation = capture(input.observation), invocation = outputInvocation(this.id, observation, input.invocationId);
    let segments = [], hardKeepIds = [], recoveryRef = null;
    const capturedTask = input.task ? currentOutputTask(input.task) : null;
    const decisionCalls = {attempted:0, settled:0, failed:0}, semanticRefs = [];
    const finish = async (outcome, reason, retainedSegmentIds = segments.map(s => s.id)) => {
      const proposal = filterProposal({observation, invocation, outcome, reason,
        method:outcome === "reduced" ? this.method : "none", retainedSegmentIds, recoveryRef,
        configuration:{...this.limits, ...(this.semanticLimits ?? {})}});
      const decision = await new OutputSafetyGate().evaluate({observation, proposal, segments, hardKeepIds, archive:this.archive});
      return {proposal, segments, hardKeepIds, decision,
        telemetry:outputTelemetry({observation, proposal, segments, decision}), decisionCalls:{...decisionCalls}, semanticRefs,
        semanticCandidateCount:semanticRefs.length};
    };
    try {
      // Complete single-part ranges also let bypasses retain observable counts.
      segments = segmentOutput(observation, {maxChars:Math.max(1, observation.chars ?? 1), maxSegments:observation.parts.length});
      const bypass = outputBypass(observation, this.limits);
      if (bypass) return finish(observation.supported ? "passthrough" : "unsupported", bypass);
      if (typeof this.archive?.store !== "function") return finish("error", "recovery_unavailable");
      try {
        const ref = await this.archive.store(observation);
        if (ref !== outputRecoveryRef(observation)) throw new Error("Invalid recovery reference");
        recoveryRef = ref;
      } catch { return finish("error", "archive_failure"); }
      try { segments = segmentOutput(observation, {maxChars:this.limits.maxSegmentChars, maxSegments:this.limits.maxSegments}); }
      catch { return finish("error", "segmentation_limit"); }
      hardKeepIds = Object.freeze(outputHardKeeps(observation, segments));
      if (this.method === "semantic") {
        // Establish exact recovery before any external semantic transmission.
        try {
          const recovered = await this.archive.recover(recoveryRef);
          assertFreshOutput(recovered);
          if (recovered.id !== observation.id || recovered.contentHash !== observation.contentHash) throw new Error("Recovery mismatch");
        } catch { return finish("error", "archive_failure"); }
      }
      const retained = await this.select(observation, segments, hardKeepIds, {
        task:capturedTask, invocation, decisionCalls, semanticRefs,
      });
      return await finish(retained.length < segments.length ? "reduced" : "passthrough", retained.length < segments.length ? "reduced" : "no_filtering_required", retained);
    } catch (error) {
      const reason = ["provider_failure", "invalid_semantic_decision", "uncertain"].includes(error?.outputReason) ? error.outputReason : "filter_failure";
      return finish("error", reason);
    }
  }
}
