import { sha256, stableStringify } from "../../core/src/hash.js";
import { capabilityDescriptor, capabilityInventory, exposureInput, validateExposureProposal,
  freeze, strings, TOOL_LIKE_KINDS } from "../../capability-exposure/src/contracts.js";
import { CapabilityPolicyGate } from "../../capability-exposure/src/policy-gate.js";

export const RUNTIME_CONTRACT_VERSION = "runtime.adapter.v2";
export const SUPPORT_STATES = Object.freeze(["SUPPORTED_VERIFIED", "SUPPORTED_WITH_LIMITS", "EXECUTION_DENY_ONLY",
  "STATIC_ONLY", "UNSUPPORTED", "UNKNOWN", "NOT_TESTED"]);
export const SUPPORT_DIMENSIONS = Object.freeze(["inventoryDiscovery", "toolDiscovery", "mcpDiscovery", "skillDiscovery",
  "pluginDiscovery", "schemaWithholding", "dynamicWithholding", "sessionWithholding", "actualExposureInspection",
  "permissionObservation", "riskObservation", "hooks", "toolInterception", "outputInterception", "restoration",
  "nonInteractiveInvocation", "structuredEvents"]);
export const EFFECT_CLASSES = Object.freeze(["TRUE_SCHEMA_WITHHOLDING", "SESSION_RESTRICTED_SCHEMA_WITHHOLDING",
  "STATIC_SCHEMA_WITHHOLDING", "EXECUTION_DENY_ONLY", "UNSUPPORTED", "UNKNOWN"]);
export const EFFECT_STATUSES = Object.freeze(["applied", "partially_applied", "unsupported", "requires_restart",
  "requires_new_session", "permission_blocked", "failed", "not_attempted", "unverified"]);

// Closed, plain-data shapes are the authoritative boundary. No native config bags.
function fields(value, allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(k => !allowed.includes(k)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), "value"))) throw new TypeError("Invalid runtime contract fields");
}
function text(value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Expected nonempty runtime identifier");
  return value;
}
function optional(value) { return value == null ? null : text(value); }
function choice(value, allowed) {
  if (!allowed.includes(value)) throw new TypeError("Invalid runtime contract state");
  return value;
}
function tri(value) { return choice(value ?? null, [true, false, null]); }
function array(value) { if (!Array.isArray(value)) throw new TypeError("Expected array"); return value; }
function stamped(prefix, body, supplied) {
  const id = `${prefix}_${sha256(body)}`;
  if (supplied !== undefined && supplied !== id) throw new TypeError("Runtime contract identity mismatch");
  return freeze({id, ...body});
}

/** refs are opaque evidence handles, not raw configs, credentials or transcripts. */
export function evidence(input = []) {
  return freeze(array(input).map(item => {
    fields(item, ["kind", "ref"]);
    return {kind:choice(item.kind, ["official_documentation", "official_source", "local_cli", "local_config",
      "runtime_process", "runtime_tool_list", "model_context", "execution_result", "local_filesystem", "fixture", "unknown"]), ref:text(item.ref)};
  }).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))));
}
function direct(refs) { return refs.some(e => ["runtime_tool_list", "fixture"].includes(e.kind)); }
function modelContext(refs) { return refs.some(e => ["model_context", "fixture"].includes(e.kind)); }
function execution(refs) { return refs.some(e => ["execution_result", "fixture"].includes(e.kind)); }

/** Coverage describes inspection, never native precedence or runtime permission.
 * Success means the bounded inspection returned; completeness qualifies its reach.
 * An omitted list means coverage unspecified, not that every source was inspected.
 */
export function sourceCoverage(input = []) {
  const result = array(input).map(item => {
    fields(item, ["sourceId", "kind", "scope", "outcome", "completeness", "evidence", "parserState", "parser", "issues"]);
    const outcome = choice(item.outcome, ["success", "missing", "unparsed", "failed", "not_attempted"]);
    const completeness = choice(item.completeness ?? "unknown", ["complete", "partial", "unknown"]);
    const parserState = choice(item.parserState ?? "unknown",
      ["parsed", "bounded", "malformed", "unsupported", "unavailable", "not_attempted", "unknown"]);
    const refs = evidence(item.evidence);
    if (outcome !== "success" && completeness !== "unknown" || outcome !== "not_attempted" && refs.length === 0)
      throw new TypeError("Invalid source inspection evidence");
    if (["parsed", "bounded"].includes(parserState) && outcome !== "success"
      || ["malformed", "unsupported"].includes(parserState) && outcome !== "unparsed"
      || parserState === "unavailable" && outcome !== "failed"
      || parserState === "bounded" && completeness === "complete") throw new TypeError("Invalid parser coverage state");
    return {sourceId:text(item.sourceId), kind:choice(item.kind, ["config", "installation", "plugin_manifests", "mcp_catalog",
      "skill_catalog", "plugin_roots", "skill_roots", "builtins", "runtime_cli", "runtime_process"]),
    scope:choice(item.scope ?? "unknown", ["user", "project", "local", "managed", "session", "installation", "explicit", "unknown"]),
    outcome, completeness, evidence:refs, parserState,
    parser:choice(item.parser ?? "unknown", ["unknown", "json", "toml_external", "toml_bounded", "skill_metadata_bounded"]),
    issues:strings(item.issues ?? [])};
  }).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  if (new Set(result.map(s => s.sourceId)).size !== result.length) throw new TypeError("Duplicate source coverage ID");
  return freeze(result);
}

/** Stable installation identity excludes mutable version and adapter revision. */
export function runtimeIdentity(input) {
  fields(input, ["id", "family", "runtimeVersion", "adapterVersion", "installationId", "surface", "evidence"]);
  const family = text(input.family), installationId = text(input.installationId), surface = text(input.surface);
  const id = `runtime_${sha256({family, installationId, surface})}`;
  if (input.id !== undefined && input.id !== id) throw new TypeError("Runtime identity mismatch");
  return freeze({id, family, installationId, surface, runtimeVersion:optional(input.runtimeVersion),
    adapterVersion:text(input.adapterVersion), evidence:evidence(input.evidence)});
}

export function supportFact(input = {}) {
  fields(input, ["state", "basis", "evidence"]);
  const state = choice(input.state ?? "UNKNOWN", SUPPORT_STATES);
  const basis = choice(input.basis ?? "instance", ["instance", "documented", "fixture"]), refs = evidence(input.evidence);
  if (!["UNKNOWN", "NOT_TESTED"].includes(state) && (!refs.length
    || basis === "instance" && !refs.some(e => ["local_cli", "runtime_process", "runtime_tool_list", "model_context", "execution_result"].includes(e.kind))
    || basis === "fixture" && !refs.some(e => e.kind === "fixture"))) throw new TypeError("Support requires matching evidence");
  return freeze({state, basis, evidence:refs});
}

export function runtimeSupport(input) {
  fields(input, ["runtimeId", "facts"]); fields(input.facts ?? {}, SUPPORT_DIMENSIONS);
  if (input.facts?.schemaWithholding?.state === "SUPPORTED_VERIFIED" && !modelContext(evidence(input.facts.schemaWithholding.evidence)))
    throw new TypeError("Verified schema withholding requires model-context evidence");
  return freeze({runtimeId:text(input.runtimeId), facts:Object.fromEntries(SUPPORT_DIMENSIONS
    .map(key => [key, supportFact(input.facts?.[key])]))});
}

/** Known means exhaustive within this scope/session; [] is known-empty, never unknown. */
export function actualExposure(input) {
  fields(input, ["id", "runtimeId", "runtimeVersion", "sessionId", "scope", "state", "visibleIds", "evidence", "completeness"]);
  const state = choice(input.state ?? "unknown", ["known", "unknown"]), refs = evidence(input.evidence);
  const scope = input.scope ?? "unknown";
  const completeness = choice(input.completeness ?? (state === "known" && refs.some(e => e.kind === "fixture") ? "complete" : "unknown"),
    ["complete", "partial", "unknown"]);
  if (state === "unknown" && input.visibleIds != null) throw new TypeError("Unknown exposure has no set");
  if (state === "known" && (!modelContext(refs) || scope === "unknown" || completeness !== "complete")) throw new TypeError("Exposure needs complete scoped model-context evidence");
  return stamped("runtime_exposure_observation", {runtimeId:text(input.runtimeId), runtimeVersion:optional(input.runtimeVersion),
    sessionId:optional(input.sessionId), scope:text(scope), state, completeness,
    visibleIds:state === "known" ? strings(input.visibleIds) : null, evidence:refs}, input.id);
}

/** Partial observations are retained separately; the M8 inventory stays unknown. */
export function runtimeObservation(input) {
  fields(input, ["identity", "status", "scope", "completeness", "observations", "evidence", "actualExposure", "issues", "sources", "layerState"]);
  const identity = runtimeIdentity(input.identity), refs = evidence(input.evidence), scope = text(input.scope);
  const status = choice(input.status ?? "ok", ["ok", "runtime_unavailable", "runtime_startup_failed", "runtime_inspection_failed",
    "config_missing", "config_malformed", "config_unreadable", "config_not_inspected", "config_unsupported", "config_parser_unavailable"]);
  const completeness = choice(input.completeness ?? "unknown", ["complete", "partial", "unknown"]);
  const sources = sourceCoverage(input.sources);
  if (completeness === "complete" && sources.some(s => s.outcome !== "success" || s.completeness !== "complete"))
    throw new TypeError("Incomplete source coverage cannot support a complete inventory");
  const observations = array(input.observations ?? []).map(item => {
    fields(item, ["capability", "configured", "configuredEnabled", "configuredPermission", "enabled", "supported", "available", "permission", "requirementsSatisfied",
      "schemaVisible", "actuallyExposed", "parentIds", "evidence"]);
    const capability = capabilityDescriptor(item.capability), itemEvidence = evidence(item.evidence);
    const schemaVisible = tri(item.schemaVisible), actuallyExposed = tri(item.actuallyExposed);
    if ((schemaVisible !== null || actuallyExposed !== null) && !modelContext(itemEvidence)) throw new TypeError("Model-context evidence required for visibility");
    if (([item.enabled, item.supported, item.available, item.requirementsSatisfied].some(v => v != null)
      ) && !direct(itemEvidence))
      throw new TypeError("Configuration intent is not an effective runtime fact");
    if (item.permission != null && item.permission !== "unknown" && !execution(itemEvidence)) throw new TypeError("Execution evidence required for permission observation");
    if ([item.configured, item.configuredEnabled, item.enabled, item.supported, item.available, item.requirementsSatisfied].some(v => v != null)
      && !itemEvidence.length || [item.permission, item.configuredPermission].some(v => v != null && v !== "unknown") && !itemEvidence.length)
      throw new TypeError("Observed facts require evidence");
    return {capability, owner:capability.kind === "skill" ? "M5" : TOOL_LIKE_KINDS.includes(capability.kind) ? "M8" : "discovery",
      configured:tri(item.configured), configuredEnabled:tri(item.configuredEnabled),
      configuredPermission:choice(item.configuredPermission ?? "unknown", ["allowed", "denied", "prompt", "unknown"]), enabled:tri(item.enabled),
      supported:tri(item.supported), available:tri(item.available), requirementsSatisfied:tri(item.requirementsSatisfied),
      permission:choice(item.permission ?? "unknown", ["allowed", "denied", "prompt", "unknown"]), schemaVisible, actuallyExposed,
      parentIds:strings(item.parentIds ?? []), evidence:itemEvidence};
  }).sort((a, b) => a.capability.id.localeCompare(b.capability.id));
  if (new Set(observations.map(o => o.capability.id)).size !== observations.length) throw new TypeError("Duplicate observation");
  if (completeness === "unknown" && observations.length || completeness === "complete" && (!direct(refs) || status !== "ok"))
    throw new TypeError("Invalid completeness evidence");
  const inventory = capabilityInventory({runtime:{id:identity.id, family:identity.family}, source:scope,
    state:completeness === "complete" ? "known" : "unknown", entries:completeness !== "complete" ? null : observations
      .filter(o => o.owner === "M8").map(({capability, available, supported, enabled, permission, requirementsSatisfied}) =>
        ({capability, available, supported, enabled, permission, requirementsSatisfied}))});
  const actual = actualExposure(input.actualExposure ?? {runtimeId:identity.id, runtimeVersion:identity.runtimeVersion});
  if (actual.runtimeId !== identity.id) throw new TypeError("Exposure runtime mismatch");
  if (actual.runtimeVersion !== null && actual.runtimeVersion !== identity.runtimeVersion) throw new TypeError("Exposure version mismatch");
  for (const item of observations) {
    if (item.evidence.some(ref => ref.kind === "fixture")) continue;
    if ([item.schemaVisible, item.actuallyExposed].some(value => value !== null)
      && (actual.state !== "known" || actual.scope !== scope
        || [item.schemaVisible, item.actuallyExposed].some(value => value !== null && value !== actual.visibleIds.includes(item.capability.id))))
      throw new TypeError("Visibility must join a complete matching model-context observation");
  }
  return stamped("runtime_discovery", {identity, status, scope, completeness, observations, inventory, actualExposure:actual,
    evidence:refs, sources, issues:strings(input.issues ?? []),
    layerState:choice(input.layerState ?? "unknown", ["unknown", "single_source", "compatible", "unresolved", "partial"])});
}

/** Validate M8 binding and recompute its independent gate; adapters do not route. */
export function exposureRequest({input:rawInput, proposal}) {
  const input = exposureInput(rawInput); validateExposureProposal(proposal, input);
  const effective = new CapabilityPolicyGate().evaluate({input, proposal});
  return freeze({proposalId:proposal.id, inventoryId:input.inventory.id, taskId:input.task.id,
    invocationId:proposal.invocation.invocation_id, sessionId:proposal.invocation.session_id,
    exposedIds:effective.effectiveIds, withheldIds:effective.withheldIds,
    policyRejectedIds:effective.rejections.map(r => r.id).sort()});
}

/** Native mapping/operations are held privately by the adapter, addressed by plan ID. */
export function runtimeExposurePlan(input) {
  fields(input, ["id", "runtimeId", "request", "supportedIds", "unsupportedIds", "effectClass", "scope", "requiresRestart",
    "requiresNewSession", "reversible", "evidence", "conflicts", "translationHash", "discoveryId", "exposureObservationId"]);
  fields(input.request, ["proposalId", "inventoryId", "taskId", "invocationId", "sessionId", "exposedIds", "withheldIds", "policyRejectedIds"]);
  const request = {proposalId:text(input.request.proposalId), inventoryId:text(input.request.inventoryId), taskId:text(input.request.taskId),
    invocationId:text(input.request.invocationId), sessionId:optional(input.request.sessionId),
    exposedIds:input.request.exposedIds === null ? null : strings(input.request.exposedIds),
    withheldIds:input.request.withheldIds === null ? null : strings(input.request.withheldIds), policyRejectedIds:strings(input.request.policyRejectedIds)};
  if ((request.exposedIds === null) !== (request.withheldIds === null)
    || request.exposedIds?.some(id => request.withheldIds.includes(id))) throw new TypeError("Invalid requested partition");
  const all = [...(request.exposedIds ?? []), ...(request.withheldIds ?? [])];
  if (request.policyRejectedIds.some(id => !all.includes(id) || request.exposedIds.includes(id))) throw new TypeError("Invalid policy rejection set");
  const supportedIds = strings(input.supportedIds ?? []), unsupportedIds = strings(input.unsupportedIds ?? []);
  if ([...supportedIds, ...unsupportedIds].some(id => !all.includes(id))
    || supportedIds.some(id => unsupportedIds.includes(id))) throw new TypeError("Invalid mapping partition");
  const effectClass = choice(input.effectClass ?? "UNKNOWN", EFFECT_CLASSES), refs = evidence(input.evidence);
  if (effectClass !== "UNKNOWN" && !refs.length) throw new TypeError("Mechanism classification requires evidence");
  return stamped("runtime_plan", {version:RUNTIME_CONTRACT_VERSION, runtimeId:text(input.runtimeId), request, supportedIds, unsupportedIds,
    unknownIds:all.filter(id => !supportedIds.includes(id) && !unsupportedIds.includes(id)).sort(), effectClass,
    scope:text(input.scope ?? "unknown"), requiresRestart:tri(input.requiresRestart), requiresNewSession:tri(input.requiresNewSession),
    reversible:tri(input.reversible), evidence:refs, conflicts:strings(input.conflicts ?? []), translationHash:optional(input.translationHash),
    discoveryId:optional(input.discoveryId), exposureObservationId:optional(input.exposureObservationId),
    application:"not_attempted"}, input.id);
}

function sameExposure(a, b) {
  return a.state === "known" && b.state === "known" && a.runtimeId === b.runtimeId && a.scope === b.scope
    && a.runtimeVersion === b.runtimeVersion && a.sessionId === b.sessionId && stableStringify(a.visibleIds) === stableStringify(b.visibleIds);
}
export function restorationState(input) {
  fields(input, ["before", "observed", "planId", "status"]);
  const before = actualExposure(input.before), observed = actualExposure(input.observed ?? {runtimeId:before.runtimeId});
  const status = choice(input.status ?? "not_attempted", ["not_attempted", "planned", "restored", "failed", "unverified"]);
  if (before.runtimeId !== observed.runtimeId || status === "restored" && !sameExposure(before, observed))
    throw new TypeError("Restoration requires matching observed exposure");
  return freeze({before, observed, planId:optional(input.planId), status});
}

/** Effect receipts are future data, not an implementation of effects. */
export function runtimeEffectResult(input) {
  fields(input, ["plan", "status", "attemptId", "observed", "restoration"]);
  const plan = input.plan;
  // Validate canonical plan without accepting arbitrary extra/native fields.
  if (!plan || plan.application !== "not_attempted") throw new TypeError("Canonical plan required");
  const {version, unknownIds, application, ...raw} = plan;
  if (stableStringify(runtimeExposurePlan(raw)) !== stableStringify(plan)) throw new TypeError("Plan mismatch");
  const status = choice(input.status ?? "not_attempted", EFFECT_STATUSES), attemptId = optional(input.attemptId);
  const observed = actualExposure(input.observed ?? {runtimeId:plan.runtimeId});
  if (observed.runtimeId !== plan.runtimeId || status === "not_attempted" && attemptId !== null
    || ["applied", "partially_applied", "failed", "unverified"].includes(status) && attemptId === null)
    throw new TypeError("Invalid effect attempt");
  if (["applied", "partially_applied"].includes(status) && (observed.state !== "known"
    || ["EXECUTION_DENY_ONLY", "UNKNOWN", "UNSUPPORTED"].includes(plan.effectClass))) throw new TypeError("Effect is unverified");
  if (status === "applied" && (plan.request.exposedIds === null || observed.scope !== plan.scope
    || observed.sessionId !== plan.request.sessionId
    || stableStringify(observed.visibleIds) !== stableStringify(plan.request.exposedIds))) throw new TypeError("Exposure does not match plan");
  const restoration = restorationState(input.restoration ?? {before:{runtimeId:plan.runtimeId}});
  if (restoration.before.runtimeId !== plan.runtimeId) throw new TypeError("Restoration runtime mismatch");
  if (status === "partially_applied") {
    const before = restoration.before, desired = plan.request.exposedIds;
    if (before.state !== "known" || desired === null || observed.scope !== plan.scope || before.scope !== observed.scope
      || before.sessionId !== observed.sessionId || observed.sessionId !== plan.request.sessionId)
      throw new TypeError("Partial effect requires comparable before/after evidence");
    const added = observed.visibleIds.filter(id => !before.visibleIds.includes(id));
    const removed = before.visibleIds.filter(id => !observed.visibleIds.includes(id));
    if (!added.length && !removed.length || added.some(id => !desired.includes(id))
      || removed.some(id => !plan.request.withheldIds.includes(id)) || stableStringify(observed.visibleIds) === stableStringify(desired))
      throw new TypeError("No verified partial requested effect");
  }
  return freeze({planId:plan.id, runtimeId:plan.runtimeId, proposalId:plan.request.proposalId, taskId:plan.request.taskId,
    discoveryId:plan.discoveryId, exposureObservationId:plan.exposureObservationId,
    inventoryId:plan.request.inventoryId, invocationId:plan.request.invocationId, sessionId:plan.request.sessionId,
    status, attemptId, observed, restoration,
    verification:{mapping:plan.request.exposedIds === null ? "unknown" : plan.unknownIds.length || plan.unsupportedIds.length ? "partial" : "complete",
      nativeIntent:plan.translationHash ? "represented_not_executed" : "unknown",
      mechanismBasis:plan.evidence.some(ref => ref.kind === "official_source") ? "source"
        : plan.evidence.some(ref => ref.kind === "official_documentation") ? "documented"
        : plan.evidence.some(ref => ref.kind === "fixture") ? "fixture" : "unknown",
      localMechanism:"unknown", effect:["applied", "partially_applied"].includes(status) ? "observed" : "unverified",
      schemaWithholding:status === "applied" && plan.request.withheldIds?.length > 0 ? "observed" : "unverified"}});
}

/** New M9 seam, independent of legacy observer APIs. All methods return plain data.
 * identify(), capabilities(), snapshot(), inspectExposure(), planExposure({input,proposal}),
 * applyExposure(plan), restoreExposure(plan). Last two MUST remain disabled in M9.
 */
export function assertRuntimeAdapter(adapter) {
  for (const name of ["identify", "capabilities", "snapshot", "inspectExposure", "planExposure", "applyExposure", "restoreExposure"])
    if (typeof adapter?.[name] !== "function") throw new TypeError(`Missing adapter method: ${name}`);
  return adapter;
}
