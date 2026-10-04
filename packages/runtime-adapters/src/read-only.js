import { readFileSync, statSync } from "node:fs";
import { sha256 } from "../../core/src/hash.js";
import { capabilityDescriptor, freeze } from "../../capability-exposure/src/contracts.js";
import { runtimeIdentity, runtimeSupport, runtimeObservation, exposureRequest, runtimeExposurePlan,
  runtimeEffectResult, assertRuntimeAdapter } from "./contracts.js";

export function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected native object");
  return value;
}
export function jsonConfig(text) { return object(JSON.parse(text)); }
export function names(value) {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim()) || new Set(value).size !== value.length)
    throw new TypeError("Expected native name list");
  return value;
}
export function boolean(value) {
  if (value === undefined) return null;
  if (typeof value !== "boolean") throw new TypeError("Expected native boolean");
  return value;
}

/** Catalog builder keeps transport/credentials/config syntax out of public data. */
export function catalogBuilder(family, refs) {
  const observations = [], bindings = new Map();
  return {
    add({kind, nativeId, name, parentIds = [], enabled = null, permission = "unknown", binding = null, configured = true}) {
      const capability = capabilityDescriptor({kind, name, description:`${configured === true ? "Configured" : "Discovered"} ${kind}; availability unverified`,
        source:{namespace:`runtime:${family}`, nativeId}, risk:"unknown"});
      observations.push({capability, configured, configuredEnabled:enabled, configuredPermission:permission, parentIds, evidence:refs});
      if (binding) bindings.set(capability.id, freeze(structuredClone(binding)));
      return capability.id;
    },
    finish(issues = []) { return {observations, bindings, issues}; },
  };
}

/** File reads only, opt-in explicit paths. Never imports a plugin or starts a server.
 * A supplied version is a captured observation, not a fresh executable probe.
 * Config parsing deliberately covers only adapter-documented subsets.
 */
export function createReadOnlyAdapter(profile, options = {}) {
  if (options.configSources !== undefined && (!profile.combine || options.configText !== undefined || options.configPath !== undefined
    || options.configScope !== undefined)) throw new TypeError("Unsupported or ambiguous config sources");
  const inputs = options.configSources ?? [{text:options.configText, path:options.configPath, scope:options.configScope ?? "explicit"}];
  if (!Array.isArray(inputs) || inputs.length > 16) throw new TypeError("Invalid config source list");
  const sourceKeys = new Set();
  for (const input of inputs) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).some(key => !["text", "path", "scope", "id"].includes(key))
      || input.text !== undefined && input.path !== undefined
      || input.path !== undefined && (typeof input.path !== "string" || !input.path.trim())
      || input.id !== undefined && (typeof input.id !== "string" || !input.id.trim())
      || !["user", "project", "local", "managed", "session", "installation", "explicit", "unknown"].includes(input.scope ?? "explicit"))
      throw new TypeError("Invalid config source");
    const key = JSON.stringify([input.scope ?? "explicit", input.path ?? input.id ?? "supplied-text"]);
    if (sourceKeys.has(key)) throw new TypeError("Duplicate config source");
    sourceKeys.add(key);
  }
  const io = options.io ?? {readFileSync, statSync};
  const installation = options.installation ?? {};
  let installed = options.fixture === true && installation.fixtureInstalled === true, inspectionFailed = false;
  if (installation.executablePath) {
    try { installed = io.statSync(installation.executablePath).isFile(); }
    catch (error) { installed = false; inspectionFailed = !["ENOENT", "ENOTDIR"].includes(error?.code); }
  }
  const identity = runtimeIdentity({family:profile.family, installationId:installation.id
    ?? sha256(installation.executablePath ?? `${profile.family}:unspecified`), surface:"read-only-config",
    runtimeVersion:installed || inspectionFailed ? installation.version ?? null : null, adapterVersion:"m10.v1", evidence:installation.evidence ?? []});
  const facts = Object.fromEntries(Object.entries(profile.documented ?? {}).map(([key, state]) => [key,
    {state, basis:"documented", evidence:[{kind:"official_documentation", ref:profile.researchRef}]}]));
  const support = runtimeSupport({runtimeId:identity.id, facts});
  let status = inspectionFailed ? "runtime_inspection_failed" : !installed ? "runtime_unavailable" : installation.startupFailed ? "runtime_startup_failed" : "ok";
  const captures = [], configSources = [], allRefs = [];
  for (const input of inputs) {
  let capture = {observations:[], bindings:new Map(), issues:[]}, configAvailable = false, configOutcome = "not_attempted";
  let readingConfig = false, parserState = "not_attempted";
  const sourceId = `source_${sha256({runtimeId:identity.id, scope:input.scope ?? "explicit", input:input.path ?? input.id ?? "supplied-text"})}`;
  const refs = [{kind:options.fixture === true ? "fixture" : "local_config", ref:sourceId}];
  try {
    let source = input.text;
    if (source === undefined && input.path) {
      readingConfig = true;
      if (io.statSync(input.path).size > 1024 * 1024) throw Object.assign(new TypeError("Config exceeds read bound"), {code:"EFBIG"});
      source = io.readFileSync(input.path, "utf8");
      readingConfig = false;
    }
    if (source !== undefined) {
      if (typeof source !== "string" || source.length > 1024 * 1024) throw new TypeError("Invalid config input");
      parserState = "unknown";
      capture = profile.parse(source, refs);
      runtimeObservation({identity, status, scope:"configured-catalog", completeness:"partial", observations:capture.observations, evidence:refs});
      configAvailable = true; configOutcome = "success"; parserState = capture.parserState ?? "parsed";
    } else if (status === "ok") status = "config_not_inspected";
  } catch (error) {
    const parserFailure = ["malformed", "unsupported", "unavailable"].includes(error?.parserState) ? error.parserState : null;
    const configStatus = parserFailure === "unsupported" ? "config_unsupported"
      : parserFailure === "unavailable" ? "config_parser_unavailable"
      : parserFailure === "malformed" ? "config_malformed" : ["ENOENT", "ENOTDIR"].includes(error?.code) ? "config_missing"
      : error?.code ? "config_unreadable" : "config_malformed";
    parserState = parserFailure ?? (readingConfig || error?.code ? "not_attempted" : "malformed");
    configOutcome = configStatus === "config_missing" ? "missing" : parserFailure === "unavailable" || readingConfig || error?.code ? "failed" : "unparsed";
    capture = {observations:[], bindings:new Map(), issues:[configStatus === "config_malformed" ? "config_malformed_or_unsupported" : configStatus]};
    if (status === "ok") status = configStatus;
  }
  configSources.push({sourceId, kind:"config", scope:input.scope ?? "explicit", outcome:configOutcome, parserState,
    parser:parserState === "not_attempted" ? "unknown" : profile.parser ?? "unknown", issues:capture.issues,
    completeness:configAvailable ? "partial" : "unknown", evidence:configOutcome === "not_attempted" ? [] : refs});
  captures.push(capture);
  if (configAvailable) allRefs.push(...refs);
  }
  const configAvailable = configSources.some(source => source.outcome === "success");
  const capture = profile.combine ? profile.combine(captures, configSources) : captures[0];
  const artifacts = profile.artifacts ? profile.artifacts(options, identity) : {sources:[], observations:[], issues:[]};
  if (!inputs.length && status === "ok") status = "config_not_inspected";
  if (installation.startupFailed) capture.issues.push("runtime_startup_failed");
  if (inspectionFailed) capture.issues.push("installation_inspection_failed");
  const installationAttempted = Boolean(installation.executablePath) || options.fixture === true && installation.fixtureInstalled === true;
  const sources = [{sourceId:`installation:${identity.id}`, kind:"installation", scope:"installation",
    outcome:!installationAttempted ? "not_attempted" : inspectionFailed ? "failed" : installed ? "success" : "missing",
    completeness:installed ? "partial" : "unknown", evidence:installationAttempted
      ? [{kind:options.fixture === true ? "fixture" : "local_filesystem", ref:`installation:${identity.id}`}]:[]},
  ...configSources, ...artifacts.sources,
  ...["user", "project", "local", "managed"].filter(scope => !configSources.some(source => source.scope === scope)).map(scope => ({
    sourceId:`config-layer:${scope}`, kind:"config", scope, outcome:"not_attempted"})),
  ...["plugin_manifests", "mcp_catalog", "skill_catalog", "builtins", "runtime_cli", "runtime_process"].map(kind => ({
    sourceId:`uninspected:${kind}`, kind, scope:"unknown", outcome:"not_attempted"}))];
  const snapshot = runtimeObservation({identity, status, scope:"configured-catalog", completeness:configAvailable || artifacts.observations.length
    || artifacts.sources.some(source => source.outcome === "success") ? "partial" : "unknown",
    observations:[...capture.observations, ...artifacts.observations], evidence:[...allRefs, ...artifacts.sources.flatMap(source => source.evidence)],
    sources, issues:[...capture.issues, ...artifacts.issues], layerState:capture.layerState});
  // Explicit equivalence exists only in fixtures, never inferred from tool names.
  const equivalences = new Map();
  for (const mapping of options.fixtureEquivalences ?? []) {
    if (options.fixture !== true || !mapping || Object.keys(mapping).some(k => !["capabilityId", "observedId"].includes(k))
      || typeof mapping.capabilityId !== "string" || !mapping.capabilityId.trim() || equivalences.has(mapping.capabilityId)
      || [...equivalences.values()].includes(mapping.observedId)
      || !capture.bindings.has(mapping.observedId)) throw new TypeError("Invalid fixture equivalence");
    equivalences.set(mapping.capabilityId, mapping.observedId);
  }
  const plans = new Map();
  const disabled = plan => {
    if (plans.get(plan?.id)?.plan !== plan) throw new TypeError("Plan not owned by this adapter");
    return runtimeEffectResult({plan});
  };
  return assertRuntimeAdapter(Object.freeze({
    async identify() { return identity; },
    async capabilities() { return support; },
    async snapshot() { return snapshot; },
    async inspectExposure() { return snapshot.actualExposure; },
    async planExposure(value) {
      const request = exposureRequest(value);
      const sameRuntime = value.input.inventory.runtime.id === identity.id;
      const mapped = [], unsupportedIds = [], conflicts = [];
      if (status !== "ok") conflicts.push(status);
      if (["unresolved", "partial"].includes(snapshot.layerState)) conflicts.push("config_layers_unresolved");
      if (!sameRuntime && !equivalences.size) conflicts.push("inventory_runtime_mismatch");
      for (const id of [...(request.exposedIds ?? []), ...(request.withheldIds ?? [])]) {
        const capability = value.input.inventory.entries?.find(e => e.capability.id === id)?.capability;
        if (!["tool", "mcp_tool", "plugin_tool", "cli"].includes(capability?.kind)) { unsupportedIds.push(id); continue; }
        const observedId = equivalences.get(id) ?? (sameRuntime ? id : null);
        const binding = capture.bindings.get(observedId);
        if (!binding) continue;
        const observed = snapshot.observations.find(o => o.capability.id === observedId);
        const expose = request.exposedIds.includes(id);
        if (expose && (observed.configuredPermission === "denied" || observed.configuredEnabled === false))
          conflicts.push(`configured_restriction:${id}`);
        mapped.push({id, expose, binding});
      }
      const translation = profile.translate ? profile.translate(mapped) : {plan:{}, native:[]};
      const plan = runtimeExposurePlan({...translation.plan, runtimeId:identity.id, request, translationHash:sha256(translation.native),
        discoveryId:snapshot.id, exposureObservationId:snapshot.actualExposure.id,
        supportedIds:mapped.map(m => m.id), unsupportedIds,
        conflicts:[...new Set([...conflicts, ...(translation.plan.conflicts ?? []), "actual_exposure_unverified", "restoration_unverified"])]});
      if (!plans.has(plan.id)) plans.set(plan.id, {plan, native:freeze(structuredClone(translation.native))});
      return plans.get(plan.id).plan;
    },
    // Adapter-local diagnostic, deliberately absent from generic RuntimeAdapter.
    // Returned instructions are conceptual, never executable config patches.
    describeNativePlan(plan) {
      const stored = plans.get(plan?.id);
      if (stored?.plan !== plan) throw new TypeError("Plan not owned by this adapter");
      return stored.native;
    },
    async applyExposure(plan) { return disabled(plan); },
    async restoreExposure(plan) { return disabled(plan); },
  }));
}
