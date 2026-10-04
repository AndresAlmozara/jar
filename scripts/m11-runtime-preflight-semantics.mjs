import { createHash } from "node:crypto";

export const SOURCE_COMMIT = "0d9c7cbfa6cf1489f55a8a9542b75ddd2c061807";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stable = value => object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : Array.isArray(value) ? value.map(stable) : value;
export const digest = value => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export function runtimePreflightManifest(files) {
  return {
    schemaVersion:"m11.runtime-preflight-package.v1",
    status:"READY_FOR_ONE_FRESH_SANDBOX_DYNAMIC_PREFLIGHT",
    expectedCodexVersion:"0.158.0-alpha.2.1",
    sourceCommit:SOURCE_COMMIT,
    protocolMethods:["initialize","config/read","model/list","skills/list","mcpServerStatus/list","thread/start"],
    forbiddenMethods:["turn/start","review/start","thread/compact/start","thread/shellCommand"],
    stopBarrier:"successful baseline and filtered thread/start responses, observer acknowledgement, stdin EOF",
    modelRequestAuthorized:false,
    runtimeCaptureAuthorized:false,
    files,
  };
}
export function subsetMismatches(expected, actual, path = "config") {
  if (Array.isArray(expected)) return digest(expected) === digest(actual ?? null) ? [] : [path];
  if (!object(expected)) return expected === actual ? [] : [path];
  if (!object(actual)) return [path];
  if (!Object.keys(expected).length && Object.keys(actual).length) return [path];
  return Object.entries(expected).flatMap(([k,v]) => subsetMismatches(v, actual[k], `${path}.${k}`));
}

// These are API projection omissions, NOT permission to accept changed tool settings.
export function compareConfig(expected, actual, layers, sourceCommit) {
  const expectedLayers = [
    {type:"sessionFlags", file:null, profile:null, configHash:digest({cli_auth_credentials_store:"ephemeral"})},
    {type:"user", file:"C:\\M11\\work\\codex\\config.toml", profile:null, configHash:digest(expected)},
    {type:"system", file:"C:\\ProgramData\\OpenAI\\Codex\\config.toml", profile:null, configHash:digest({})},
  ];
  const exactLayers = Array.isArray(layers) && layers.length === expectedLayers.length && expectedLayers.every((e,i) =>
    layers[i]?.disabled === false && Object.entries(e).every(([k,v]) => layers[i][k] === v));
  const projected = structuredClone(expected);
  const omissions = [];
  for (const key of ["update_plan", "experimental_request_user_input"]) {
    if (sourceCommit === SOURCE_COMMIT && exactLayers && digest(expected.tools?.[key] ?? null) === digest({enabled:false}) &&
        object(actual?.tools) && !Object.hasOwn(actual.tools,key)) {
      delete projected.tools[key];
      omissions.push(`config.tools.${key}`);
    }
  }
  // ToolsV2 has exactly one optional field. Its null representation is not a new tool.
  if (omissions.length === 2 && Object.keys(projected.tools).length === 0) projected.tools = {web_search:null};
  const mismatchPaths = subsetMismatches(projected, actual);
  if (!exactLayers) mismatchPaths.push("config.layers.exactFrozenLayers");
  return {mismatchPaths, omissions, exactLayers, expectedProjectionHash:digest(projected), actualConfigHash:digest(actual ?? null)};
}
