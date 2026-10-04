import fs from "node:fs/promises";
import { newId } from "../packages/core/src/ids.js";
import { capabilityInventory, CapabilityShadowTournament } from "../packages/capability-exposure/src/index.js";
import { loadCapabilityEvaluation, materializeCapabilityCase, capabilityStrategies } from "../packages/evals/src/capability-exposure.js";

export async function runCapabilityShadow({taskText, inventorySource}) {
  if (typeof taskText !== "string" || !taskText.trim() || !inventorySource) throw new TypeError("--task and --inventory are required");
  const inventory = inventorySource === "fixture"
    ? await loadCapabilityEvaluation().then(d => materializeCapabilityCase(d.cases[0], d.catalog).input.inventory)
    : capabilityInventory(JSON.parse(await fs.readFile(inventorySource, "utf8")));
  const run = await new CapabilityShadowTournament().run({task:{id:newId("task"), text:taskText}, inventory, strategies:capabilityStrategies()});
  return {mode:"offline-synthetic", evidence:"Pipeline verification only; no live semantic evidence", tournament_run_id:run.tournament_run_id,
    shadow:true, actually_exposed:false, application:"not_applied", recording:run.recording, results:run.results.map(r => r.summary)};
}
export function formatCapabilityShadow(result) {
  return [`Capability Shadow (${result.mode}); no runtime exposure or tool invocation.`,
    ...result.results.map(r => `${r.strategy_id}: ${r.effective_exposed_count ?? "unknown"} exposable; ${r.decision_calls?.attempted ?? "unknown"} mock calls; ${r.reason}`),
    "Schema-size values are character proxies, not actual token savings. No winner."].join("\n");
}
