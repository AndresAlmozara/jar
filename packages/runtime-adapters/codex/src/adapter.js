import { createReadOnlyAdapter, catalogBuilder, names, boolean, object } from "../../src/read-only.js";
import { combineCodexLayers } from "./layers.js";
import { discoverLocalArtifacts } from "../../src/artifacts.js";
// Explicit opt-in for the source-pinned isolated dynamic-tool mechanism.
export { createIsolatedCodexEffectAdapter } from "./isolated-effect.js";

const unsupported = () => Object.assign(new TypeError("TOML syntax requires a proper parser"), {parserState:"unsupported"});

// Deliberately bounded TOML subset: only MCP sections and selected literal keys.
// Unsupported syntax in a selected section fails closed, never guesses state.
function sections(text) {
  const result = []; let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    // A header-looking line inside a TOML multiline string is not a section.
    // Reject this unsupported syntax rather than extracting phantom servers.
    if (line.includes('"""') || line.includes("'''")) throw unsupported();
    if (line.startsWith("[")) {
      current = null;
      const header = /^\[((?:mcp_servers|plugins)\..+)\]$/.exec(line);
      if (!header) { if (/^\[(mcp_servers|plugins)\./.test(line)) throw unsupported(); continue; }
      const parts = header[1].match(/"(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+/g);
      if (!parts || parts.join(".") !== header[1]) throw unsupported();
      const keys = parts.map(p => p.startsWith('"') ? JSON.parse(p) : p);
      if (keys[0] === "mcp_servers" && keys.length === 2) current = {server:keys[1], plugin:null};
      else if (keys[0] === "plugins" && keys[2] === "mcp_servers" && keys.length === 4) current = {server:keys[3], plugin:keys[1]};
      if (current) result.push(current);
      continue;
    }
    if (!current) continue;
    const selected = /^(enabled|enabled_tools|disabled_tools)\s*=\s*(.+)$/.exec(line);
    if (!selected) continue;
    if (Object.hasOwn(current, selected[1])) throw new TypeError("Duplicate MCP key");
    if (selected[2].startsWith("[") && !selected[2].endsWith("]")) throw unsupported();
    try { current[selected[1]] = JSON.parse(selected[2]); }
    catch (error) {
      if (selected[2].includes("'") || selected[2].includes("#")) throw unsupported();
      throw error;
    }
  }
  return result;
}

function parsedSections(value) {
  const result = [], root = object(value);
  const servers = (entries, plugin) => {
    for (const [server, config] of Object.entries(object(entries))) {
      const native = object(config);
      result.push({server, plugin, enabled:native.enabled, enabled_tools:native.enabled_tools, disabled_tools:native.disabled_tools});
    }
  };
  if (root.mcp_servers !== undefined) servers(root.mcp_servers, null);
  if (root.plugins !== undefined) for (const [plugin, config] of Object.entries(object(root.plugins))) {
    const native = object(config);
    if (native.mcp_servers !== undefined) servers(native.mcp_servers, plugin);
  }
  return result;
}

function parse(text, refs, tomlParser) {
  const catalog = catalogBuilder("codex", refs), plugins = new Map();
  for (const section of tomlParser ? parsedSections(tomlParser(text)) : sections(text)) {
    let parentIds = [];
    if (section.plugin) {
      if (!plugins.has(section.plugin)) plugins.set(section.plugin, catalog.add({kind:"plugin", nativeId:JSON.stringify([section.plugin]), name:section.plugin}));
      parentIds = [plugins.get(section.plugin)];
    }
    const serverId = catalog.add({kind:"mcp_server", nativeId:JSON.stringify([section.plugin, section.server]), name:section.server,
      enabled:boolean(section.enabled), parentIds});
    const enabled = section.enabled_tools === undefined ? null : names(section.enabled_tools);
    const disabled = section.disabled_tools === undefined ? [] : names(section.disabled_tools);
    for (const name of new Set([...(enabled ?? []), ...disabled])) catalog.add({kind:"mcp_tool",
      nativeId:JSON.stringify([section.plugin, section.server, name]), name, parentIds:[serverId, ...parentIds],
      enabled:section.enabled === false || disabled.includes(name) ? false : enabled?.includes(name) ? true : null,
      binding:{server:section.server, plugin:section.plugin, tool:name}});
  }
  return {...catalog.finish(["partial_config_only", "actual_exposure_unknown", "unlisted_tools_unknown",
    ...(tomlParser ? [] : ["bounded_toml_parser", "unrecognized_toml_not_validated"])]), parserState:tomlParser ? "parsed" : "bounded"};
}

export function createCodexAdapter(options = {}) {
  if (options.tomlParser !== undefined && typeof options.tomlParser !== "function") throw new TypeError("Invalid TOML parser");
  return createReadOnlyAdapter({family:"codex", parse:(text, refs) => parse(text, refs, options.tomlParser), translate, researchRef:"M9.1:C1-C6",
    combine:combineCodexLayers, artifacts:discoverLocalArtifacts, parser:options.tomlParser ? "toml_external" : "toml_bounded",
    documented:{mcpDiscovery:"SUPPORTED_WITH_LIMITS", toolDiscovery:"SUPPORTED_WITH_LIMITS", pluginDiscovery:"SUPPORTED_WITH_LIMITS",
      schemaWithholding:"STATIC_ONLY", nonInteractiveInvocation:"SUPPORTED_WITH_LIMITS"}}, options);
}

function translate(mapped) {
  return {plan:{effectClass:"STATIC_SCHEMA_WITHHOLDING", scope:"process", requiresRestart:null, requiresNewSession:true,
    reversible:null, evidence:[{kind:"official_documentation", ref:"M9.1:C2-C4"}],
    conflicts:["full_catalog_and_merged_filters_required", "dynamic_reload_unverified"]},
  native:mapped.map(({id, expose, binding}) => ({capabilityId:id, type:"mcp_filter_intent", plugin:binding.plugin,
    server:binding.server, tool:binding.tool, field:expose ? "enabled_tools" : "disabled_tools",
    operation:"merge_after_complete_catalog_and_policy_review", execution:"PLAN_ONLY"}))};
}
