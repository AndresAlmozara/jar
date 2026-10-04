import { sha256 } from "../../core/src/hash.js";
import { exposureInput, validateExposureProposal } from "./contracts.js";

export function schemaSizeProxy(inventory, ids) {
  if (inventory.state !== "known" || ids === null) return null;
  const sizes = ids.map(id => inventory.entries.find(entry => entry.capability.id === id)?.capability.schemaChars);
  if (sizes.some(size => size == null)) return null;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return Number.isSafeInteger(total) ? total : null;
}

/** Proposal metadata only; not a claim about actual schemas seen by a model. */
export function capabilityTelemetry(rawInput, proposal) {
  const input = exposureInput(rawInput); validateExposureProposal(proposal, input);
  const known = input.inventory.state === "known";
  const before = schemaSizeProxy(input.inventory, known ? proposal.eligibleIds : null);
  const after = schemaSizeProxy(input.inventory, known ? proposal.proposedIds : null);
  return {event_type:"capability_exposure_proposal", component:"capability_exposure", task_id:input.task.id,
    inventory_id:input.inventory.id, inventory_state:input.inventory.state, inventory_count:known ? input.inventory.entries.length : null,
    strategy_id:proposal.strategy, strategy_version:proposal.strategy.match(/-(v\d+)$/)[1], invocation_id:proposal.invocation.invocation_id,
    session_id:proposal.invocation.session_id, proposal_id:proposal.id, policy_hash:proposal.policyHash, constraints_hash:proposal.constraintsHash,
    configuration_hash:sha256(proposal.configuration), eligible_count:known ? proposal.eligibleIds.length : null,
    semantic_candidate_count:proposal.semanticCandidateIds.length, proposed_exposed_count:known ? proposal.proposedIds.length : null,
    proposed_withheld_count:known ? proposal.withheldIds.length : null, explicit_include_count:input.constraints.includeIds.length,
    explicit_exclude_count:input.constraints.excludeIds.length, policy_excluded_ids:proposal.policyExcludedIds,
    schema_size_proxy:{unit:"UTF-16 characters", before, after, reduction:before !== null && after !== null ? before - after : null},
    hierarchical:proposal.hierarchical,
    outcome:proposal.outcome, reason:proposal.reason, shadow:true, actually_exposed:false, application:"not_applied"};
}
