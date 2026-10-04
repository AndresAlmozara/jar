#!/usr/bin/env node
import { createCodexAdapter } from "../packages/runtime-adapters/codex/src/adapter.js";
import { createClaudeAdapter } from "../packages/runtime-adapters/claude/src/adapter.js";
import { createOpenCodeAdapter } from "../packages/runtime-adapters/opencode/src/adapter.js";
import { createPythonTomlParser } from "../packages/runtime-adapters/codex/src/toml-parser.js";

// Standalone opt-in smoke tool. No default user paths and no runtime execution.
const factories = {codex:createCodexAdapter, claude:createClaudeAdapter, opencode:createOpenCodeAdapter};
const args = process.argv.slice(2), values = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (Object.hasOwn(values, key)) throw new TypeError("Duplicate option");
  if (key === "--known-startup-failure") values[key] = true;
  else if (["--runtime", "--executable", "--config", "--captured-version", "--toml-python", "--plugin-root", "--skill-root", "--config-format"].includes(key)
    && args[i + 1] && !args[i + 1].startsWith("--")) values[key] = args[++i];
  else throw new TypeError("Unsupported inspection option");
}
if (!Object.hasOwn(factories, values["--runtime"]) || !values["--executable"]) throw new TypeError("Runtime and explicit executable path required");
if (values["--toml-python"] && values["--runtime"] !== "codex") throw new TypeError("TOML parser applies only to Codex");
if (values["--plugin-root"] && values["--runtime"] !== "codex") throw new TypeError("Plugin roots currently apply only to Codex");
if (values["--config-format"] && values["--runtime"] !== "opencode") throw new TypeError("Explicit format applies only to OpenCode");
const adapter = factories[values["--runtime"]]({installation:{executablePath:values["--executable"],
  version:values["--captured-version"] ?? null, startupFailed:values["--known-startup-failure"] === true,
  evidence:values["--captured-version"] ? [{kind:"local_cli", ref:"M9.1:prior-version-capture-not-reprobed"}] : []}, configPath:values["--config"],
  tomlParser:values["--toml-python"] ? createPythonTomlParser(values["--toml-python"]) : undefined,
  pluginRoots:values["--plugin-root"] ? [{path:values["--plugin-root"], scope:"explicit"}] : [],
  skillRoots:values["--skill-root"] ? [{path:values["--skill-root"], scope:"explicit"}] : [], configFormat:values["--config-format"]});
const snapshot = await adapter.snapshot();
console.log(JSON.stringify({discoveryId:snapshot.id, exposureObservationId:snapshot.actualExposure.id,
  identity:await adapter.identify(), status:snapshot.status, completeness:snapshot.completeness,
  sources:snapshot.sources,
  layerState:snapshot.layerState,
  observedCount:snapshot.observations.length, inventoryCount:snapshot.inventory.entries?.length ?? null,
  kinds:snapshot.observations.reduce((counts, o) => ({...counts, [o.capability.kind]:(counts[o.capability.kind] ?? 0) + 1}), {}),
  actualExposure:snapshot.actualExposure.state, support:await adapter.capabilities(), issues:snapshot.issues}, null, 2));
