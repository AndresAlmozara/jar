import { sha256, stableStringify } from "../../core/src/hash.js";
import { freeze } from "../../capability-exposure/src/contracts.js";
import { runtimeIdentity, runtimeExposurePlan } from "../../runtime-adapters/src/contracts.js";
import { CAPTURE_MODE, CODEX_PROFILE, getProtocolProfile } from "./profiles.js";
import { CaptureInputError, parseRequestJSON, redactHeaders } from "./privacy.js";
import { createHash } from "node:crypto";
import { closed, label, hash, requireRuntimeAdmission } from "./admission.js";
import { resolveCodexRuntimeMetadataPolicy, validateCodexRuntimeMetadata } from "./codex-runtime-metadata-policy.js";

const observations = new WeakSet();
const runtimeValidationDiagnostics = new WeakMap();
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const nameOK = x => typeof x === "string" && /^[A-Za-z0-9_.:/-]{1,160}$/.test(x);
const token = x => { if (!nameOK(x)) throw new TypeError("Invalid capture identifier"); return x; };
const digest = value => ({hash:sha256(value), bytes:Buffer.byteLength(stableStringify(value))});
const planFields = ["id", "runtimeId", "request", "supportedIds", "unsupportedIds", "effectClass", "scope",
  "requiresRestart", "requiresNewSession", "reversible", "evidence", "conflicts", "translationHash", "discoveryId", "exposureObservationId"];
const runtimeEnvelopeFields = ["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream",
  "stream_options", "include", "service_tier", "prompt_cache_key", "text", "client_metadata", "access_programs"];
const toolShapeIssues = new Set(["malformed_tool", "malformed_namespace", "unknown_tool_variant", "invalid_tool_identity",
  "malformed_function", "malformed_custom", "unsupported_custom_format", "malformed_tool_search", "malformed_container",
  "conflicting_duplicate_tool", "ambiguous_native_label"]);
const issueReason = issue => {
  if (issue === "scope_or_profile_mismatch" || issue === "unadmitted_request_location") return "CAPTURE_SCOPE_INCOMPLETE";
  if (issue === "runtime_admission_partial") return "RUNTIME_PROFILE_MISMATCH";
  if (issue === "missing_capture" || issue === "malformed_runtime_envelope" || issue === "malformed_input"
    || issue === "malformed_input_item" || issue === "malformed_input_metadata") return "REQUEST_SHAPE_INVALID";
  if (issue === "unknown_field") return "UNKNOWN_TOP_LEVEL_OR_NESTED_FIELD";
  if (issue === "missing_required_container") return "TOOL_CONTAINER_MISSING";
  if (toolShapeIssues.has(issue)) return "TOOL_CONTAINER_SHAPE_INVALID";
  if (issue === "unexpected_tool_definition") return "TOOL_DEFINITION_MISMATCH";
  if (issue === "missing_expected_tool") return "TOOL_INVENTORY_MISMATCH";
  if (issue === "unknown_contributor" || issue === "uninterpreted_input_item" || issue === "dynamic_tool_search"
    || issue === "deferred_tool" || issue === "hosted_tool_settings_unvalidated") return "UNEXPECTED_CONTRIBUTOR_SURFACE";
  if (issue === "unreviewed_request_context" || issue === "unreviewed_instruction_context") return "CAPTURE_FINGERPRINT_MISMATCH";
  if (issue.startsWith("missing_dynamic_field:")) return "RUNTIME_METADATA_REQUIRED_FIELD_MISSING";
  if (issue.startsWith("invalid_dynamic_field:")) return "RUNTIME_METADATA_POLICY_REJECTED";
  return "PROVIDER_REQUEST_VALIDATION_FAILURE";
};

/** Metadata-only, fixture evidence. No adapter application or exposure promotion.
 * Profile identities are selected from the closed registry, not trusted booleans.
 */
export function captureFixtureRequest({mode, raw, headers = {}, runtime, profileId = CODEX_PROFILE.id,
  providerProtocol, requestScope, invocationId, turnId, ordinal = 1, plan = null,
  mappings = [], unknownContributor = false} = {}) {
  if (mode !== CAPTURE_MODE) throw new TypeError("Only FIXTURE_ONLY capture is authorized");
  const identity = runtimeIdentity(runtime), profile = getProtocolProfile(profileId);
  token(invocationId); token(turnId);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new TypeError("Invalid request ordinal");
  if (typeof unknownContributor !== "boolean") throw new TypeError("Invalid contributor flag");
  redactHeaders(headers); // Discard result too: no header names/values in persistence.
  let correlation = {runtimeInvocationId:invocationId, turnId, planId:null};
  let validatedPlan = null;
  if (plan !== null) {
    validatedPlan = runtimeExposurePlan(Object.fromEntries(planFields.filter(k => Object.hasOwn(plan, k)).map(k => [k, plan[k]])));
    if (validatedPlan.runtimeId !== identity.id) throw new TypeError("Plan runtime mismatch");
    correlation = {...correlation, planId:validatedPlan.id, proposalId:validatedPlan.request.proposalId,
      inventoryId:validatedPlan.request.inventoryId, taskId:validatedPlan.request.taskId,
      planInvocationId:validatedPlan.request.invocationId, planSessionId:validatedPlan.request.sessionId};
  }
  if (!Array.isArray(mappings) || mappings.length > 1000) throw new TypeError("Invalid mappings");
  const canonical = new Map();
  for (const mapping of mappings) {
    if (!object(mapping) || Object.keys(mapping).some(k => !["nativeId", "canonicalId"].includes(k)))
      throw new TypeError("Invalid mapping");
    token(mapping.nativeId); token(mapping.canonicalId);
    if (canonical.has(mapping.nativeId) || validatedPlan && !validatedPlan.supportedIds.includes(mapping.canonicalId))
      throw new TypeError("Unbound or duplicate mapping");
    canonical.set(mapping.nativeId, mapping.canonicalId);
  }
  const issues = new Set(), inspected = new Set(), tools = new Map();
  const mismatch = identity.family !== profile.runtimeFamily || !profile.versions.includes(identity.runtimeVersion)
    || providerProtocol !== profile.providerProtocol || requestScope !== profile.requestScope || ordinal !== 1;
  if (mismatch) issues.add("scope_or_profile_mismatch");
  if (profile.completeness !== "COMPLETE") issues.add("profile_partial");
  if (profile.unresolvedRepresentations.length) issues.add("unresolved_representation");
  if (unknownContributor) issues.add("unknown_contributor");
  function fields(value, keys) {
    if (Object.keys(value).some(k => !keys.includes(k))) issues.add("unknown_field");
  }
  function description(value) {
    if (value !== undefined && typeof value !== "string") issues.add("malformed_description");
    if (typeof value === "string" && value.length && profile.completeness === "COMPLETE")
      issues.add("unreviewed_description_representation");
    return typeof value === "string" ? {descriptionHash:sha256(value), descriptionBytes:Buffer.byteLength(value)} : {};
  }
  function tool(value, location, namespace = null, namespaceDescription = {}) {
    if (!object(value)) { issues.add("malformed_tool"); return; }
    if (value.type === "namespace") {
      if (namespace !== null || !nameOK(value.name) || !Array.isArray(value.tools)) {
        issues.add("malformed_namespace"); return;
      }
      fields(value, ["type", "name", "description", "tools"]);
      const meta = description(value.description);
      value.tools.forEach((child, i) => tool(child, `${location}.tools[${i}]`, value.name, meta));
      return;
    }
    const kind = value.type;
    if (!["function", "custom", "tool_search", "web_search"].includes(kind)
      || namespace !== null && !["function", "custom"].includes(kind)) {
      issues.add("unknown_tool_variant"); return;
    }
    const name = ["tool_search", "web_search"].includes(kind) ? kind : value.name;
    if (!nameOK(name)) { issues.add("invalid_tool_identity"); return; }
    if (kind === "function") {
      fields(value, ["type", "name", "description", "strict", "defer_loading", "parameters"]);
      if (!object(value.parameters) || value.strict !== undefined && typeof value.strict !== "boolean") {
        issues.add("malformed_function"); return;
      }
    } else if (kind === "custom") {
      fields(value, ["type", "name", "description", "defer_loading", "format"]);
      if (!object(value.format)) { issues.add("malformed_custom"); return; }
      fields(value.format, ["type", "syntax", "definition"]);
      if (value.format.type !== "grammar" || !["lark", "regex"].includes(value.format.syntax)
        || typeof value.format.definition !== "string") { issues.add("unsupported_custom_format"); return; }
    } else if (kind === "tool_search") {
      fields(value, ["type", "execution", "description", "parameters"]);
      if (!object(value.parameters)) { issues.add("malformed_tool_search"); return; }
      issues.add("dynamic_tool_search");
    } else {
      fields(value, ["type", "external_web_access", "indexed_web_access", "filters", "user_location", "search_context_size", "search_content_types"]);
      issues.add("hosted_tool_settings_unvalidated");
    }
    if (value.defer_loading !== undefined && typeof value.defer_loading !== "boolean") issues.add("invalid_deferred_flag");
    if (value.defer_loading === true) issues.add("deferred_tool");
    const nativeId = namespace === null ? name : `${namespace}/${name}`;
    // namespace/name is the authoritative tuple; slash-joined nativeId is just a label.
    const key = stableStringify([namespace, name]);
    const schema = digest(value.parameters ?? value.format ?? value);
    const representation = {location, kind, requestScope:profile.requestScope, schemaHash:schema.hash, schemaBytes:schema.bytes,
      definitionHash:sha256(value), deferred:value.defer_loading === true,
      ...description(value.description), namespaceDescriptionHash:namespaceDescription.descriptionHash ?? null,
      namespaceDescriptionBytes:namespaceDescription.descriptionBytes ?? 0};
    const previous = tools.get(key);
    if (previous) {
      if (previous.representations.some(r => r.definitionHash !== representation.definitionHash || r.kind !== kind
        || r.descriptionHash !== representation.descriptionHash || r.namespaceDescriptionHash !== representation.namespaceDescriptionHash))
        issues.add("conflicting_duplicate_tool");
      previous.representations.push(representation);
    } else tools.set(key, {nativeId, namespace, name, canonicalId:canonical.get(nativeId) ?? null, representations:[representation]});
  }
  function container(values, location, family) {
    inspected.add(family);
    if (!Array.isArray(values)) { issues.add("malformed_container"); return; }
    values.forEach((v, i) => tool(v, `${location}[${i}]`));
  }
  if (raw !== null && raw !== undefined) {
    const request = parseRequestJSON(raw);
    if (!object(request)) throw new CaptureInputError("invalid_envelope");
    fields(request, profile.completeness === "COMPLETE" ? ["tools", "input"] :
      ["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream",
        "stream_options", "include", "service_tier", "prompt_cache_key", "text", "client_metadata", "access_programs"]);
    if (Object.hasOwn(request, "tools")) container(request.tools, "tools", "tools");
    if (Object.hasOwn(request, "input")) {
      if (!Array.isArray(request.input)) issues.add("malformed_input");
      else request.input.forEach((item, index) => {
        if (!object(item)) { issues.add("malformed_input_item"); return; }
        if (["additional_tools", "tool_search_output"].includes(item.type)) {
          fields(item, item.type === "additional_tools" ? ["type", "id", "role", "tools"]
            : ["type", "id", "call_id", "status", "execution", "tools", "internal_chat_message_metadata_passthrough"]);
          const requiredText = item.type === "additional_tools" ? ["role"] : ["status", "execution"];
          if (requiredText.some(key => typeof item[key] !== "string")
            || ["id", "call_id"].some(key => item[key] != null && typeof item[key] !== "string"))
            issues.add("malformed_input_metadata");
          if (item.internal_chat_message_metadata_passthrough !== undefined) issues.add("unknown_contributor");
          container(item.tools, `input[${index}].tools`, `input.${item.type}`);
        } else issues.add("uninterpreted_input_item");
      });
    }
    for (const required of profile.requiredContainers) if (!inspected.has(required)) issues.add("missing_required_container");
  } else issues.add("missing_capture");
  const completeness = raw == null || mismatch ? "UNKNOWN" : issues.size ? "PARTIAL" : "COMPLETE";
  const resultTools = [...tools.values()].sort((a,b) => stableStringify([a.namespace,a.name]).localeCompare(stableStringify([b.namespace,b.name])));
  if (new Set(resultTools.map(t => t.nativeId)).size !== resultTools.length) {
    issues.add("ambiguous_native_label");
    for (const item of resultTools) item.canonicalId = null;
  }
  const body = {version:"captured.model.request.v1", mode, evidenceClass:"fixture", runtimeCaptureAuthorized:false,
    runtime:{id:identity.id, family:identity.family, version:identity.runtimeVersion},
    providerProtocol:providerProtocol === profile.providerProtocol ? profile.providerProtocol : "unknown",
    requestScope:requestScope === profile.requestScope ? profile.requestScope : "unknown", ordinal,
    representationProfileId:profile.id, profileCompleteness:profile.completeness, correlation,
    inspectedLocations:[...inspected].sort(), tools:resultTools,
    completeness:completeness === "COMPLETE" && issues.size ? "PARTIAL" : completeness, issues:[...issues].sort()};
  const observation = freeze({id:`capture_${sha256(body)}`, ...body});
  observations.add(observation);
  return observation;
}

export function observeTool(observation, nativeId) {
  if (!observations.has(observation)) throw new TypeError("Expected issued capture observation");
  token(nativeId);
  return observation.tools.some(t => t.nativeId === nativeId) ? "PRESENT"
    : observation.completeness === "COMPLETE" ? "ABSENT" : "UNKNOWN";
}

/** Only issued, immutable, metadata-only observations can reach this serializer.
 * Deliberately no generic raw-object logger or filesystem side effects.
 */
export function serializeCapture(observation) {
  if (!observations.has(observation)) throw new TypeError("Expected issued capture observation");
  return `${JSON.stringify(observation)}\n`;
}

/** Privacy-safe diagnostics for an issued runtime observation. Raw request
 * content is deliberately retained only on the stack of captureRuntimeRequest.
 */
export function inspectRuntimeCaptureValidation(observation, {expectedToolNames, expectedModelHash}) {
  if (!observations.has(observation) || !runtimeValidationDiagnostics.has(observation))
    throw new TypeError("Expected issued runtime capture observation");
  if (!Array.isArray(expectedToolNames) || expectedToolNames.some(name => !nameOK(name))
    || new Set(expectedToolNames).size !== expectedToolNames.length
    || typeof expectedModelHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedModelHash))
    throw new TypeError("Invalid validation diagnostic expectation");
  const internal = runtimeValidationDiagnostics.get(observation);
  const expected = [...expectedToolNames].sort(), observed = [...internal.observedToolNames].sort();
  const expectedToolNamesHash = sha256(expected), observedToolNamesHash = internal.toolInventoryEvaluable ? sha256(observed) : null;
  const toolInventoryMatch = internal.toolInventoryEvaluable
    ? stableStringify(expected) === stableStringify(observed) : false;
  const reasons = new Set(observation.issues.map(issueReason));
  if (internal.unknownTopLevelKeyCount > 0) reasons.add("UNKNOWN_TOP_LEVEL_FIELD");
  if (internal.toolContainerPresent && !internal.toolInventoryEvaluable) reasons.add("TOOL_INVENTORY_NOT_EVALUABLE");
  if (internal.toolInventoryEvaluable && !toolInventoryMatch) reasons.add("TOOL_INVENTORY_MISMATCH");
  for (const failure of internal.runtimeMetadataFailures) reasons.add(`RUNTIME_METADATA_${failure.reasonCode}`);
  return freeze({schemaVersion:"m11.capture-validation-diagnostics.v1",
    validationFailureCodes:[...reasons].sort(), requestShapeFingerprint:internal.requestShapeFingerprint,
    topLevelKeySetHash:internal.topLevelKeySetHash, unknownTopLevelKeyCount:internal.unknownTopLevelKeyCount,
    requiredFieldPresenceBitmap:internal.requiredFieldPresenceBitmap,
    toolContainerPresent:internal.toolContainerPresent, toolInventoryEvaluable:internal.toolInventoryEvaluable,
    observedToolCount:internal.toolInventoryEvaluable ? observed.length : null, observedToolNamesHash,
    expectedToolCount:expected.length, expectedToolNamesHash, toolInventoryMatch,
    modelPresent:internal.modelPresent, modelHashMatches:internal.modelHash === null ? false : internal.modelHash === expectedModelHash,
    runtimeMetadataPolicyId:internal.runtimeMetadataPolicyId,
    runtimeMetadataValidationPassed:internal.runtimeMetadataValidationPassed,
    unknownRuntimeMetadataKeyCount:internal.unknownRuntimeMetadataKeyCount,
    captureScopeCompletenessState:observation.completeness});
}

/** Offline runtime evidence admission, NOT a runtime/server launcher. The caller
 * must be the trusted capture collector: a body-bound model_context record cannot
 * be supplied by an untrusted request. No runtime safety permission is inferred.
 * The fixture API and loopback fixture sink remain unchanged.
 */
export function captureRuntimeRequest(input) {
  closed(input, ["raw", "headers", "runtime", "providerProtocol", "requestScope", "invocationId", "turnId",
    "ordinal", "plan", "mappings", "unknownContributor", "admission", "captureEvidence"]);
  const admission = requireRuntimeAdmission(input.admission), f = admission.facts;
  const proof = input.captureEvidence;
  closed(proof, ["kind", "ref", "requestHash", "binaryHash", "configHash", "correlationId", "invocationId", "turnId", "ordinal"]);
  label(proof.ref); hash(proof.requestHash); hash(proof.binaryHash); hash(proof.configHash);
  if (proof.kind !== "model_context" || proof.correlationId !== admission.correlationId
    || proof.binaryHash !== f.binaryHash || proof.configHash !== f.configHash
    || proof.invocationId !== input.invocationId || proof.turnId !== input.turnId
    || proof.ordinal !== (input.ordinal ?? 1)) throw new TypeError("Unbound runtime capture evidence");
  const request = parseRequestJSON(input.raw);
  if (createHash("sha256").update(input.raw).digest("hex") !== proof.requestHash)
    throw new TypeError("Runtime request hash mismatch");
  const fixture = captureFixtureRequest({...input, mode:CAPTURE_MODE, profileId:f.baseProfileId});
  if (fixture.runtime.family !== f.runtimeFamily || fixture.runtime.version !== f.runtimeVersion
    || input.providerProtocol !== f.providerProtocol || input.requestScope !== f.requestScope)
    throw new TypeError("Runtime admission scope mismatch");
  const issues = new Set(fixture.issues);
  let runtimeMetadataBindings = [], runtimeMetadataFailures = [];
  if (admission.state === "ADMITTED_COMPLETE_FOR_SCOPE") {
    issues.delete("profile_partial"); issues.delete("unresolved_representation");
  } else issues.add("runtime_admission_partial");
  const locations = new Map(f.locations.map(v => [v.id, v.state]));
  if (Object.hasOwn(request, "model") && typeof request.model !== "string"
    || ["store", "stream", "parallel_tool_calls"].some(k => Object.hasOwn(request, k) && typeof request[k] !== "boolean"))
    issues.add("malformed_runtime_envelope");
  // Base-profile allowlisting is not proof that opaque request subtrees are
  // schema/context-free. Require reviewed fingerprints for these too.
  const metadataPolicy = f.runtimeMetadataPolicyId === null ? null : resolveCodexRuntimeMetadataPolicy(f.runtimeMetadataPolicyId);
  if (metadataPolicy) {
    const validation = validateCodexRuntimeMetadata({policy:metadataPolicy, request,
      runtimeIdentity:{runtimeFamily:f.runtimeFamily, runtimeVersion:f.runtimeVersion,
        providerProtocol:f.providerProtocol, requestScope:f.requestScope}});
    runtimeMetadataBindings = validation.observations;
    runtimeMetadataFailures = validation.failures;
    for (const issue of validation.issues) issues.add(issue);
  }
  for (const key of ["access_programs", "client_metadata", "text", "reasoning", "tool_choice", "stream_options",
    "include", "service_tier", "prompt_cache_key"])
    if (Object.hasOwn(request, key) && !metadataPolicy?.allowedDynamicFields.some(field => field.path === key)
      && !f.contextHashes.includes(sha256({[key]:request[key]})))
      issues.add("unreviewed_request_context");
  for (const location of fixture.inspectedLocations)
    if (locations.get(location) !== "VERIFIED") issues.add("unadmitted_request_location");
  // Known text-only message objects require exact preflight-reviewed fingerprints.
  // Never discard unknown/malformed input merely because contributor flags are set.
  const messageOK = item => object(item) && item.type === "message"
    && Object.keys(item).every(k => ["type", "role", "content"].includes(k))
    && ["system", "developer", "user"].includes(item.role) && Array.isArray(item.content)
    && item.content.every(c => object(c) && Object.keys(c).every(k => ["type", "text"].includes(k))
      && c.type === "input_text" && typeof c.text === "string")
    && f.contextHashes.includes(sha256(item));
  if (Array.isArray(request.input)) {
    const other = request.input.filter(item => !["additional_tools", "tool_search_output"].includes(item?.type));
    if (other.length && locations.get("input.messages") === "VERIFIED" && other.every(messageOK))
      issues.delete("uninterpreted_input_item");
  }
  if (Object.hasOwn(request, "instructions") && (locations.get("instructions") !== "VERIFIED"
    || typeof request.instructions !== "string" || !f.contextHashes.includes(sha256(request.instructions))))
    issues.add("unreviewed_instruction_context");
  // A reviewed complete inventory binds definitions/descriptions, not just names.
  for (const tool of fixture.tools) {
    const expected = f.expectedTools.find(t => t.nativeId === tool.nativeId);
    if (!expected || tool.representations.some(r => r.definitionHash !== expected.definitionHash
      || r.namespaceDescriptionHash !== expected.namespaceDescriptionHash)) issues.add("unexpected_tool_definition");
  }
  if (f.expectedTools.some(t => t.requiredInCapture && !fixture.tools.some(found => found.nativeId === t.nativeId)))
    issues.add("missing_expected_tool");
  const {id:discarded, ...base} = fixture;
  const body = {...base, version:"captured.model.request.v2", mode:"OFFLINE_RUNTIME_EVIDENCE",
    evidenceClass:"model_context", runtimeCaptureAuthorized:false,
    admissionId:admission.id, admittedProfileId:admission.admittedProfileId,
    runtimeMetadataBindings,
    evidenceRefs:[...admission.evidenceRefs, proof.ref].sort(),
    completeness:fixture.completeness === "UNKNOWN" ? "UNKNOWN" : issues.size ? "PARTIAL" : "COMPLETE",
    issues:[...issues].sort()};
  const observation = freeze({id:`capture_${sha256(body)}`, ...body});
  const topLevelKeys = Object.keys(request).sort(), unknownTopLevelKeys = topLevelKeys.filter(key => !runtimeEnvelopeFields.includes(key));
  const toolContainerPresent = Object.hasOwn(request, "tools"), toolInventoryEvaluable = toolContainerPresent
    && Array.isArray(request.tools) && ![...issues].some(issue => toolShapeIssues.has(issue));
  const requiredFieldPresence = ["model", "input", "tools", "stream", "prompt_cache_key", "client_metadata"]
    .map(key => `${key}:${Object.hasOwn(request, key) ? 1 : 0}`).join("|");
  const shape = Object.fromEntries(topLevelKeys.map(key => [key, Array.isArray(request[key]) ? "array" : request[key] === null ? "null" : typeof request[key]]));
  runtimeValidationDiagnostics.set(observation, freeze({topLevelKeySetHash:sha256(topLevelKeys),
    requestShapeFingerprint:sha256(shape), unknownTopLevelKeyCount:unknownTopLevelKeys.length,
    requiredFieldPresenceBitmap:requiredFieldPresence, toolContainerPresent, toolInventoryEvaluable,
    observedToolNames:fixture.tools.map(tool => tool.nativeId), modelPresent:Object.hasOwn(request, "model"),
    modelHash:typeof request.model === "string" ? sha256(request.model) : null,
    runtimeMetadataPolicyId:metadataPolicy?.policyId ?? null, runtimeMetadataFailures,
    runtimeMetadataValidationPassed:metadataPolicy !== null && runtimeMetadataFailures.length === 0,
    unknownRuntimeMetadataKeyCount:runtimeMetadataFailures.reduce((sum, failure) => sum + failure.unknownKeyCount, 0)}));
  observations.add(observation); return observation;
}
