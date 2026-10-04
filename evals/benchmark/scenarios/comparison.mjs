import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomic,iso} from '../../smoke-test/lib/common.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const usage=condition=>condition?.telemetry?.mainModelUsage??{};
const timings=condition=>condition?.telemetry?.timings??{};
const jev=condition=>condition?.telemetry?.jevUsage??{};
const correctness=condition=>({
  status:condition?.status==='INFRA_FAILURE'?'INFRA_FAILURE':condition?.correctness?.status??null,
  productStatus:condition?.correctness?.status??null,
  build:condition?.evaluation?.build?.pass??null,
  publicTests:condition?.evaluation?.publicTests?.pass??null,
  hiddenPassed:condition?.evaluation?.acceptance?.passed??null,
  hiddenTotal:condition?.evaluation?.acceptance?.total??null
});
const metric=(control,jar,comparable=true)=>({
  control,
  jar,
  delta:comparable&&Number.isFinite(control)&&Number.isFinite(jar)?jar-control:null,
  percentDelta:comparable&&Number.isFinite(control)&&Number.isFinite(jar)&&control!==0?(jar-control)/control*100:null
});
function routing(jar){
  const r=jar?.routing??{},exposed=r.selectedCapabilities??r.selectedCapabilityIds??r.selectedIds??r.exposedCapabilityIds??null,withheld=r.withheldCapabilities??r.withheldCapabilityIds??null,invoked=r.actualToolsCalled??null;
  return{eligible:Array.isArray(r.capabilityCandidates)?r.capabilityCandidates.length:r.candidateCapabilityCount??r.eligibleCapabilityCount??null,exposedCount:Array.isArray(exposed)?exposed.length:r.selectedCapabilityCount??null,withheldCount:Array.isArray(withheld)?withheld.length:r.withheldCapabilityCount??null,invokedCount:Array.isArray(invoked)?invoked.length:r.invokedCapabilityCount??null,exposedButUnused:r.exposedButUnused??null,selectedSkills:r.selectedSkills??null};
}
function row({benchmarkId,title,role,protocolVersion,baseline,iteration}){
  const control=baseline.control,jar=iteration.jar,cUsage=usage(control),jUsage=usage(jar),cTiming=timings(control),jTiming=timings(jar),jJev=jev(jar);
  const jevTokens=Number.isFinite(jJev.input_tokens)&&Number.isFinite(jJev.output_tokens)?jJev.input_tokens+jJev.output_tokens:null;
  const comparable=control?.status==='COMPLETED'&&jar?.status==='COMPLETED';
  return{benchmarkId,title,role,protocolVersion,controlId:baseline.baselineId,jarId:iteration.runId,iterationStatus:iteration.status,validWithinBenchmarkComparison:comparable,comparisonUnavailableReason:comparable?null:'JAR_CONDITION_INFRA_FAILURE',controlCorrectness:correctness(control),jarCorrectness:correctness(jar),mainModelTokens:metric(cUsage.totalTokens,jUsage.totalTokens,comparable),wallTimeMs:metric(control.telemetry?.wallTimeMs,jar.telemetry?.wallTimeMs,comparable),toolCalls:metric(cTiming.toolCalls,jTiming.toolCalls,comparable),jevOverheadTokens:jevTokens,capabilities:routing(jar)};
}
const esc=value=>String(value??'unavailable').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function generateComparison(repo){
  const canonicalRoot=path.join(repo,'.jar','benchmarks','canonical'),replicationRoot=path.join(repo,'.jar','benchmarks','replication','opsdesk-v1');
  const canonicalPointer=read(path.join(canonicalRoot,'baseline','ACTIVE.json')),canonicalBaseline=read(path.join(canonicalRoot,'baseline',canonicalPointer.relativeDirectory,'BASELINE.json')),canonicalLatest=read(path.join(canonicalRoot,'LATEST','SUMMARY.json'));
  const replicationPointer=read(path.join(replicationRoot,'baseline','ACTIVE.json')),replicationBaseline=read(path.join(replicationRoot,'baseline',replicationPointer.relativeDirectory,'BASELINE.json')),replicationLatest=read(path.join(replicationRoot,'LATEST','SUMMARY.json'));
  const benchmarks=[
    row({benchmarkId:'opsdesk-soft-v1',title:'OpsDesk Soft',role:'LEGACY_DIAGNOSTIC',protocolVersion:replicationBaseline.protocolVersion,baseline:replicationBaseline,iteration:replicationLatest}),
    row({benchmarkId:'opsdesk-hard-v2.4',title:'OpsDesk Hard',role:'CANONICAL_DEVELOPMENT',protocolVersion:canonicalBaseline.protocolVersion,baseline:canonicalBaseline,iteration:canonicalLatest})
  ];
  const report={schemaVersion:'jar.cross-benchmark-comparison.v1',generatedAt:iso(),aggregation:null,warning:'Rows describe different task difficulties. Do not average them or compare raw acceptance counts.',benchmarks};
  atomic(path.join(repo,'.jar','benchmarks','COMPARISON.json'),report);
  const rows=benchmarks.map(x=>`<tr><th>${esc(x.title)}</th><td>${esc(x.role)}</td><td>${esc(x.controlCorrectness.status)}</td><td>${esc(x.jarCorrectness.status)}${x.validWithinBenchmarkComparison?'':` — ${esc(x.comparisonUnavailableReason)}`}</td><td>${esc(x.mainModelTokens.control)} → ${esc(x.mainModelTokens.jar)} (${esc(x.mainModelTokens.percentDelta)}%)</td><td>${esc(x.wallTimeMs.delta)}</td><td>${esc(x.toolCalls.delta)}</td><td>${esc(x.jevOverheadTokens)}</td><td><pre>${esc(JSON.stringify(x.capabilities,null,2))}</pre></td></tr>`).join('');
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>OpsDesk benchmark comparison</title><style>body{font:15px system-ui;max-width:1400px;margin:auto;padding:2rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.5rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap}</style></head><body><h1>OpsDesk benchmark comparison</h1><p>Correctness first, efficiency second. These tasks have different difficulty and are not averaged. No JAR score is produced.</p><table><thead><tr><th>Benchmark</th><th>Role</th><th>CONTROL correctness</th><th>JAR correctness</th><th>Main-model tokens</th><th>Wall Δ ms</th><th>Tool-call Δ</th><th>JEV tokens</th><th>Routing</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  atomic(path.join(repo,'.jar','benchmarks','COMPARISON.html'),html,true);
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))generateComparison(process.cwd());
