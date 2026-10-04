import fs from "node:fs/promises";
import { sha256 } from "../../core/src/hash.js";
import { capabilityDescriptor, capabilityInventory, exposureInput, capabilityEligibility, freeze, CAPABILITY_LIMITS,
  AllVisibleCapabilityStrategy, DeterministicCapabilityStrategy, JevSelectiveCapabilityStrategy,
  JevHierarchicalCoverCapabilityStrategy, CapabilityShadowTournament } from "../../capability-exposure/src/index.js";

export const capabilityEvalDirectory = new URL("../../../evals/capability-exposure/", import.meta.url);
export async function loadCapabilityEvaluation() {
  const [config, catalog, cases] = await Promise.all(["config", "catalog", "cases"].map(async name =>
    JSON.parse(await fs.readFile(new URL(`${name}.json`, capabilityEvalDirectory), "utf8"))));
  if (!config.frozenBeforeExecution || sha256(config.limits) !== sha256(CAPABILITY_LIMITS)
      || catalog.length < 30 || catalog.length > 50 || cases.length < 16 || cases.length > 20
      || new Set(cases.map(c => c.id)).size !== cases.length) throw new TypeError("Invalid frozen capability evaluation");
  for (const c of cases) materializeCapabilityCase(c, catalog);
  return freeze({config, catalog, cases, configuration_hash:sha256(config), corpus_hash:sha256({catalog, cases})});
}

export function materializeCapabilityCase(c, catalog) {
  const descriptors = catalog.map(d => capabilityDescriptor({...d, source:{namespace:"neutral-fixture", nativeId:d.name}}));
  const byName = new Map(descriptors.map(d => [d.name, d.id]));
  if (byName.size !== catalog.length || ![c.id, c.task, c.rationale].every(s => typeof s === "string" && s.trim())
      || !["known", "known-empty", "unknown"].includes(c.inventoryState) || typeof c.labelsExhaustive !== "boolean") throw new TypeError("Invalid case");
  const ids = names => {
    if (!Array.isArray(names) || new Set(names).size !== names.length || names.some(n => !byName.has(n))) throw new TypeError("Invalid case labels");
    return names.map(n => byName.get(n)).sort();
  };
  if (!c.facts || Object.keys(c.facts).some(n => !byName.has(n))) throw new TypeError("Unknown fact identity");
  const inventory = capabilityInventory({runtime:{id:"neutral-synthetic", family:"fixture"}, source:"frozen-fixture",
    state:c.inventoryState === "unknown" ? "unknown" : "known", entries:c.inventoryState === "unknown" ? null
      : c.inventoryState === "known-empty" ? [] : descriptors.map(capability => ({capability, available:true, supported:true,
        enabled:true, permission:"allowed", ...c.facts[capability.name]}))});
  const input = exposureInput({task:{id:`capability-eval-${c.id}`, text:c.task}, inventory,
    constraints:{includeIds:ids(c.includes), excludeIds:ids(c.excludes)}});
  const truth = {must:ids(c.must), acceptable:ids(c.acceptable), mustNot:ids(c.mustNot), exhaustive:c.labelsExhaustive};
  const eligibility = capabilityEligibility(input);
  if (truth.must.some(id => !eligibility.eligibleIds?.includes(id))
      || truth.mustNot.some(id => !eligibility.exclusions.some(e => e.id === id))
      || truth.acceptable.some(id => truth.must.includes(id) || truth.mustNot.includes(id))) throw new TypeError("Contradictory labels");
  return {input, truth};
}

// Connectivity-free, label-independent lexical mock. This is not JEV quality.
export function offlineCapabilityEngine(behavior) {
  let calls = 0;
  return {noul:async ({state}) => {
    if (behavior === "provider_failure" && ++calls === 2) throw new Error("Synthetic provider failure");
    const words = new Set(state.task.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const vocabulary = {
      'workspace.discovery':['investigate','inspect','list','files'], 'workspace.search':['search','investigate','debug'],
      'workspace.read':['read','inspect','files','source'], 'workspace.write':['write','edit','apply'], 'workspace.execute':['run','execute','python'],
      'repository.structure':['repository','source'], 'repository.dependencies':['package','dependencies','install'],
      'repository.configuration':['config','configuration'], 'repository.schema':['schema','validate'], 'repository.api':['api','contract'],
      'verification.tests':['test','tests','regression'], 'verification.unit':['unit'], 'verification.integration':['integration'],
      'verification.coverage':['coverage'], 'verification.benchmark':['benchmark'], 'frontend.inspect':['frontend','interface','preview'],
      'frontend.accessibility':['accessibility'], 'assets.inspect':['image','asset'], 'lifecycle.migration':['migration','migrations'],
      'lifecycle.release':['deploy','release'], 'external.web':['web','page','pages','public','browser'], 'external.browse':['browser','page','pages'],
      'external.search':['search','research'], 'external.fetch':['fetch','http'], 'external.catalog':['github'],
      'external.issues':['issue','issues'], 'external.skill':['skill'], 'data.inspect':['data','dataset','records','logs'],
      'data.tabular':['csv','tabular'], 'data.database':['sql','database','records'], 'data.schema':['schema','table'],
      'data.analyze':['analyze','analysis','python','compare'], 'data.python':['python'],
      'data.visualize':['chart','charts','visualization'], 'version_control.inspect':['git','github'],
      'version_control.changes':['changes','diff'], 'version_control.history':['history','log'], 'version_control.review':['pull','requests'],
      'version_control.change':['commit'], 'documentation.read':['documentation','document','pdf'],
      'documentation.search':['search','documentation'], 'documentation.write':['markdown','report','summary','write'],
      'documentation.markdown':['markdown']
    };
    const subjects = state.atom ? [state.atom] : state.coverageAtoms ?? [];
    const matched = subjects.some(subject => (vocabulary[subject] ?? subject.split('.')).some(word => words.has(word)));
    const description = state.capability ? `${state.capability.name} ${state.capability.description}`.toLowerCase() : '';
    const p = matched || [...words].some(w => w.length > 3 && description.includes(w)) ? .8 : .05;
    return {primitive:"noul", probability_true:p, probability_false:1-p};
  }};
}
export function capabilityStrategies(engine = offlineCapabilityEngine(), {includeHsce = true} = {}) {
  return [new AllVisibleCapabilityStrategy(), new DeterministicCapabilityStrategy(), new JevSelectiveCapabilityStrategy({decisionEngine:engine}),
    ...(includeHsce ? [new JevHierarchicalCoverCapabilityStrategy({decisionEngine:engine})] : [])];
}

export function capabilityMetrics(input, truth, effective) {
  const eligible = capabilityEligibility(input).eligibleIds, ids = effective.effectiveIds;
  const ratio = (a, b) => b ? a / b : null;
  if (ids === null) return {must_expose_recall:null, must_count:null, retained_must:null, false_exclusions:null,
    irrelevant_exposure:null, exposure_precision:null, count_reduction:null, schema_size_reduction:null,
    explicit_include_correctness:null, explicit_exclude_correctness:null, policy_correctness:null};
  const retained = truth.must.filter(id => ids.includes(id)).length;
  const relevant = ids.filter(id => truth.must.includes(id) || truth.acceptable.includes(id)).length;
  const includes = input.constraints.includeIds.filter(id => eligible.includes(id));
  const excludes = input.constraints.excludeIds;
  return {must_expose_recall:ratio(retained, truth.must.length), must_count:truth.must.length, retained_must:retained,
    false_exclusions:truth.must.length - retained, irrelevant_exposure:truth.exhaustive ? ids.length - relevant : null,
    exposure_precision:truth.exhaustive ? ratio(relevant, ids.length) : null,
    count_reduction:ratio(eligible.length - ids.length, eligible.length), schema_size_reduction:effective.schemaSizeProxy.reductionRatio,
    explicit_include_correctness:ratio(includes.filter(id => ids.includes(id)).length, includes.length),
    explicit_exclude_correctness:ratio(excludes.filter(id => !ids.includes(id)).length, excludes.length),
    policy_correctness:ids.every(id => eligible.includes(id)) && truth.mustNot.every(id => !ids.includes(id))};
}

export function capabilityAttribution(input, truth, result) {
  const eligibility = capabilityEligibility(input), p = result.proposal;
  return truth.must.map(id => ({id, stage:result.effective.overrides.some(o => o.id === id) ? "explicit_override"
    : !input.inventory.entries?.some(e => e.capability.id === id) ? "inventory"
      : !eligibility.eligibleIds.includes(id) ? "eligibility"
        : result.summary.failure_stage === "proposal_validation" ? "proposal_validation"
          : result.summary.failure_stage === "provider" ? "provider"
            : result.effective.effectiveIds.includes(id) ? "retained"
              : result.effective.rejections.some(r => r.id === id) ? "policy_rejection"
                : p.semanticCandidateIds.includes(id) ? "semantic" : "candidate_generation"}));
}

export async function runCapabilityEvaluation({dataset, mode = "offline-synthetic", engine, caseIds = null}) {
  if (sha256(dataset.config) !== dataset.configuration_hash || sha256({catalog:dataset.catalog, cases:dataset.cases}) !== dataset.corpus_hash)
    throw new TypeError("Evaluation changed after freeze");
  if (!["offline-synthetic", "live-sample"].includes(mode)) throw new TypeError("Invalid evaluation mode");
  if (mode === "live-sample" && (typeof engine?.noul !== "function" || !caseIds?.length || caseIds.length > 3
      || new Set(caseIds).size !== caseIds.length || caseIds.some(id => !dataset.config.liveCaseIds.includes(id))
      || caseIds.length * CAPABILITY_LIMITS.maxCalls > Math.min(20, dataset.config.liveMaxCalls))) throw new TypeError("Invalid live budget/cases");
  let liveCalls = 0;
  const bounded = mode === "live-sample" ? {noul:request => {
    if (liveCalls >= Math.min(20, dataset.config.liveMaxCalls)) throw new Error("Live budget exhausted");
    liveCalls++; return engine.noul(request);
  }} : null;
  const rows = [];
  for (const c of caseIds ? caseIds.map(id => {const c = dataset.cases.find(c => c.id === id); if (!c) throw new TypeError("Unknown case"); return c}) : dataset.cases) {
    const {input, truth} = materializeCapabilityCase(c, dataset.catalog);
    const run = await new CapabilityShadowTournament().run({...input,
      strategies:capabilityStrategies(bounded ?? engine ?? offlineCapabilityEngine(c.mockBehavior), {includeHsce:mode === "offline-synthetic"})});
    for (const result of run.results) {
      const s = result.summary;
      rows.push({case_id:c.id, strategy_id:s.strategy_id, inventory_id:s.inventory_id, tournament_run_id:run.tournament_run_id,
        invocation_id:s.invocation_id, outcome:s.outcome, reason:s.reason, effective_ids:s.effective_ids,
        eligible_count:s.eligible_count, semantic_candidates:s.semantic_candidate_count, effective_count:s.effective_exposed_count,
        overrides:s.overrides, policy_rejections:s.policy_rejections, fallback:s.fallback,
        metrics:capabilityMetrics(input, truth, result.effective), diagnostics:capabilityAttribution(input, truth, result),
        operational:{calls:s.decision_calls, latency_ms:s.latency_ms, failure_stage:s.failure_stage},
        schema_size_proxy:s.schema_size_proxy, shadow:true, actually_exposed:false});
    }
  }
  return {version:"capability.eval.v1", mode, evidence:mode === "offline-synthetic" ? "E2 synthetic; not live semantic evidence" : "small live sample; no promotion",
    configuration_hash:dataset.configuration_hash, corpus_hash:dataset.corpus_hash, live_calls:liveCalls, rows};
}

export function stableCapabilityEvaluation(report) {
  return {...report, rows:report.rows.map(({tournament_run_id, invocation_id, operational, ...row}) => ({...row,
    operational:{calls:operational.calls, failure_stage:operational.failure_stage}}))};
}

export function compactCapabilityEvaluation(report) {
  const mean = values => {const known = values.filter(x => x !== null); return known.length ? known.reduce((a,b) => a+b, 0) / known.length : null};
  return {version:report.version, mode:report.mode, evidence:report.evidence, configuration_hash:report.configuration_hash,
    corpus_hash:report.corpus_hash, replay_hash:sha256(stableCapabilityEvaluation(report)), live_calls:report.live_calls,
    summary:[...new Set(report.rows.map(r => r.strategy_id))].map(strategy_id => {
      const rows = report.rows.filter(r => r.strategy_id === strategy_id), must = rows.reduce((n,r) => n + (r.metrics.must_count ?? 0),0);
      return {strategy_id, cases:rows.length, must_count:must,
        must_expose_recall:must ? rows.reduce((n,r) => n + (r.metrics.retained_must ?? 0),0) / must : null,
        false_exclusions:rows.reduce((n,r) => n + (r.metrics.false_exclusions ?? 0),0),
        mean_count_reduction:mean(rows.map(r => r.metrics.count_reduction)),
        mean_schema_size_proxy_reduction:mean(rows.map(r => r.metrics.schema_size_reduction)),
        policy_violations:rows.filter(r => r.metrics.policy_correctness === false).length,
        calls:rows.reduce((n,r) => n + (r.operational.calls?.attempted ?? 0),0)};
    }), rows:report.rows.map(({effective_ids, policy_rejections, diagnostics, ...r}) => ({...r,
      effective_ids_hash:sha256(effective_ids), policy_rejection_count:policy_rejections.length,
      diagnostics:diagnostics.filter(d => d.stage !== "retained")}))};
}
