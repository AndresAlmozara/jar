import { sha256, stableStringify } from "../../core/src/hash.js";
import { freeze } from "../../capability-exposure/src/contracts.js";
import { CODEX_PROFILE } from "./profiles.js";
import { CODEX_RUNTIME_METADATA_POLICY, resolveCodexRuntimeMetadataPolicy } from "./codex-runtime-metadata-policy.js";

// Authoritative shared-runtime contract. No I/O, profile mutation or launch authority.
export const ADMISSION_VERSION = "runtime.profile.admission.v3";
export const REQUIRED_CONTRIBUTORS = Object.freeze([
  "builtins", "synthetic-tools", "host-skills", "system-skills", "plugins", "extensions",
  "mcp", "mcp-instructions", "tool-search", "deferred-tools", "dynamic-tools",
  "description.code-mode-typescript", "contributor-generated-context",
]);
export const REQUIRED_LOCATIONS = Object.freeze([
  ...CODEX_PROFILE.representations, "description.code-mode-typescript", "input.messages", "instructions",
]);
const issued = new WeakSet();
export function closed(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(k => !fields.includes(k)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), "value")))
    throw new TypeError("Invalid admission fields");
}
export function label(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(value)) throw new TypeError("Invalid admission label");
  return value;
}
export function hash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Invalid evidence hash");
  return value;
}
function list(value, normalize) {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError("Invalid admission list");
  return value.map(normalize).sort((a,b) => stableStringify(a).localeCompare(stableStringify(b)));
}
function unique(items, key = x => x) {
  if (new Set(items.map(key)).size !== items.length) throw new TypeError("Duplicate admission fact");
  return items;
}
function choice(value, values) {
  if (!values.includes(value)) throw new TypeError("Invalid admission state");
  return value;
}
function coverage(value, states) {
  return unique(list(value, item => {
    closed(item, ["id", "state"]);
    return {id:label(item.id), state:choice(item.state, states)};
  }), item => item.id);
}

/** Metadata-only candidate. Evidence references are opaque IDs, never raw paths/config.
 * Hashes bind exact artifacts; they do not authenticate the operator/evidence producer.
 */
export function runtimeProfileAdmissionCandidate(input) {
  closed(input, ["runtimeFamily", "runtimeVersion", "sourceCommit", "providerProtocol", "requestScope", "baseProfileId",
    "evidenceClass", "binaryHash", "configHash", "correlationId", "locations", "contributors",
    "toolMode", "toolSearch", "deferred", "contextHashes", "expectedTools", "evidenceRefs", "runtimeMetadataPolicyId"]);
  const facts = {
    runtimeFamily:label(input.runtimeFamily), runtimeVersion:label(input.runtimeVersion), sourceCommit:label(input.sourceCommit),
    providerProtocol:label(input.providerProtocol), requestScope:label(input.requestScope), baseProfileId:label(input.baseProfileId),
    binaryHash:hash(input.binaryHash), configHash:hash(input.configHash),
    runtimeMetadataPolicyId:input.runtimeMetadataPolicyId === null ? null : label(input.runtimeMetadataPolicyId),
    runtimeMetadataPolicyVersion:input.runtimeMetadataPolicyId === null ? null
      : input.runtimeMetadataPolicyId === CODEX_RUNTIME_METADATA_POLICY.policyId
        ? CODEX_RUNTIME_METADATA_POLICY.policyVersion : "unknown",
    locations:coverage(input.locations, ["VERIFIED", "EXCLUDED", "UNKNOWN"]),
    contributors:coverage(input.contributors, ["ACTIVE", "EXCLUDED", "UNKNOWN"]),
    toolMode:choice(input.toolMode, ["direct", "code", "unknown"]),
    toolSearch:choice(input.toolSearch, ["disabled", "enabled", "unknown"]),
    deferred:choice(input.deferred, ["disabled", "enabled", "unknown"]),
    contextHashes:unique(list(input.contextHashes, hash)),
    expectedTools:unique(list(input.expectedTools, item => {
      closed(item, ["nativeId", "definitionHash", "namespaceDescriptionHash", "requiredInCapture"]);
      if (typeof item.requiredInCapture !== "boolean") throw new TypeError("Invalid expected tool requirement");
      return {nativeId:label(item.nativeId), definitionHash:hash(item.definitionHash),
        namespaceDescriptionHash:item.namespaceDescriptionHash === null ? null : hash(item.namespaceDescriptionHash),
        requiredInCapture:item.requiredInCapture};
    }), item => item.nativeId),
  };
  const body = {version:ADMISSION_VERSION, facts, factsHash:sha256(facts),
    evidenceClass:choice(input.evidenceClass, ["runtime_preflight", "fixture"]),
    correlationId:label(input.correlationId), evidenceRefs:unique(list(input.evidenceRefs, label))};
  return freeze({id:`admission_candidate_${sha256(body)}`, ...body});
}

/** Records MUST come from a trusted evidence collector/reviewer, separately from
 * an untrusted candidate. This validates binding/coverage, not artifact authenticity.
 * kind vocabulary is inherited from runtime.adapter.v2. Fixture/source-only records
 * never establish runtime provenance. There is deliberately no receipt-loader here.
 */
export function evaluateRuntimeAdmission(input, evidenceRecords = []) {
  let candidate;
  const result = (state, reasons, missingEvidence = []) => {
    const body = {version:ADMISSION_VERSION, state, reasons:[...new Set(reasons)].sort(),
      missingEvidence:[...new Set(missingEvidence)].sort(), candidateId:candidate?.id ?? null,
      admittedProfileId:state === "REJECTED" ? null : `runtime_profile_${candidate.factsHash}`,
      facts:candidate?.facts ?? null, correlationId:candidate?.correlationId ?? null,
      evidenceRefs:candidate?.evidenceRefs ?? [], runtimeCaptureAuthorized:false};
    const outcome = freeze({id:`admission_${sha256(body)}`, ...body}); issued.add(outcome); return outcome;
  };
  try {
    candidate = runtimeProfileAdmissionCandidate(input);
    const f = candidate.facts;
    if (f.baseProfileId !== CODEX_PROFILE.id || f.runtimeFamily !== CODEX_PROFILE.runtimeFamily
      || !CODEX_PROFILE.versions.includes(f.runtimeVersion) || f.providerProtocol !== CODEX_PROFILE.providerProtocol
      || f.requestScope !== CODEX_PROFILE.requestScope) return result("REJECTED", ["unrecognized_profile_tuple"]);
    const metadataPolicy = f.runtimeMetadataPolicyId === null ? null : resolveCodexRuntimeMetadataPolicy(f.runtimeMetadataPolicyId);
    if (f.runtimeMetadataPolicyId !== null && (!metadataPolicy || f.runtimeMetadataPolicyVersion !== metadataPolicy.policyVersion
      || metadataPolicy.runtimeFamily !== f.runtimeFamily || metadataPolicy.sourceCommit !== f.sourceCommit
      || metadataPolicy.runtimeVersion !== f.runtimeVersion || metadataPolicy.providerProtocol !== f.providerProtocol
      || metadataPolicy.requestScope !== f.requestScope)) return result("REJECTED", ["runtime_metadata_policy_mismatch"]);
    const records = unique(list(evidenceRecords, r => {
      closed(r, ["ref", "kind", "factsHash", "artifactHash", "correlationId"]);
      return {ref:label(r.ref), kind:choice(r.kind, ["official_source", "local_config", "runtime_process", "runtime_metadata_policy", "fixture"]),
        factsHash:hash(r.factsHash), artifactHash:hash(r.artifactHash), correlationId:label(r.correlationId)};
    }), r => r.ref);
    const referenced = records.filter(r => candidate.evidenceRefs.includes(r.ref));
    if (referenced.some(r => r.factsHash !== candidate.factsHash || r.correlationId !== candidate.correlationId))
      return result("REJECTED", ["contradictory_evidence_binding"]);
    const missing = candidate.evidenceRefs.filter(ref => !referenced.some(r => r.ref === ref));
    for (const kind of ["official_source", "local_config", "runtime_process"])
      if (!referenced.some(r => r.kind === kind)) missing.push(`evidence:${kind}`);
    if (metadataPolicy && !referenced.some(r => r.kind === "runtime_metadata_policy"
      && r.artifactHash === metadataPolicy.evidenceHash)) missing.push("evidence:runtime_metadata_policy");
    if (candidate.evidenceClass !== "runtime_preflight" || referenced.some(r => r.kind === "fixture"))
      missing.push("runtime_provenance");
    for (const [key, required] of [["locations", REQUIRED_LOCATIONS], ["contributors", REQUIRED_CONTRIBUTORS]]) {
      for (const id of required) if (!f[key].some(v => v.id === id && v.state !== "UNKNOWN")) missing.push(`${key}:${id}`);
      for (const item of f[key]) if (!required.includes(item.id)) missing.push(`unknown_${key}`);
    }
    const location = id => f.locations.find(x => x.id === id)?.state;
    const contributor = id => f.contributors.find(x => x.id === id)?.state;
    if (f.toolMode === "direct" && (location("description.code-mode-typescript") === "VERIFIED"
      || contributor("description.code-mode-typescript") === "ACTIVE")
      || f.toolSearch === "disabled" && (location("input.tool_search_output") === "VERIFIED" || contributor("tool-search") === "ACTIVE")
      || f.deferred === "disabled" && contributor("deferred-tools") === "ACTIVE")
      return result("REJECTED", ["contradictory_protocol_facts"]);
    if (f.toolMode !== "direct" || f.toolSearch !== "disabled" || f.deferred !== "disabled") missing.push("direct_initial_mode");
    if (location("tools") !== "VERIFIED") missing.push("required_tools_location");
    if (location("description.code-mode-typescript") !== "EXCLUDED"
      || contributor("description.code-mode-typescript") !== "EXCLUDED") missing.push("code_mode_exclusion");
    return result(missing.length ? "ADMITTED_PARTIAL" : "ADMITTED_COMPLETE_FOR_SCOPE",
      [missing.length ? "incomplete_evidence" : "verified_initial_scope"], missing);
  } catch { return result("REJECTED", ["malformed_candidate_or_evidence"]); }
}

export function requireRuntimeAdmission(value) {
  if (!issued.has(value) || value.state === "REJECTED") throw new TypeError("Expected issued runtime admission");
  return value;
}
