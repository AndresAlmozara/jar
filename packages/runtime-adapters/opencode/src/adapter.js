import { createReadOnlyAdapter, catalogBuilder, jsonConfig, object, names, boolean } from "../../src/read-only.js";
import { reconcileConfigObservations } from "../../src/config-layers.js";
import { discoverLocalArtifacts } from "../../src/artifacts.js";

function parse(text, refs, format) {
  let config;
  try { config = jsonConfig(text); }
  catch (error) {
    if (format === "jsonc") throw Object.assign(new Error("JSONC syntax not supported by available parser"), {parserState:"unsupported"});
    throw error;
  }
  const catalog = catalogBuilder("opencode", refs), servers = new Map();
  for (const name of names(config.plugin ?? [])) catalog.add({kind:"plugin", nativeId:JSON.stringify([name]), name});
  for (const [name, value] of Object.entries(object(config.mcp ?? {}))) {
    object(value); servers.set(name, catalog.add({kind:"mcp_server", nativeId:JSON.stringify([name]), name, enabled:boolean(value.enabled)}));
  }
  const permission = config.permission ?? {};
  if (typeof permission === "string" && !["allow", "ask", "deny"].includes(permission)) throw new TypeError("Invalid permission default");
  if (typeof permission !== "string") object(permission);
  for (const [name, rule] of Object.entries(typeof permission === "string" ? {} : permission)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || !["allow", "ask", "deny"].includes(rule)) continue;
    // MCP concatenated names are ambiguous: do not invent a server relationship.
    catalog.add({kind:"tool", nativeId:name, name, permission:{allow:"allowed", ask:"prompt", deny:"denied"}[rule], binding:{tool:name}});
  }
  return catalog.finish(["partial_config_only", "actual_exposure_unknown", "agent_and_pattern_permissions_unresolved",
    "json_only_jsonc_not_parsed", "mcp_tool_hierarchy_unknown"]);
}

export function createOpenCodeAdapter(options = {}) {
  if (![undefined, "json", "jsonc"].includes(options.configFormat)) throw new TypeError("Unsupported config format");
  return createReadOnlyAdapter({family:"opencode", parse:(text, refs) => parse(text, refs, options.configFormat), translate, researchRef:"M9.1:O1-O8,S1-S4",
    combine:reconcileConfigObservations, parser:"json", artifacts:discoverLocalArtifacts,
    documented:{toolDiscovery:"SUPPORTED_WITH_LIMITS", mcpDiscovery:"SUPPORTED_WITH_LIMITS", schemaWithholding:"SUPPORTED_WITH_LIMITS",
      nonInteractiveInvocation:"SUPPORTED_WITH_LIMITS"}}, options);
}

function translate(mapped) {
  return {plan:{effectClass:"UNKNOWN", scope:"session", requiresRestart:null, requiresNewSession:null, reversible:null,
    evidence:[{kind:"official_source", ref:"M9.1:S1-S4:v1.18.31"}], conflicts:["local_runtime_not_verified", "merged_agent_session_rules_required"]},
  native:mapped.map(({id, expose, binding}) => ({capabilityId:id, type:"permission_intent", tool:binding.tool,
    pattern:"*", operation:expose ? "preserve_existing_permission_no_grant" : "consider_whole_tool_deny",
    implementationEvidence:"tagged_source_schema_filter", localVerification:"unverified", execution:"PLAN_ONLY"}))};
}
