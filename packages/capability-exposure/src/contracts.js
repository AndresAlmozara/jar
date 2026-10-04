import { sha256, stableStringify } from "../../core/src/hash.js";
import { assertTaskSnapshot } from "../../core/src/contracts.js";
import { newId } from "../../core/src/ids.js";

export const CAPABILITY_VERSION = "capability.contracts.v1";
export const TOOL_LIKE_KINDS = Object.freeze(["tool", "mcp_tool", "plugin_tool", "cli"]);
export const RISKS = Object.freeze(["low", "medium", "high", "critical", "unknown"]);
export function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError("Invalid capability contract fields");
}
function string(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Invalid ${label}`);
  return value;
}
export function strings(values, label = "IDs") {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim())
      || new Set(values).size !== values.length) throw new TypeError(`Invalid ${label}`);
  return [...values].sort();
}
function optionalString(value, label) { return value == null ? null : string(value, label); }
function operationalContract(value) {
  if (value == null) return null;
  fields(value, ["operation", "effects", "produces", "provides", "requires", "scope", "prerequisiteNativeIds",
    "compatibleWithNativeIds", "incompatibleWithNativeIds", "completeness", "provenance"]);
  return freeze({operation:string(value.operation, "operation"), effects:strings(value.effects ?? [], "effects"),
    produces:strings(value.produces ?? [], "produces"), provides:strings(value.provides ?? [], "provides"),
    requires:strings(value.requires ?? [], "requires"), scope:optionalString(value.scope, "scope"),
    prerequisiteNativeIds:strings(value.prerequisiteNativeIds ?? [], "prerequisite native IDs"),
    compatibleWithNativeIds:strings(value.compatibleWithNativeIds ?? [], "compatible native IDs"),
    incompatibleWithNativeIds:strings(value.incompatibleWithNativeIds ?? [], "incompatible native IDs"),
    completeness:enumValue(value.completeness ?? "unknown", ["complete", "unknown"]),
    provenance:string(value.provenance, "operational provenance")});
}
function enumValue(value, allowed) {
  if (!allowed.includes(value)) throw new TypeError("Invalid capability fact");
  return value;
}
function triState(value) { return enumValue(value ?? null, [true, false, null]); }

/** A descriptor identifies an operation, not a display name or executable.
 * Version/description changes alter snapshot identity but not operation identity.
 * Namespaced native IDs must be stable identifiers supplied by a trusted source.
 */
export function capabilityDescriptor(input) {
  fields(input, ["id", "kind", "name", "description", "source", "version", "tags", "requirements", "requiredPermissions", "risk", "schemaChars", "coverageAtoms", "mandatory", "operational"]);
  fields(input.source, ["namespace", "nativeId", "provider"]);
  const source = {namespace:string(input.source.namespace, "source namespace"), nativeId:string(input.source.nativeId, "native ID"),
    provider:input.source.provider == null ? null : string(input.source.provider, "provider")};
  const kind = string(input.kind, "kind");
  if (!/^[a-z][a-z0-9_]*$/.test(kind)) throw new TypeError("Invalid capability kind");
  const id = `capability_${sha256({namespace:source.namespace, nativeId:source.nativeId, kind})}`;
  if (input.id !== undefined && input.id !== id) throw new TypeError("Capability identity mismatch");
  const schemaChars = input.schemaChars ?? null;
  if (schemaChars !== null && (!Number.isSafeInteger(schemaChars) || schemaChars < 0)) throw new TypeError("Invalid schema-size proxy");
  if (input.mandatory !== undefined && typeof input.mandatory !== "boolean") throw new TypeError("Invalid mandatory capability flag");
  const descriptor={id, kind, name:string(input.name, "name"), description:string(input.description, "description"), source,
    version:input.version == null ? null : string(input.version, "version"), tags:strings(input.tags ?? [], "tags"),
    requirements:strings(input.requirements ?? [], "requirements"), requiredPermissions:strings(input.requiredPermissions ?? [], "permissions"),
    risk:enumValue(input.risk ?? "unknown", RISKS), schemaChars, coverageAtoms:strings(input.coverageAtoms ?? [], "coverage atoms"),
    mandatory:input.mandatory ?? false};
  if(input.operational!==undefined)descriptor.operational=operationalContract(input.operational);
  return freeze(descriptor);
}

/** known means complete for the supplied inventory scope, not globally complete
 * across all plugins/hosts. unknown must have entries:null, never []. Catalog-only
 * suggestions are intentionally not mixed with observed runtime availability.
 */
export function capabilityInventory(input) {
  fields(input, ["id", "version", "runtime", "source", "revision", "observedAt", "state", "entries"]);
  const state = enumValue(input.state ?? "unknown", ["unknown", "known"]);
  fields(input.runtime, ["id", "family"]);
  const runtime = {id:string(input.runtime.id, "runtime ID"), family:string(input.runtime.family, "runtime family")};
  const source = string(input.source, "inventory source");
  let entries = null;
  if (state === "unknown") {
    if (input.entries != null) throw new TypeError("Unknown inventory must not claim a known set");
  } else {
    if (!Array.isArray(input.entries)) throw new TypeError("Known inventory requires explicit entries");
    entries = input.entries.map(entry => {
      fields(entry, ["capability", "available", "supported", "enabled", "permission", "requirementsSatisfied"]);
      return {capability:capabilityDescriptor(entry.capability), available:triState(entry.available), supported:triState(entry.supported), enabled:triState(entry.enabled),
        permission:enumValue(entry.permission ?? "unknown", ["allowed", "denied", "prompt", "unknown"]), requirementsSatisfied:triState(entry.requirementsSatisfied)};
    }).sort((a, b) => a.capability.id.localeCompare(b.capability.id));
    if (new Set(entries.map(e => e.capability.id)).size !== entries.length) throw new TypeError("Duplicate capability identity");
  }
  const body = {version:CAPABILITY_VERSION, runtime, source, revision:input.revision == null ? null : string(input.revision, "revision"),
    observedAt:input.observedAt == null ? null : string(input.observedAt, "observation time"), state, entries};
  if (input.version !== undefined && input.version !== body.version) throw new TypeError("Inventory version mismatch");
  const id = `inventory_${sha256(body)}`;
  if (input.id !== undefined && input.id !== id) throw new TypeError("Inventory identity mismatch");
  return freeze({id, ...body});
}

export function exposureConstraints(input = {}) {
  fields(input, ["includeIds", "excludeIds", "requiredObligations", "operationalScope"]);
  const constraints={includeIds:strings(input.includeIds ?? []), excludeIds:strings(input.excludeIds ?? [])};
  if(input.requiredObligations!==undefined)constraints.requiredObligations=strings(input.requiredObligations, "required obligations");
  if(input.operationalScope!==undefined)constraints.operationalScope=optionalString(input.operationalScope, "operational scope");
  return freeze(constraints);
}

/** These are exposure restrictions, NOT execution permissions. Prompt-capable
 * tools still require runtime confirmation; allowing their schema never consents.
 */
export function exposurePolicy(input = {}) {
  fields(input, ["allowedRiskLevels", "allowPromptExposure"]);
  const allowedRiskLevels = strings(input.allowedRiskLevels ?? ["low", "medium"], "allowed risks");
  if (allowedRiskLevels.some(risk => !RISKS.includes(risk) || risk === "unknown")
      || (input.allowPromptExposure !== undefined && typeof input.allowPromptExposure !== "boolean")) throw new TypeError("Invalid exposure policy");
  return freeze({allowedRiskLevels, allowPromptExposure:input.allowPromptExposure ?? false});
}

export function exposureInput({task, inventory, constraints = {}, policy = {}}) {
  assertTaskSnapshot(task);
  // Preserve TaskSnapshot ownership; irrelevant history/skill fields are not
  // copied into the capability decision or exposed to a semantic provider.
  return freeze({task:{id:task.id, text:task.text}, inventory:capabilityInventory(inventory),
    constraints:exposureConstraints(constraints), policy:exposurePolicy(policy)});
}

export function capabilityInvocation(strategy, invocationId = newId("invocation"), sessionId = null) {
  if (!/^capability\/[a-z][a-z0-9-]*-v\d+$/.test(strategy)) throw new TypeError("Invalid capability strategy");
  return freeze({invocation_id:string(invocationId, "invocation ID"), caller:strategy, component:"capability_exposure",
    session_id:sessionId == null ? null : string(sessionId, "session ID")});
}

function hierarchicalEvidence(value, eligible, proposed) {
  if (value == null) return null;
  fields(value, ["taxonomyFamilies", "selectedFamilies", "rejectedFamilies", "requiredCoverageAtoms", "mandatoryCapabilityIds",
    "explicitCapabilityIds", "selectedCapabilityIds", "withheldCapabilityIds", "capabilityCoverage", "capabilityExposureCost",
    "totalEligibleExposureCost", "selectedExposureCost", "exposureCostReductionRatio", "coverageAchieved", "uncoveredAtoms",
    "unknownCapabilityIds", "unknownCapabilityCount", "unknownCapabilityFraction", "familyDecisionCalls", "refinementDecisionCalls",
    "jevDecisionCalls", "semanticFallback", "fallbackReason", "costUnit"]);
  const idSubset = (values, label) => {
    const ids = strings(values, label);
    if (ids.some(id => !eligible.includes(id))) throw new TypeError(`Invalid ${label}`);
    return ids;
  };
  const taxonomyFamilies = strings(value.taxonomyFamilies, "taxonomy families");
  const selectedFamilies = strings(value.selectedFamilies, "selected families");
  const rejectedFamilies = strings(value.rejectedFamilies, "rejected families");
  if ([...selectedFamilies, ...rejectedFamilies].some(f => !taxonomyFamilies.includes(f))
      || selectedFamilies.some(f => rejectedFamilies.includes(f))
      || stableStringify([...selectedFamilies, ...rejectedFamilies].sort()) !== stableStringify(taxonomyFamilies)) throw new TypeError("Invalid taxonomy family evidence");
  const selectedCapabilityIds = idSubset(value.selectedCapabilityIds, "selected capability IDs");
  if (stableStringify(selectedCapabilityIds) !== stableStringify(proposed)) throw new TypeError("Hierarchical selection mismatch");
  const withheldCapabilityIds = idSubset(value.withheldCapabilityIds, "withheld capability IDs");
  if (stableStringify(withheldCapabilityIds) !== stableStringify(eligible.filter(id => !proposed.includes(id)))) throw new TypeError("Hierarchical withholding mismatch");
  const capabilityCoverage = {}, capabilityExposureCost = {};
  fields(value.capabilityCoverage, eligible);
  fields(value.capabilityExposureCost, eligible);
  for (const id of Object.keys(value.capabilityCoverage).sort()) capabilityCoverage[id] = strings(value.capabilityCoverage[id], "capability coverage");
  for (const id of Object.keys(value.capabilityExposureCost).sort()) {
    const cost = value.capabilityExposureCost[id];
    if (!Number.isSafeInteger(cost) || cost <= 0) throw new TypeError("Invalid capability exposure cost");
    capabilityExposureCost[id] = cost;
  }
  if (stableStringify(Object.keys(capabilityCoverage).sort()) !== stableStringify(eligible)
      || stableStringify(Object.keys(capabilityExposureCost).sort()) !== stableStringify(eligible)) throw new TypeError("Incomplete hierarchical capability evidence");
  const count = (number, label) => { if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`Invalid ${label}`); return number; };
  const ratio = (number, label) => { if (number !== null && (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 1)) throw new TypeError(`Invalid ${label}`); return number; };
  if (typeof value.coverageAchieved !== "boolean" || typeof value.semanticFallback !== "boolean") throw new TypeError("Invalid hierarchical evidence flags");
  if (value.fallbackReason !== null && (typeof value.fallbackReason !== "string" || !value.fallbackReason)) throw new TypeError("Invalid fallback reason");
  const requiredCoverageAtoms = strings(value.requiredCoverageAtoms, "required coverage atoms");
  const mandatoryCapabilityIds = idSubset(value.mandatoryCapabilityIds, "mandatory capability IDs");
  const explicitCapabilityIds = idSubset(value.explicitCapabilityIds, "explicit capability IDs");
  const unknownCapabilityIds = idSubset(value.unknownCapabilityIds, "unknown capability IDs");
  const totalEligibleExposureCost = count(value.totalEligibleExposureCost, "total exposure cost");
  const selectedExposureCost = count(value.selectedExposureCost, "selected exposure cost");
  const exposureCostReductionRatio = ratio(value.exposureCostReductionRatio, "exposure cost reduction ratio");
  const unknownCapabilityCount = count(value.unknownCapabilityCount, "unknown capability count");
  const unknownCapabilityFraction = ratio(value.unknownCapabilityFraction, "unknown capability fraction");
  const familyDecisionCalls = count(value.familyDecisionCalls, "family decision calls");
  const refinementDecisionCalls = count(value.refinementDecisionCalls, "refinement decision calls");
  const jevDecisionCalls = count(value.jevDecisionCalls, "JEV decision calls");
  const uncoveredAtoms = strings(value.uncoveredAtoms, "uncovered atoms");
  const expectedTotal = eligible.reduce((sum, id) => sum + capabilityExposureCost[id], 0);
  const expectedSelected = selectedCapabilityIds.reduce((sum, id) => sum + capabilityExposureCost[id], 0);
  const expectedRatio = expectedTotal ? (expectedTotal - expectedSelected) / expectedTotal : null;
  const covered = new Set(selectedCapabilityIds.flatMap(id => capabilityCoverage[id]));
  if ([...mandatoryCapabilityIds, ...explicitCapabilityIds].some(id => !selectedCapabilityIds.includes(id))
      || stableStringify(unknownCapabilityIds) !== stableStringify(eligible.filter(id => capabilityCoverage[id].length === 0))
      || unknownCapabilityCount !== unknownCapabilityIds.length
      || unknownCapabilityFraction !== (eligible.length ? unknownCapabilityIds.length / eligible.length : null)
      || totalEligibleExposureCost !== expectedTotal || selectedExposureCost !== expectedSelected || exposureCostReductionRatio !== expectedRatio
      || jevDecisionCalls !== familyDecisionCalls + refinementDecisionCalls
      || value.coverageAchieved !== (uncoveredAtoms.length === 0)
      || uncoveredAtoms.some(atom => covered.has(atom))
      || (value.coverageAchieved && requiredCoverageAtoms.some(atom => !covered.has(atom)))) throw new TypeError("Inconsistent hierarchical evidence");
  return freeze({taxonomyFamilies, selectedFamilies, rejectedFamilies, requiredCoverageAtoms,
    mandatoryCapabilityIds, explicitCapabilityIds, selectedCapabilityIds, withheldCapabilityIds,
    capabilityCoverage, capabilityExposureCost,
    totalEligibleExposureCost, selectedExposureCost, exposureCostReductionRatio,
    coverageAchieved:value.coverageAchieved, uncoveredAtoms, unknownCapabilityIds,
    unknownCapabilityCount, unknownCapabilityFraction, familyDecisionCalls, refinementDecisionCalls,
    jevDecisionCalls, semanticFallback:value.semanticFallback,
    fallbackReason:value.fallbackReason, costUnit:string(value.costUnit, "cost unit")});
}

function operationalEvidence(value, eligible, proposed) {
  if (value == null) return null;
  fields(value, ["status", "requiredObligations", "authoritativeObligations", "semanticNeeded", "semanticNotNeeded",
    "semanticUncertain", "requiredScope", "wrongScopeCapabilityIds", "selectedCapabilityIds", "missingObligations",
    "missingPrerequisiteNativeIds", "incompatiblePairs", "construction", "postPrunedIds", "exactOracleUsed",
    "exactOptimalIds", "verifierValid", "decisionCalls", "topology"]);
  const subset = (values, label) => { const ids=strings(values ?? [], label); if(ids.some(id=>!eligible.includes(id)))throw new TypeError(`Invalid ${label}`); return ids; };
  const selectedCapabilityIds=subset(value.selectedCapabilityIds, "operational selected IDs");
  if(stableStringify(selectedCapabilityIds)!==stableStringify(proposed))throw new TypeError("Operational selection mismatch");
  const incompatiblePairs=(value.incompatiblePairs ?? []).map(pair=>strings(pair, "incompatible pair"));
  if(incompatiblePairs.some(pair=>pair.length!==2))throw new TypeError("Invalid incompatible pair");
  fields(value.decisionCalls, ["attempted", "settled", "failed"]);
  for(const count of Object.values(value.decisionCalls))if(!Number.isSafeInteger(count)||count<0)throw new TypeError("Invalid operational call count");
  if(typeof value.exactOracleUsed!=="boolean"||typeof value.verifierValid!=="boolean")throw new TypeError("Invalid operational evidence flags");
  return freeze({status:enumValue(value.status, ["sufficient", "optimal_proven", "unknown", "infeasible"]),
    requiredObligations:strings(value.requiredObligations ?? [], "required obligations"),
    authoritativeObligations:strings(value.authoritativeObligations ?? [], "authoritative obligations"),
    semanticNeeded:strings(value.semanticNeeded ?? [], "semantic needed"), semanticNotNeeded:strings(value.semanticNotNeeded ?? [], "semantic not needed"),
    semanticUncertain:strings(value.semanticUncertain ?? [], "semantic uncertain"), requiredScope:optionalString(value.requiredScope, "required scope"),
    wrongScopeCapabilityIds:subset(value.wrongScopeCapabilityIds, "wrong-scope IDs"), selectedCapabilityIds,
    missingObligations:strings(value.missingObligations ?? [], "missing obligations"),
    missingPrerequisiteNativeIds:strings(value.missingPrerequisiteNativeIds ?? [], "missing prerequisite native IDs"),
    incompatiblePairs, construction:string(value.construction, "construction"), postPrunedIds:subset(value.postPrunedIds, "post-pruned IDs"),
    exactOracleUsed:value.exactOracleUsed, exactOptimalIds:value.exactOptimalIds==null?null:subset(value.exactOptimalIds, "exact optimal IDs"),
    verifierValid:value.verifierValid, decisionCalls:freeze({...value.decisionCalls}), topology:string(value.topology, "topology")});
}

export function exposureProposal({input, invocation, eligibleIds = [], semanticCandidateIds = [], semanticSelectedIds = [],
  proposedIds = [], policyExcludedIds = [], outcome = "selected", reason = "selection", configuration = {}, hierarchical = null, operational = null}) {
  const normalized = exposureInput(input), known = new Set(normalized.inventory.entries?.map(e => e.capability.id) ?? []);
  const subset = values => {const ids = strings(values); if (ids.some(id => !known.has(id))) throw new TypeError("Unknown proposal capability"); return ids};
  const eligible = subset(eligibleIds), semantic = subset(semanticCandidateIds), selected = subset(semanticSelectedIds), proposed = subset(proposedIds);
  if (semantic.some(id => !eligible.includes(id)) || selected.some(id => !semantic.includes(id))) throw new TypeError("Invalid semantic candidate coverage");
  enumValue(outcome, ["selected", "no_decision", "error"]);
  enumValue(reason, ["selection", "all_eligible", "inventory_unknown", "known_empty", "explicit_unresolved", "provider_failure", "invalid_semantic_decision", "strategy_failure", "limits_exceeded"]);
  if (normalized.inventory.state === "unknown" && (outcome !== "no_decision" || reason !== "inventory_unknown")
      || !configuration || typeof configuration !== "object" || Array.isArray(configuration)
      || Object.values(configuration).some(value => typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value) && value >= 0))) throw new TypeError("Invalid exposure proposal");
  const canonicalInvocation = capabilityInvocation(invocation.caller, invocation.invocation_id, invocation.session_id);
  if (stableStringify(invocation) !== stableStringify(canonicalInvocation)) throw new TypeError("Invalid invocation context");
  const hierarchy = hierarchicalEvidence(hierarchical, eligible, proposed);
  const operations = operationalEvidence(operational, eligible, proposed);
  const body = {version:CAPABILITY_VERSION, taskId:normalized.task.id, taskHash:sha256(normalized.task), inventoryId:normalized.inventory.id,
    policyHash:sha256(normalized.policy), constraintsHash:sha256(normalized.constraints), strategy:invocation.caller, invocation:canonicalInvocation,
    eligibleIds:eligible, semanticCandidateIds:semantic, semanticSelectedIds:selected, proposedIds:proposed,
    withheldIds:[...known].filter(id => !proposed.includes(id)).sort(), explicitlyRequiredIds:normalized.constraints.includeIds,
    policyExcludedIds:subset(policyExcludedIds), outcome, reason, configuration:{...configuration}, hierarchical:hierarchy,
    shadow:true, actuallyExposed:false, application:"not_applied"};
  if(operations!==null)body.operational=operations;
  return freeze({id:`exposure_${sha256(body)}`, ...body});
}

export function validateExposureProposal(proposal, input) {
  if (!proposal || typeof proposal !== "object") throw new TypeError("Exposure proposal required");
  const rebuilt = exposureProposal({input, invocation:proposal.invocation, eligibleIds:proposal.eligibleIds,
    semanticCandidateIds:proposal.semanticCandidateIds, semanticSelectedIds:proposal.semanticSelectedIds, proposedIds:proposal.proposedIds,
    policyExcludedIds:proposal.policyExcludedIds, outcome:proposal.outcome, reason:proposal.reason, configuration:proposal.configuration,
    hierarchical:proposal.hierarchical, operational:proposal.operational});
  if (stableStringify(proposal) !== stableStringify(rebuilt)) throw new TypeError("Exposure proposal identity or content mismatch");
  return proposal;
}
