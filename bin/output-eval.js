#!/usr/bin/env node
import fs from "node:fs/promises";
import { sha256 } from "../packages/core/src/hash.js";
import { loadOutputEvaluation, runOutputEvaluation, stableOutputEvaluation, summarizeOutputEvaluation, outputEvalDirectory } from "../packages/evals/src/output-filtering.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--live")) throw new Error("Usage: node bin/output-eval.js [--live]");
const dataset = await loadOutputEvaluation();
const offline = await runOutputEvaluation({dataset});
const artifact = {version:offline.version, mode:offline.mode, evidence_level:offline.evidence_level,
  configuration_hash:offline.configuration_hash, corpus_hash:offline.corpus_hash,
  stable_report_sha256:sha256(stableOutputEvaluation(offline)), summary:summarizeOutputEvaluation(offline),
  cases:offline.rows.map(({case_id, strategy_id, outcome, reason, gate, failure_stage, metrics, operational}) => ({
    case_id, strategy_id, outcome, reason, gate, failure_stage, metrics, calls:operational.calls,
  })), recorded_latency_ms:offline.rows.reduce((sum, row) => sum + row.operational.latency_ms, 0)};
if (!args.length) {
  console.log(JSON.stringify(artifact));
} else {
  // A live run cannot precede the recorded offline checkpoint or silently use a
  // mock. Read ONLY presence, after replay verification; never print credentials.
  const recorded = JSON.parse(await fs.readFile(new URL("offline-results.json", outputEvalDirectory), "utf8"));
  if (recorded.stable_report_sha256 !== artifact.stable_report_sha256
      || offline.rows.some(row => row.metrics.false_drop_chars || row.metrics.must_retain_recall !== 1 || !row.metrics.recovery_success)) throw new Error("Offline checkpoint mismatch");
  if (!process.env.TYPESAFE_API_KEY) {
    console.log(JSON.stringify({status:"LIVE_EVAL_PENDING", calls:0, effective_models:[], input_tokens:0, output_tokens:0,
      configuration_hash:dataset.configuration_hash, corpus_hash:dataset.corpus_hash, reason:"credential_absent"}));
  } else {
    const { JevDecisionEngine } = await import("../packages/decision-providers/jev/src/jev-decision-engine.js");
    const providerEvents = [];
    const engine = new JevDecisionEngine({onTelemetry:event => providerEvents.push(event)});
    const report = await runOutputEvaluation({dataset, mode:"live-sample", engine, caseIds:dataset.config.liveCaseIds});
    console.log(JSON.stringify({status:"LIVE_SAMPLE_COMPLETE", evidence_level:"E1", calls:report.live_calls,
      effective_models:[...new Set(providerEvents.map(e => e.provider_model).filter(Boolean))],
      input_tokens:providerEvents.some(e => e.input_tokens == null) ? null : providerEvents.reduce((n, e) => n + e.input_tokens, 0),
      output_tokens:providerEvents.some(e => e.output_tokens == null) ? null : providerEvents.reduce((n, e) => n + e.output_tokens, 0),
      provider_errors:providerEvents.filter(e => !e.success).map(e => ({code:e.error_code, latency_ms:e.latency_ms})),
      provider_latency_ms:providerEvents.reduce((n, e) => n + e.latency_ms, 0),
      configuration_hash:report.configuration_hash, corpus_hash:report.corpus_hash,
      summary:summarizeOutputEvaluation(report), cases:stableOutputEvaluation(report).rows,
      interpretation:"One bounded integration run, no retries/tuning/promotion. Unknown usage remains null."}));
  }
}
