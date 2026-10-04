#!/usr/bin/env node
import fs from "node:fs/promises";
import { loadCapabilityEvaluation, runCapabilityEvaluation, compactCapabilityEvaluation, capabilityEvalDirectory } from "../packages/evals/src/capability-exposure.js";
import { JevDecisionEngine } from "../packages/decision-providers/jev/src/jev-decision-engine.js";

const dataset = await loadCapabilityEvaluation();
const offline = compactCapabilityEvaluation(await runCapabilityEvaluation({dataset}));
if (!process.argv.includes("--live")) {
  process.stdout.write(`${JSON.stringify(offline)}\n`);
} else {
  // Verify the frozen offline replay before even inspecting credential presence.
  const saved = JSON.parse(await fs.readFile(new URL("offline-results.json", capabilityEvalDirectory), "utf8"));
  if (saved.replay_hash !== offline.replay_hash || saved.corpus_hash !== dataset.corpus_hash
      || saved.configuration_hash !== dataset.configuration_hash) throw new Error("Offline replay prerequisite failed");
  if (!process.env.TYPESAFE_API_KEY) process.stdout.write(`${JSON.stringify({status:"LIVE_EVAL_PENDING", live_calls:0, model:null, input_tokens:0, output_tokens:0})}\n`);
  else {
    const events = [];
    const engine = new JevDecisionEngine({onTelemetry:event => events.push(event)});
    const report = compactCapabilityEvaluation(await runCapabilityEvaluation({dataset, mode:"live-sample", engine, caseIds:dataset.config.liveCaseIds}));
    const usage = {models:[...new Set(events.map(e => e.provider_model).filter(Boolean))],
      input_tokens:events.every(e => e.input_tokens !== null) ? events.reduce((n,e) => n+e.input_tokens,0) : null,
      output_tokens:events.every(e => e.output_tokens !== null) ? events.reduce((n,e) => n+e.output_tokens,0) : null,
      provider_failures:events.filter(e => !e.success).length, latency_ms:events.reduce((n,e) => n+e.latency_ms,0),
      calls:events.map(e => ({request_id:e.request_id, task_id:e.task_id, decision_context:e.decision_context, model:e.provider_model, input_tokens:e.input_tokens,
        output_tokens:e.output_tokens, latency_ms:e.latency_ms, success:e.success, error_code:e.error_code ?? null}))};
    process.stdout.write(`${JSON.stringify({status:"LIVE_SAMPLE_COMPLETE", report, usage})}\n`);
  }
}
