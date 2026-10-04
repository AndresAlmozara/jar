import { readFileSync, statSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../../core/src/hash.js";
import { catalogBuilder } from "./read-only.js";

const nativeName = value => typeof value === "string" && /^[A-Za-z0-9_.:@/-]{1,240}$/.test(value) ? value : null;
const failure = state => Object.assign(new Error("Artifact inspection failed"), {artifactState:state});
const inside = (root, target) => { const relative = path.relative(root, target); return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };

/** Explicit roots only. Never imports artifact code, reads hooks, or starts MCP.
 * Filesystem presence is deliberately not represented as configured=true.
 */
export function discoverLocalArtifacts(options, identity) {
  if (identity.family !== "codex" && options.pluginRoots?.length) throw new TypeError("Plugin format discovery not supported for this runtime");
  if (![options.pluginRoots ?? [], options.skillRoots ?? []].every(Array.isArray)) throw new TypeError("Invalid artifact roots");
  const io = options.artifactIO ?? {readFileSync, statSync, lstatSync, realpathSync, readdirSync};
  const roots = [...(options.pluginRoots ?? []).map(root => ({...root, type:"plugin_roots"})),
    ...(options.skillRoots ?? []).map(root => ({...root, type:"skill_roots"}))];
  if (roots.length > 16) throw new TypeError("Too many artifact roots");
  const keys = new Set();
  for (const root of roots) {
    if (!root || !path.isAbsolute(root.path ?? "") || Object.keys(root).some(key => !["path", "scope", "type"].includes(key))
      || !["user", "project", "local", "managed", "explicit", "installation"].includes(root.scope ?? "explicit")) throw new TypeError("Invalid artifact root");
    root.path = path.resolve(root.path);
    const key = JSON.stringify([root.path, root.type, root.scope ?? "explicit"]);
    if (keys.has(key)) throw new TypeError("Duplicate artifact root");
    keys.add(key);
  }
  const sources = new Map(), observations = new Map();
  let remaining = 512;
  const record = (root, target, kind, parser = "unknown") => {
    const sourceId = `artifact_${sha256({runtimeId:identity.id, path:target, kind, scope:root.scope ?? "explicit"})}`;
    if (sources.has(sourceId)) return sources.get(sourceId);
    const source = {sourceId, kind, scope:root.scope ?? "explicit", outcome:"not_attempted", parser,
      parserState:"not_attempted", completeness:"unknown", evidence:[], issues:[]};
    sources.set(sourceId, source); return source;
  };
  const inspect = (root, target, kind, parser, operation) => {
    const source = record(root, target, kind, parser);
    source.evidence = [{kind:"local_filesystem", ref:source.sourceId}];
    let present = false;
    try {
      if (--remaining < 0) throw failure("bounded");
      if (!inside(root.path, target)) throw failure("unsafe_path");
      const stat = io.lstatSync(target);
      if (stat.isSymbolicLink()) throw failure("unsafe_path");
      if (!inside(io.realpathSync(root.path), io.realpathSync(target))) throw failure("unsafe_path");
      present = true;
      const result = operation(stat);
      source.outcome = "success"; source.completeness = "partial";
      source.parserState = parser === "unknown" ? "unknown" : parser === "skill_metadata_bounded" ? "bounded" : "parsed";
      return {source, present, result};
    } catch (error) {
      const missing = ["ENOENT", "ENOTDIR"].includes(error?.code);
      const malformed = error instanceof SyntaxError || error?.artifactState === "malformed";
      const unsupported = error?.artifactState === "unsupported";
      source.outcome = missing ? "missing" : malformed || unsupported ? "unparsed" : "failed";
      source.parserState = malformed ? "malformed" : unsupported ? "unsupported" : "not_attempted";
      source.issues = [missing ? "artifact_missing" : malformed ? "artifact_malformed" : unsupported ? "artifact_unsupported" : "artifact_unreadable_or_outside_bound"];
      return {source, present, result:null};
    }
  };
  const read = (target, stat) => {
    if (!stat.isFile() || stat.size > 1024 * 1024) throw failure("bounded");
    const value = io.readFileSync(target, "utf8");
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024 * 1024) throw failure("bounded");
    return value;
  };
  const json = (root, target, kind) => inspect(root, target, kind, "json", stat => {
    const value = JSON.parse(read(target, stat));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("malformed");
    return value;
  });
  const add = (kind, source, name, parents = []) => {
    const catalog = catalogBuilder(identity.family, source.evidence);
    const id = catalog.add({kind, nativeId:source.sourceId, name, parentIds:parents, configured:null});
    const item = catalog.finish().observations[0], old = observations.get(id);
    if (old) item.parentIds = [...new Set([...old.parentIds, ...parents])];
    observations.set(id, item); return id;
  };
  const skills = (root, target, parents = []) => {
    const listing = inspect(root, target, "skill_roots", "unknown", stat => {
      if (!stat.isDirectory()) throw failure("unsupported");
      return io.readdirSync(target, {withFileTypes:true}).sort((a, b) => a.name.localeCompare(b.name));
    });
    if (!listing.result) return;
    if (listing.result.length > 128) listing.source.issues.push("artifact_entry_limit");
    for (const entry of listing.result.slice(0, 128)) {
      if (entry.isSymbolicLink()) { listing.source.issues.push("artifact_symlink_skipped"); continue; }
      if (!entry.isDirectory()) continue;
      const file = path.join(target, entry.name, "SKILL.md");
      const skill = inspect(root, file, "skill_catalog", "skill_metadata_bounded", stat => {
        const text = read(file, stat), header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!header) throw failure("unsupported");
        const names = header[1].split(/\r?\n/).filter(line => /^name\s*:/.test(line));
        if (names.length !== 1) throw failure("unsupported");
        const value = /^name:\s*([A-Za-z0-9_.-]+)\s*$/.exec(names[0])?.[1];
        if (!value) throw failure("unsupported");
        return value;
      });
      if (skill.present) add("skill", skill.source, skill.result ?? `skill_${sha256(file).slice(0, 12)}`, parents);
      skill.source.issues.push("skill_metadata_only_session_unknown");
    }
  };
  const declaredPath = (root, value, source) => {
    if (typeof value !== "string" || !value.startsWith("./") || value.includes("\\") || value.split("/").includes("..")
      || !inside(root.path, path.resolve(root.path, value))) {
      source.issues.push("artifact_reference_unsupported"); return null;
    }
    return path.resolve(root.path, value);
  };
  for (const root of roots) {
    const rootCheck = inspect(root, root.path, root.type, "unknown", stat => {
      if (!stat.isDirectory()) throw failure("unsupported"); return true;
    });
    if (!rootCheck.result) continue;
    if (root.type === "skill_roots") { skills(root, root.path); continue; }
    let manifest = json(root, path.join(root.path, "plugin.json"), "plugin_manifests"), portable = true;
    if (manifest.source.outcome === "missing") {
      portable = false;
      manifest = json(root, path.join(root.path, ".codex-plugin", "plugin.json"), "plugin_manifests");
    }
    if (!manifest.present) continue;
    const name = nativeName(manifest.result?.name) ?? `plugin_${sha256(root.path).slice(0, 12)}`;
    const pluginId = add("plugin", manifest.source, name);
    if (!manifest.result) continue;
    if (portable && manifest.result.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
      manifest.source.issues.push("portable_manifest_version_unknown"); continue;
    }
    const skillRef = portable ? "./skills/" : manifest.result.skills;
    if (skillRef !== undefined) { const target = declaredPath(root, skillRef, manifest.source); if (target) skills(root, target, [pluginId]); }
    const mcpRef = portable ? "./mcp.json" : manifest.result.mcpServers;
    if (mcpRef === undefined) continue;
    const target = declaredPath(root, mcpRef, manifest.source); if (!target) continue;
    const mcp = json(root, target, "mcp_catalog");
    if (!mcp.result) continue;
    const entries = mcp.result.mcpServers;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) { mcp.source.issues.push("mcp_declarations_unsupported"); continue; }
    if (Object.keys(entries).length > 128) mcp.source.issues.push("artifact_entry_limit");
    for (const [server, value] of Object.entries(entries).slice(0, 128)) {
      if (!nativeName(server) || !value || typeof value !== "object" || Array.isArray(value)) { mcp.source.issues.push("mcp_declaration_unsupported"); continue; }
      const serverSource = {...mcp.source, sourceId:`${mcp.source.sourceId}:${sha256(server)}`};
      add("mcp_server", serverSource, server, [pluginId]);
    }
    mcp.source.issues.push("mcp_tool_inventory_unknown");
  }
  return {observations:[...observations.values()], sources:[...sources.values()].map(source => ({...source, issues:[...new Set(source.issues)]})), issues:roots.length
    ? ["artifact_coverage_partial", "artifact_presence_not_session_presence"] : []};
}
