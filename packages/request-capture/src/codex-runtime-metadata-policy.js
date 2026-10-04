import { runtimeMetadataBindingPolicy, policyMatchesRuntime, validateRuntimeMetadataBindings }
  from "./runtime-metadata-policy.js";

const SOURCE_COMMIT = "0d9c7cbfa6cf1489f55a8a9542b75ddd2c061807";
const uuid = value => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const bounded = value => typeof value === "string" && value.length > 0 && value.length <= 160
  && /^[\x20-\x7e]+$/.test(value);
const metadataError = (code, unknownKeyCount = 0) => Object.assign(new TypeError("Runtime metadata rejected"),
  {runtimeMetadataCode:code, unknownKeyCount});
const exactKeys = (value, required, optional = []) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw metadataError("OBJECT_SHAPE_INVALID");
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key))) throw metadataError("NESTED_REQUIRED_KEY_MISSING");
  const unknownKeyCount = keys.filter(key => !required.includes(key) && !optional.includes(key)).length;
  if (unknownKeyCount) throw metadataError("UNKNOWN_KEY", unknownKeyCount);
  return keys.sort();
};

export const CODEX_RUNTIME_METADATA_POLICY = runtimeMetadataBindingPolicy({
  policyId:"codex.responses.runtime-metadata.initial.v1",
  policyVersion:"runtime.metadata.binding.v1",
  runtimeFamily:"codex", runtimeVersion:"0.158.0-alpha.2.1",
  providerProtocol:"openai-responses-http", requestScope:"initial-request-static-context",
  sourceCommit:SOURCE_COMMIT,
  allowedDynamicFields:[
    {path:"prompt_cache_key", required:true, validator:"codex.root-session-cache-key.v1",
      semanticClassification:"cache-routing-non-schema", sourcePin:"core/src/client.rs:571-583,972-984"},
    {path:"client_metadata", required:true, validator:"codex.initial-client-metadata.v1",
      semanticClassification:"transport-observability-non-model-context", sourcePin:"core/src/responses_metadata.rs:303-344,375-422"},
  ],
});

const requiredClientKeys = ["x-codex-installation-id", "session_id", "thread_id", "x-codex-window-id",
  "turn_id", "x-codex-turn-metadata"];
const requiredTurnKeys = ["installation_id", "session_id", "thread_id", "turn_id", "window_id",
  "context_window_id", "request_kind", "turn_started_at_unix_ms"];
// This is deliberately narrower than every source-supported variant. Fork,
// parent, subagent, compaction, workspace, MCP, arbitrary extra, and tool
// namespace metadata are outside the fresh-root M11 scope and fail closed.
const optionalTurnKeys = ["agent_name", "window_number", "thread_source", "turn_trigger", "sandbox",
  "sandbox_mode", "auto_review_enabled", "node_repl_auto_review_required", "node_repl_disabled",
  "history_ingest_requested", "analytics_enabled", "root_turn_id"];

function validateClientMetadata(value) {
  exactKeys(value, requiredClientKeys);
  for (const key of requiredClientKeys.filter(key => key !== "x-codex-turn-metadata"))
    if (!bounded(value[key])) throw metadataError("VALUE_SHAPE_INVALID");
  if (typeof value["x-codex-turn-metadata"] !== "string" || value["x-codex-turn-metadata"].length === 0
    || Buffer.byteLength(value["x-codex-turn-metadata"]) > 8192
    || !/^[\x20-\x7e]+$/.test(value["x-codex-turn-metadata"])) throw metadataError("ENCODING_INVALID");
  if (!uuid(value["x-codex-installation-id"]) || !uuid(value.session_id) || !uuid(value.thread_id)
    || !uuid(value["x-codex-window-id"]) || !uuid(value.turn_id)
    || value.session_id !== value.thread_id) throw metadataError("ROOT_IDENTITY_INVALID");
  let turn;
  try { turn = JSON.parse(value["x-codex-turn-metadata"]); } catch { throw metadataError("JSON_INVALID"); }
  const turnKeys = exactKeys(turn, requiredTurnKeys, optionalTurnKeys);
  for (const key of ["installation_id", "session_id", "thread_id", "turn_id", "window_id", "context_window_id"])
    if (!uuid(turn[key])) throw metadataError("TURN_IDENTITY_INVALID");
  if (turn.installation_id !== value["x-codex-installation-id"] || turn.session_id !== value.session_id
    || turn.thread_id !== value.thread_id || turn.turn_id !== value.turn_id
    || turn.window_id !== value["x-codex-window-id"] || turn.request_kind !== "turn")
    throw metadataError("IDENTITY_RELATION_MISMATCH");
  if (!Number.isSafeInteger(turn.turn_started_at_unix_ms) || turn.turn_started_at_unix_ms < 0
    || Object.hasOwn(turn, "window_number") && (!Number.isSafeInteger(turn.window_number) || turn.window_number < 0))
    throw metadataError("ORDINAL_OR_TIME_INVALID");
  for (const key of ["auto_review_enabled", "node_repl_auto_review_required", "node_repl_disabled",
    "history_ingest_requested", "analytics_enabled"])
    if (Object.hasOwn(turn, key) && typeof turn[key] !== "boolean") throw metadataError("FLAG_TYPE_INVALID");
  for (const key of ["agent_name", "thread_source", "turn_trigger", "sandbox", "sandbox_mode"])
    if (Object.hasOwn(turn, key) && !bounded(turn[key])) throw metadataError("LABEL_INVALID");
  if (Object.hasOwn(turn, "root_turn_id") && (turn.root_turn_id !== turn.turn_id || !uuid(turn.root_turn_id)))
    throw metadataError("ROOT_TURN_IDENTITY_INVALID");
  return {type:"object", keys:Object.keys(value).sort(), valueTypes:Object.fromEntries(Object.keys(value).sort().map(k => [k, "string"])),
    turn:{type:"json-string/object", keys:turnKeys, valueTypes:Object.fromEntries(turnKeys.map(k => [k, typeof turn[k]]))},
    identityRelations:["session_id=thread_id", "top=turn", "request_kind=turn"]};
}

function validateField(validator, value, request) {
  if (validator === "codex.root-session-cache-key.v1") {
    if (!uuid(value)) throw metadataError("CACHE_KEY_FORMAT_INVALID");
    if (value !== request.client_metadata?.session_id) throw metadataError("CACHE_KEY_RELATION_MISMATCH");
    return {type:"string", format:"uuid", relation:"client_metadata.session_id"};
  }
  if (validator === "codex.initial-client-metadata.v1") return validateClientMetadata(value);
  throw metadataError("VALIDATOR_UNKNOWN");
}

export function resolveCodexRuntimeMetadataPolicy(policyId) {
  return policyId === CODEX_RUNTIME_METADATA_POLICY.policyId ? CODEX_RUNTIME_METADATA_POLICY : null;
}

export function validateCodexRuntimeMetadata({policy, request, runtimeIdentity}) {
  if (policy !== CODEX_RUNTIME_METADATA_POLICY || !policyMatchesRuntime(policy, runtimeIdentity))
    throw new TypeError("Runtime metadata policy tuple mismatch");
  return validateRuntimeMetadataBindings({policy, request, runtimeIdentity, validateField});
}
