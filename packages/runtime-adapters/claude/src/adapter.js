import { createReadOnlyAdapter, catalogBuilder, jsonConfig, object, names, boolean } from "../../src/read-only.js";
import { reconcileConfigObservations } from "../../src/config-layers.js";
import { discoverLocalArtifacts } from "../../src/artifacts.js";

function parse(text, refs) {
  const config = jsonConfig(text), catalog = catalogBuilder("claude", refs);
  for (const [name, enabled] of Object.entries(object(config.enabledPlugins ?? {})))
    catalog.add({kind:"plugin", nativeId:JSON.stringify([name]), name, enabled:boolean(enabled)});
  const servers = new Map();
  for (const [name, server] of Object.entries(object(config.mcpServers ?? {}))) {
    object(server);
    servers.set(name, catalog.add({kind:"mcp_server", nativeId:JSON.stringify([name]), name}));
  }
  const permissions = object(config.permissions ?? {}), tools = new Map();
  for (const [key, permission] of [["allow", "allowed"], ["ask", "prompt"], ["deny", "denied"]]) {
    for (const rule of names(permissions[key] ?? [])) {
      // Only exact whole-tool rules establish whole-tool permission facts.
      // Argument patterns and wildcard rules are deliberately not expanded.
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(rule) || rule === "mcp__") continue;
      if (rule.startsWith("mcp__")) {
        const match = /^mcp__([^_]+)__([A-Za-z0-9_-]+)$/.exec(rule);
        if (!match) continue;
        const [, server, tool] = match;
        if (!servers.has(server)) servers.set(server, catalog.add({kind:"mcp_server", nativeId:JSON.stringify([server]), name:server}));
        tools.set(rule, {kind:"mcp_tool", nativeId:rule, name:tool, parentIds:[servers.get(server)], permission,
          binding:{tool:rule, server}});
      } else tools.set(rule, {kind:"tool", nativeId:rule, name:rule, permission, binding:{tool:rule}});
    }
  }
  for (const tool of tools.values()) catalog.add(tool);
  return catalog.finish(["partial_config_only", "actual_exposure_unknown", "scoped_and_wildcard_permissions_unresolved", "cache_semantics_unverified"]);
}

export function createClaudeAdapter(options) {
  return createReadOnlyAdapter({family:"claude", parse, translate, researchRef:"M9.1:A1-A9",
    combine:reconcileConfigObservations, parser:"json", artifacts:discoverLocalArtifacts,
    documented:{mcpDiscovery:"SUPPORTED_WITH_LIMITS", pluginDiscovery:"SUPPORTED_WITH_LIMITS", schemaWithholding:"SUPPORTED_WITH_LIMITS",
      nonInteractiveInvocation:"SUPPORTED_WITH_LIMITS"}}, options);
}

function translate(mapped) {
  return {plan:{effectClass:"EXECUTION_DENY_ONLY", scope:"session", requiresRestart:null, requiresNewSession:null,
    reversible:null, evidence:[{kind:"official_documentation", ref:"M9.1:A1,A4"}],
    conflicts:["tool_search_cache_may_retain_schemas", "installed_reload_behavior_unverified"]},
  native:mapped.map(({id, expose, binding}) => ({capabilityId:id, type:"permission_intent", rule:binding.tool,
    operation:expose ? "preserve_existing_permission_no_grant" : "consider_bare_deny", execution:"PLAN_ONLY"}))};
}
