import { exposureInput, validateExposureProposal, freeze } from "./contracts.js";
import { capabilityEligibility } from "./eligibility.js";
import { schemaSizeProxy } from "./telemetry.js";

/** Recomputes authority from the captured input, never from claimed eligibility.
 * Exposure permission is not permission to execute. No runtime interface exists.
 */
export class CapabilityPolicyGate {
  evaluate({input:rawInput, proposal}) {
    const input = exposureInput(rawInput), eligibility = capabilityEligibility(input);
    let valid = true;
    try { validateExposureProposal(proposal, input); } catch { valid = false; }
    const unknown = eligibility.state === "unknown";
    const eligible = eligibility.eligibleIds ?? [];
    const fallback = !valid || (valid && ["error", "no_decision"].includes(proposal.outcome));
    const proposed = valid ? proposal.proposedIds : [];
    const effectiveIds = unknown ? null : [...new Set([
      ...(fallback ? eligible : proposed.filter(id => eligible.includes(id))),
      ...input.constraints.includeIds.filter(id => eligible.includes(id)),
    ])].sort();
    const overrides = unknown ? [] : input.constraints.includeIds
      .filter(id => eligible.includes(id) && !proposed.includes(id))
      .map(id => ({id, reason:"explicit_include"}));
    const before = schemaSizeProxy(input.inventory, eligibility.eligibleIds);
    const after = schemaSizeProxy(input.inventory, effectiveIds);
    return freeze({version:"capability.effective.v1", taskId:input.task.id, inventoryId:input.inventory.id,
      proposalId:valid ? proposal.id : null, invocation:valid ? proposal.invocation : null,
      outcome:unknown ? "no_decision" : "would_expose", reason:unknown ? "inventory_unknown"
        : !valid ? "proposal_validation_failure" : fallback ? proposal.reason : "policy_checked",
      eligibility, semanticSelectedIds:valid ? proposal.semanticSelectedIds : null,
      effectiveIds, withheldIds:unknown ? null : input.inventory.entries.map(e => e.capability.id).filter(id => !effectiveIds.includes(id)),
      overrides, rejections:eligibility.exclusions,
      unresolvedRequiredIds:eligibility.unresolvedRequiredIds,
      fallback:unknown || !fallback ? null : {reason:valid ? proposal.reason : "proposal_validation_failure", exposureCount:effectiveIds.length},
      schemaSizeProxy:{unit:"UTF-16 characters", before, after,
        reduction:before === null || after === null ? null : before - after,
        reductionRatio:before === null || after === null || before === 0 ? null : (before - after) / before},
      shadow:true, actuallyExposed:false, application:"not_applied"});
  }
}
