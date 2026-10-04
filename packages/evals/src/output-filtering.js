import fs from "node:fs/promises";
import { sha256 } from "../../core/src/hash.js";
import { freshOutput, MemoryOutputArchive, PassthroughOutputStrategy, DeterministicOutputStrategy,
  JevSieveOutputStrategy, OutputShadowTournament } from "../../output-filtering/src/index.js";

export const outputEvalDirectory = new URL("../../../evals/output-filtering/", import.meta.url);
export async function loadOutputEvaluation() {
  const config = JSON.parse(await fs.readFile(new URL("config.json", outputEvalDirectory), "utf8"));
  const cases = JSON.parse(await fs.readFile(new URL("cases.json", outputEvalDirectory), "utf8"));
  if (config.frozenBeforeExecution !== true || !Array.isArray(cases) || cases.length < 12 || cases.length > 20
      || new Set(cases.map(c => c.id)).size !== cases.length) throw new TypeError("Invalid frozen output corpus");
  for (const c of cases) materializeOutputCase(c);
  return {config, cases, configuration_hash:sha256(config), corpus_hash:sha256(cases)};
}

export function materializeOutputCase(c) {
  if (!c || ![c.id, c.scenario, c.task, c.rationale].every(s => typeof s === "string" && s.length)
      || !Array.isArray(c.parts) || !c.parts.length) throw new TypeError("Invalid output case");
  const truth = [];
  const parts = c.parts.map((part, partIndex) => {
    if (!Array.isArray(part.blocks) || !part.blocks.length) throw new TypeError("Invalid case blocks");
    let text = "";
    for (const block of part.blocks) {
      const repeat = block.repeat ?? 1;
      if (typeof block.text !== "string" || !["must", "safe", "optional"].includes(block.label)
          || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 2000) throw new TypeError("Invalid output truth");
      const start = text.length; text += block.text.repeat(repeat);
      truth.push({partIndex, start, end:text.length, label:block.label});
    }
    return {channel:part.channel, contentType:"text", text};
  });
  return {observation:freshOutput({toolInvocationId:`fixture-${c.id}`, capabilityId:"synthetic-output", taskId:`eval-${c.id}`, source:c.source, parts}),
    task:{id:`eval-${c.id}`, text:c.task}, truth};
}

export function outputMetrics({observation, segments, retainedIds, truth, recoverySuccess}) {
  const kept = new Set(retainedIds);
  const removed = segments.filter(s => !kept.has(s.id));
  const overlap = (a, b) => a.partIndex === b.partIndex ? Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) : 0;
  const removedChars = removed.reduce((sum, s) => sum + s.end - s.start, 0);
  const must = truth.filter(t => t.label === "must"), safe = truth.filter(t => t.label === "safe");
  const falseDropChars = must.reduce((sum, t) => sum + removed.reduce((n, s) => n + overlap(t, s), 0), 0);
  const retainedMust = must.filter(t => t.start === t.end
    ? segments.some(s => s.partIndex === t.partIndex && s.start === s.end && kept.has(s.id))
    : !removed.some(s => overlap(t, s) > 0)).length;
  const safeRemoved = safe.reduce((sum, t) => sum + removed.reduce((n, s) => n + overlap(t, s), 0), 0);
  return {must_retain_recall:must.length ? retainedMust / must.length : null, must_retain_count:must.length,
    retained_must_count:retainedMust, false_drop_chars:falseDropChars,
    safe_removal_precision:removedChars ? safeRemoved / removedChars : null,
    retained_chars:observation.chars - removedChars, removed_chars:removedChars,
    retained_ratio:observation.chars ? 1 - removedChars / observation.chars : 1,
    reduction_ratio:observation.chars ? removedChars / observation.chars : 0, recovery_success:recoverySuccess};
}

export function offlineOutputEngine(behavior) {
  let count = 0;
  return {noul:async ({state}) => {
    if (behavior === "provider_failure" && ++count === 2) throw new Error("Synthetic provider failure");
    const text = state.segment.text;
    const progressOnly = text.startsWith("progress: ") && text.split(/\r\n|\r|\n/).filter(Boolean).every(line => /^progress: \d+\/\d+$/.test(line));
    const probability_true = progressOnly ? .01 : .99;
    return {primitive:"noul", probability_true, probability_false:1 - probability_true};
  }};
}

export async function runOutputEvaluation({dataset, mode = "offline-synthetic", engine, caseIds = null}) {
  if (!["offline-synthetic", "live-sample"].includes(mode) || (mode === "live-sample" && typeof engine?.noul !== "function")) throw new TypeError("Explicit live engine required");
  if (sha256(dataset.config) !== dataset.configuration_hash || sha256(dataset.cases) !== dataset.corpus_hash) throw new TypeError("Evaluation changed after freeze");
  const cases = caseIds ? caseIds.map(id => {const c = dataset.cases.find(c => c.id === id); if (!c) throw new TypeError("Unknown case"); return c}) : dataset.cases;
  if (mode === "live-sample" && (!caseIds || caseIds.length > 3 || new Set(caseIds).size !== caseIds.length
      || caseIds.some(id => !dataset.config.liveCaseIds.includes(id)))) throw new TypeError("Live cases not preselected");
  let liveCalls = 0;
  const boundedEngine = mode === "live-sample" ? {noul:input => {
    if (liveCalls >= Math.min(20, dataset.config.liveMaxCalls)) throw new Error("Live budget exhausted");
    liveCalls++; return engine.noul(input);
  }} : null;
  const rows = [], runs = [];
  for (const c of cases) {
    const {observation, task, truth} = materializeOutputCase(c);
    const deterministicArchive = new MemoryOutputArchive(dataset.config.archive), semanticArchive = new MemoryOutputArchive(dataset.config.archive);
    const strategies = [new PassthroughOutputStrategy(), new DeterministicOutputStrategy({archive:deterministicArchive, limits:dataset.config.limits}),
      new JevSieveOutputStrategy({archive:semanticArchive, limits:dataset.config.limits, semanticLimits:dataset.config.semanticLimits,
        decisionEngine:boundedEngine ?? engine ?? offlineOutputEngine(c.mockBehavior)})];
    const run = await new OutputShadowTournament().run({observation, task, strategies});
    runs.push({case_id:c.id, tournament_run_id:run.tournament_run_id});
    for (let index = 0; index < run.results.length; index++) {
      const result = run.results[index], s = result.summary;
      let recovered = true;
      if (s.removed_chars > 0) {
        try { recovered = strategies[index].archive.recover(result.proposal.recoveryRef).id === observation.id; }
        catch { recovered = false; }
      }
      const metrics = outputMetrics({observation, segments:result.segments, retainedIds:s.retained_segment_ids, truth, recoverySuccess:recovered});
      rows.push({case_id:c.id, strategy_id:s.strategy_id, observation_id:s.observation_id, invocation_id:s.invocation_id,
        outcome:s.outcome, reason:s.reason, gate:s.gate_result, gate_reason:s.gate_reason, failure_stage:s.failure_stage,
        original_chars:s.original_chars, segments:s.segment_count, semantic_candidates:s.semantic_candidate_count,
        metrics, operational:{calls:s.decision_calls, latency_ms:s.latency_ms, provider_errors:s.failure_stage === "provider" ? 1 : 0,
          strategy_errors:["archive", "segmentation", "reconstruction", "normalization", "gate", "semantic"].includes(s.failure_stage) && s.outcome === "error" ? 1 : 0},
        diagnostics:truth.filter(t => t.label === "must").map(t => ({part_index:t.partIndex, start:t.start, end:t.end,
          stage:result.segments.some(seg => seg.partIndex === t.partIndex && seg.start < t.end && seg.end > t.start && !s.retained_segment_ids.includes(seg.id))
            ? result.proposal.method === "semantic" ? "semantic" : "reconstruction" : "retained"}))});
    }
    deterministicArchive.clear(); semanticArchive.clear();
  }
  return {version:dataset.config.version, mode, evidence_level:mode === "offline-synthetic" ? "E2" : "E1",
    configuration_hash:dataset.configuration_hash, corpus_hash:dataset.corpus_hash, runs, rows, live_calls:liveCalls,
    interpretation:mode === "offline-synthetic" ? "Synthetic pipeline correctness only; no JEV quality claim" : "Tiny integration sample only; no promotion"};
}

export function stableOutputEvaluation(report) {
  return {...report, runs:report.runs.map(({case_id}) => ({case_id})), rows:report.rows.map(({invocation_id, operational, ...row}) => ({...row,
    operational:{...operational, latency_ms:undefined}}))};
}

export function summarizeOutputEvaluation(report) {
  return [...new Set(report.rows.map(r => r.strategy_id))].map(strategy_id => {
    const rows = report.rows.filter(r => r.strategy_id === strategy_id), sum = field => rows.reduce((n, r) => n + r.metrics[field], 0);
    const must = sum("must_retain_count"), removed = sum("removed_chars");
    return {strategy_id, cases:rows.length, must_retain_recall:must ? sum("retained_must_count") / must : null,
      false_drop_chars:sum("false_drop_chars"), removed_chars:removed,
      reduction_ratio:removed / rows.reduce((n, r) => n + r.original_chars, 0),
      safe_removal_precision:removed ? rows.reduce((n, r) => n + (r.metrics.safe_removal_precision ?? 0) * r.metrics.removed_chars, 0) / removed : null,
      recovery_successes:rows.filter(r => r.metrics.recovery_success).length,
      calls:rows.reduce((n, r) => n + (r.operational.calls?.attempted ?? 0), 0),
      provider_errors:rows.reduce((n, r) => n + r.operational.provider_errors, 0), strategy_errors:rows.reduce((n, r) => n + r.operational.strategy_errors, 0)};
  });
}
