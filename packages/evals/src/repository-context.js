import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../core/src/hash.js";
import { LocalRepositoryAdapter, LexicalCandidateGenerator, DeterministicContextStrategy, OkoContextStrategy, ContextShadowTournament } from "../../repository-context/src/index.js";

export const evalDirectory=new URL("../../../evals/repository-context/",import.meta.url);
export async function loadContextEvaluation() {
  const config=JSON.parse(await fs.readFile(new URL("config.json",evalDirectory),"utf8"));
  const cases=JSON.parse(await fs.readFile(new URL("cases.json",evalDirectory),"utf8"));
  const root=fileURLToPath(new URL("fixture/",evalDirectory));
  const repository=await new LocalRepositoryAdapter(root,config.repository).snapshot();
  if(repository.status!=="ready"||repository.discoveryTruncated)throw new Error("Evaluation fixture unavailable or truncated");
  validateContextCases(cases,repository.files);
  const manifest=await Promise.all(repository.files.map(async path=>({path,hash:sha256((await fs.readFile(new URL(`fixture/${path}`,evalDirectory))).toString("base64"))})));
  return {config,cases,repository,fixture_hash:sha256(manifest),corpus_hash:sha256(cases),configuration_hash:sha256(config)};
}
export function validateContextCases(cases,files) {
  const seen=new Set();
  if(!Array.isArray(cases)||!cases.length)throw new TypeError("Nonempty cases required");
  for(const c of cases){
    if(!c||![c.id,c.query,c.category,c.rationale,c.fixture].every(v=>typeof v==="string"&&v.trim())||seen.has(c.id)
      ||c.fixture!=="context-eval-v1"||!Array.isArray(c.expected)||new Set(c.expected).size!==c.expected.length
      ||c.expected.some(p=>!files.includes(p))||(c.primary!==undefined&&!c.expected.includes(c.primary)))throw new TypeError("Invalid evaluation case");
    seen.add(c.id);
  }
}
export function contextMetrics({expected,primary,candidates,selected,observableCount,operationalError=false}) {
  const recall=paths=>expected.length?expected.filter(p=>paths.includes(p)).length/expected.length:null;
  return {candidate_recall_at_k:candidates===null?null:recall(candidates),
    primary_recall_at_k:primary&&candidates!==null?Number(candidates.includes(primary)):null,
    candidate_reduction_ratio:candidates===null||!observableCount?null:1-candidates.length/observableCount,
    selected_recall:operationalError?null:recall(selected),
    selected_precision:operationalError?null:selected.length?selected.filter(p=>expected.includes(p)).length/selected.length:null,
    primary_success:operationalError||!primary?null:Number(selected.includes(primary)),
    correct_abstention:operationalError||expected.length?null:selected.length===0};
}
export function gradeContextArm(c,arm) {
  const a=arm.summary,p=arm.proposal.decision.provenance;
  const paths=ids=>ids?.map(id=>a.candidates.find(x=>x.id===id).path)??null;
  const candidates=a.generated_candidate_count===null?null:a.candidates.map(x=>x.path);
  const selected=paths(a.selected_candidate_ids),shortlist=paths(a.shortlist_ids);
  const operationalError=["error","unsupported"].includes(a.outcome);
  const semantic=new Map((p.semantic??[]).map(e=>[e.candidateId,e.probabilityTrue>p.threshold]));
  const diagnostics=c.expected.map(path=>{
    const id=a.candidates.find(x=>x.path===path)?.id;
    const stage=selected.includes(path)?"selected":candidates===null?"retrieval_unavailable":!candidates.includes(path)?"retrieval_miss":
      operationalError?"operational_error":a.strategy_id==="context/deterministic-v1"?"output_limit":!shortlist?.includes(path)?"not_shortlisted":semantic.get(id)===false?"semantic_rejection":"output_limit";
    return {path,stage};
  });
  return {case_id:c.id,strategy_id:a.strategy_id,strategy_version:a.strategy_version,invocation_id:a.invocation_id,
    repository_snapshot_id:a.repository_snapshot_id,expected:[...c.expected],primary:c.primary??null,
    candidates:a.candidates,shortlist,selected,outcome:a.outcome,reason:a.reason,failure_stage:a.failure_stage,
    metrics:contextMetrics({expected:c.expected,primary:c.primary,candidates,selected,observableCount:a.observable_file_count,operationalError}),diagnostics,
    operational:{candidate_count:a.generated_candidate_count,shortlist_count:a.shortlist_count,selected_count:a.selected_count,
      decision_calls:a.decision_calls,latency_ms:a.latency_ms,provider_errors:a.failure_stage==="provider"?1:0,
      strategy_errors:operationalError&&a.failure_stage!=="provider"?1:0},
    semantic_quality_eligible:!operationalError};
}
export function evaluationStrategies(config,engine) {
  const generator=()=>new LexicalCandidateGenerator(config.retrieval);
  return [new DeterministicContextStrategy({candidateGenerator:generator(),outputLimit:config.deterministic.outputLimit}),
    new OkoContextStrategy({...config.oko,candidateGenerator:generator(),decisionEngine:engine})];
}
export async function runContextEvaluation({dataset,engine,mode="offline-synthetic",caseIds=null}) {
  const {config,repository}=dataset;
  validateContextCases(dataset.cases,repository.files);
  if(!["offline-synthetic","live-sample"].includes(mode))throw new TypeError("Unknown evaluation mode");
  if(mode==="live-sample"&&(!engine||typeof engine.noul!=="function"))throw new TypeError("Live sample requires an explicit DecisionEngine");
  const cases=caseIds?caseIds.map(id=>{const c=dataset.cases.find(x=>x.id===id);if(!c)throw new TypeError("Unknown case");return c}):dataset.cases;
  const decisionEngine=engine??{noul:async()=>({probability_true:.8,probability_false:.2})};
  const rows=[],runs=[];
  for(const c of cases){
    // Labels/rationale/category never enter routing or the DecisionEngine.
    const run=await new ContextShadowTournament().run({task:{id:`context-eval-${c.id}`,text:c.query},repository,strategies:evaluationStrategies(config,decisionEngine)});
    runs.push({case_id:c.id,tournament_run_id:run.tournament_run_id});
    rows.push(...run.results.map(a=>gradeContextArm(c,a)));
  }
  return {version:config.version,mode,evidence_level:mode==="offline-synthetic"?"E2":"E1",configuration:config,
    configuration_hash:dataset.configuration_hash,fixture_hash:dataset.fixture_hash,corpus_hash:dataset.corpus_hash,
    interpretation:mode==="offline-synthetic"?"Synthetic pipeline correctness; mock is not JEV semantic quality":"Small live integration sample; no promotion evidence",
    runs,rows};
}
// Deliberately excludes machine-root identity, fresh correlation IDs and timing.
// Exact candidate paths/content hashes, ordering, metrics and outcomes stay.
export function stableContextEvaluation(report) {
  return {version:report.version,mode:report.mode,configuration_hash:report.configuration_hash,fixture_hash:report.fixture_hash,corpus_hash:report.corpus_hash,
    rows:report.rows.map(({invocation_id,repository_snapshot_id,candidates,operational,...row})=>({...row,
      candidates:candidates.map(({path,source_hash})=>({path,source_hash})),operational:{...operational,latency_ms:undefined}}))};
}
