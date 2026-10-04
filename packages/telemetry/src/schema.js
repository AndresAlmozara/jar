import { createHmac, randomUUID } from "node:crypto";
import { TELEMETRY_EVENT_SCHEMA } from "./config.js";

export const EVENT_NAMES=Object.freeze(["session.observed","hook.finished","routing.observed","tool.started","tool.finished","usage.observed","feedback.recorded","telemetry.health"]);
const SEVERITIES=new Set(["debug","info","warn","error"]);
const CORRELATIONS=new Set(["exact","partial","unlinked"]);
const ORIGINS=new Set(["production","validation","benchmark","historical_import"]);
const SAFE_KEYS=new Set([
  "kind","phase","outcome","reason","code","hook_kind","duration_ms","telemetry_overhead_ms","native_duration_ms","source_duration_ms","route_index","prompt_bytes","prompt_characters","prompt_fingerprint","explicit_skill_ids","model","permission_mode",
  "git_commit","git_dirty","git_status_hash","repository_observation_id","discovered_count","listed_count","read_count","candidate_count","matched_count","discovery_truncated","retrieval_truncated","limits","candidate_limit","max_file_bytes","max_total_bytes","excerpt_chars","output_limit",
  "m5","m6","m7","m8","state","fidelity","strategy","catalog_id","proposal_status","selected_ids","shortlist_ids","materialized_ids","final_output_ids","selected_count","materialized_count","full_count","partial_count","absent_count","host_exposure","model_use","mode","profile_id","inventory_complete","exact_pass_through","input_bytes","output_bytes","input_hash","output_hash","request_count","provider","requested_model","returned_model","failure_code","retry_count",
  "candidates","candidate_id","rank","score","file_id","source_hash","source_hash_algorithm","file_role","excerpt_fingerprint","excerpt_bytes","selection_reason","selection_order","freshness","delivery","pre_bound_bytes","post_bound_bytes","retained_bytes","segment_id","status","truncated","observation_truncated","known_loss_count","known_loss_reasons","duplicate_count","maintenance_lag_ms","spool_files","spool_bytes","archive_bytes","capacity_state","parser_support","coverage","integration","supported","missing_reason",
  "tool_name","tool_category","tool_key","argument_fingerprint","response_fingerprint","exit_code","logical_operation_id","transport_id","blocked","failed","unfinished","polling","file_target_ids","extraction_method","extraction_coverage","test_result","test_scope",
  "input_total","input_cached","input_uncached","output_total","reasoning_output","scope","counter_kind","usage_source","completeness","native_request_key","native_counter_key","deduplicated","discontinuity",
  "label","study_id","report_day","event_count","session_count","turn_count","tool_count","correlated_count","unlinked_count","partial_count","finished_count","usage_covered_count","usage_total_count","unsupported_integrations","drop_count","overhead_p50_ms","overhead_p95_ms","routing_p50_ms","routing_p95_ms","repeated_delivery_count","freshness_failure_count","selected_later_read_count","unselected_later_read_count","created_at","updated_at","as_of","schema_version","metric_definition_version","input_event_ids","source_event_ids"
]);
const FORBIDDEN_KEY=/^(prompt|text|body|argument|arguments|tool_input|tool_output|response|exception|message|command|repository_root|file_path|transcript_path|source_text|skill_text|secret|token|password|credential)$/i;

function boundedString(value) { return String(value).replace(/[\r\n\u2028\u2029]/g," ").slice(0,512); }

function safeValue(value, depth=0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return boundedString(value);
  if (depth >= 5) return null;
  if (Array.isArray(value)) return value.slice(0,100).map(item=>safeValue(item,depth+1));
  if (typeof value !== "object") return null;
  const output={};
  for (const key of Object.keys(value).sort()) {
    if (!SAFE_KEYS.has(key) || FORBIDDEN_KEY.test(key)) continue;
    output[key]=safeValue(value[key],depth+1);
  }
  return output;
}

export function fingerprint(key, namespace, value) {
  if (!Buffer.isBuffer(key) || key.length < 16) throw Object.assign(new Error("telemetry HMAC key unavailable"), {code:"JAR_TELEMETRY_KEY_UNAVAILABLE"});
  return createHmac("sha256",key).update(`${namespace}\0${String(value ?? "")}`).digest("hex");
}

export function sanitizePayload(payload={}) { return safeValue(payload); }

export function createEnvelope(input,{key}={}) {
  if (!EVENT_NAMES.includes(input.event_name)) throw Object.assign(new Error("unsupported telemetry event"), {code:"JAR_TELEMETRY_EVENT_UNSUPPORTED"});
  const severity=SEVERITIES.has(input.severity)?input.severity:"info",correlation=CORRELATIONS.has(input.correlation_status)?input.correlation_status:"unlinked",origin=ORIGINS.has(input.data_origin)?input.data_origin:"production";
  const ids=input.identifiers||{},id=(name,value)=>value==null?null:`hmac-sha256:${fingerprint(key,name,value)}`;
  return {
    schema_version:TELEMETRY_EVENT_SCHEMA,
    event_id:input.event_id || randomUUID(),
    event_name:input.event_name,
    severity,
    occurred_at_utc:input.occurred_at_utc || null,
    observed_at_utc:input.observed_at_utc || new Date().toISOString(),
    installation_id:input.installation_id,
    runtime_id:input.runtime_id || null,
    jar_source_commit:input.jar_source_commit || null,
    config_hash:input.config_hash,
    adapter_id:input.adapter_id,
    adapter_version:input.adapter_version || "1",
    host_runtime_version:input.host_runtime_version || null,
    study_id:input.study_id || null,
    data_origin:origin,
    session_id:id("session",ids.session),
    native_thread_id:id("native-thread",ids.nativeThread),
    actor_id:id("actor",ids.actor),
    turn_id:id("turn",ids.turn),
    route_id:id("route",ids.route),
    tool_invocation_id:id("tool-invocation",ids.toolInvocation),
    repository_id:id("repository",ids.repository),
    correlation_status:correlation,
    correlation_missing_reason:input.correlation_missing_reason || null,
    source_kind:input.source_kind || "jar-runtime",
    parser_version:input.parser_version || null,
    coverage:safeValue(input.coverage||{}),
    truncation:safeValue(input.truncation||{}),
    payload:sanitizePayload(input.payload||{}),
  };
}

export function validateEnvelope(value) {
  if (!value || value.schema_version!==TELEMETRY_EVENT_SCHEMA || !EVENT_NAMES.includes(value.event_name) || typeof value.event_id!=="string") return {ok:false,reason:"schema_invalid"};
  if (!value.installation_id || !value.config_hash || !value.adapter_id || !value.observed_at_utc) return {ok:false,reason:"required_identity_missing"};
  return {ok:true,reason:"valid"};
}
