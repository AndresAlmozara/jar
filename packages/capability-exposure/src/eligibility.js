import { exposureInput, TOOL_LIKE_KINDS, freeze } from "./contracts.js";

/** Hard facts only. No language/keyword scoring and no semantic provider. */
export function capabilityEligibility(rawInput) {
  const input = exposureInput(rawInput), {inventory, constraints, policy} = input;
  if (inventory.state === "unknown") return freeze({state:"unknown", eligibleIds:null, exclusions:[], unresolvedIds:null,
    requiredIds:constraints.includeIds, unresolvedRequiredIds:constraints.includeIds, conflicts:constraints.includeIds.filter(id => constraints.excludeIds.includes(id))});
  const eligibleIds = [], exclusions = [], unresolvedIds = [];
  for (const entry of inventory.entries) {
    const c = entry.capability, reasons = [];
    if (!TOOL_LIKE_KINDS.includes(c.kind)) reasons.push("outside_tool_scope");
    if (constraints.excludeIds.includes(c.id)) reasons.push("explicit_exclusion");
    for (const [field, denied, unknown] of [["available", "unavailable", "availability_unknown"], ["supported", "runtime_unsupported", "support_unknown"], ["enabled", "disabled", "enabled_unknown"]]) {
      if (entry[field] === false) reasons.push(denied);
      else if (entry[field] === null) reasons.push(unknown);
    }
    if (entry.permission === "denied") reasons.push("permission_denied");
    if (entry.permission === "unknown") reasons.push("permission_unknown");
    if (entry.permission === "prompt" && !policy.allowPromptExposure) reasons.push("permission_pending");
    if (c.risk === "unknown") reasons.push("risk_unknown");
    else if (!policy.allowedRiskLevels.includes(c.risk)) reasons.push("risk_forbidden");
    if (c.requirements.length && entry.requirementsSatisfied !== true) reasons.push(entry.requirementsSatisfied === false ? "requirements_unsatisfied" : "requirements_unknown");
    if (!reasons.length) eligibleIds.push(c.id);
    else {
      exclusions.push({id:c.id, reasons});
      if (reasons.some(reason => reason.endsWith("_unknown") || reason === "permission_pending")) unresolvedIds.push(c.id);
    }
  }
  return freeze({state:"known", eligibleIds, exclusions, unresolvedIds, requiredIds:constraints.includeIds,
    unresolvedRequiredIds:constraints.includeIds.filter(id => !eligibleIds.includes(id)),
    conflicts:constraints.includeIds.filter(id => constraints.excludeIds.includes(id))});
}
