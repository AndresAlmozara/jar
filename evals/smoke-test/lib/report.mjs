import fs from 'node:fs';
import path from 'node:path';
import {atomic,json,equalSet} from './common.mjs';
export function makePairs(tasks,runs) {
  return tasks.map(task=>{
    const c=runs.find(r=>r.task_id===task.task_id&&r.condition==='CONTROL');
    const j=runs.find(r=>r.task_id===task.task_id&&r.condition==='JAR');
    const pair={task_id:task.task_id,focus:task.focus,control:c??null,jar:j??null,validPair:false,
      functional:'INCOMPLETE',diagnostic:null,confounded:null,ratios:null};
    if(!c||!j)return pair;
    if([c,j].some(r=>r.outcome==='INFRA_FAIL')){pair.functional='INFRASTRUCTURE_FAILURE';return pair;}
    const fields=['mainModel','runtimeVersion','runtimeHash','baselineId'];
    const same=fields.every(k=>c[k]!=null&&c[k]===j[k])&&['startStateHash','taskHash','manifestHash'].every(k=>c.plan?.[k]!=null&&c.plan[k]===j.plan?.[k]);
    const ct=c.plan?.capabilityMapping?.map(x=>x.toolName),jt=j.plan?.capabilityMapping?.map(x=>x.toolName);
    if(!same||!equalSet(ct,jt)){pair.functional='PAIR_IDENTITY_MISMATCH';return pair;}
    const ec=c.modelSession?.effectiveThread?.reasoningEffort,ej=j.modelSession?.effectiveThread?.reasoningEffort;
    if(ec!==undefined&&ej!==undefined&&ec!==ej){pair.functional='EFFORT_MISMATCH';return pair;}
    pair.validPair=true;
    pair.functional=c.outcome==='PASS'?(j.outcome==='PASS'?'BOTH_PASS':'CONTROL_PASS_JAR_FAIL'):(j.outcome==='PASS'?'CONTROL_FAIL_JAR_PASS':'BOTH_FAIL');
    pair.confounded=!equalSet(jt,j.plan.selectedToolNames);
    if(['01-skill-routing','02-repository-context'].includes(task.task_id))pair.diagnostic=pair.confounded?'TREATMENT_CONFOUNDED':'M8_EXPOSURE_MATCHED';
    else if(task.task_id==='04-output-shadow')pair.diagnostic=pair.confounded?'M7_SHADOW_ONLY_WITH_M8_CHANGE':'M7_SHADOW_ONLY_NOT_CAUSAL';
    else if(task.task_id==='03-capability-exposure')pair.diagnostic=pair.confounded?'CAPABILITY_REDUCTION_OBSERVED':'NO_CAPABILITY_REDUCTION_OBSERVED';
    else pair.diagnostic='M5_M6_M8_ACTIVE_M7_SHADOW';
    // Efficiency ratios are intentionally suppressed unless BOTH runs are correct.
    if(pair.functional==='BOTH_PASS'){
      const ratio=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0?a/b:null;
      pair.ratios={wallClock:ratio(j.wallClockMs,c.wallClockMs),toolCalls:ratio(j.toolCalls,c.toolCalls)};
    }
    return pair;
  });
}
const esc=x=>String(x??'—').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const fmt=x=>typeof x==='number'?(x/1000).toFixed(2)+' s':'—';
export function renderReport(s) {
  const pairs=s.pairs??[],runs=s.runs??[];
  const n=runs.filter(r=>['PASS','FAIL'].includes(r.outcome)).length;
  const rows=pairs.map(p=>`<tr><td><strong>${esc(p.task_id)}</strong><small>${esc(p.focus)}</small></td><td>${badge(p.control?.outcome??'NOT_RUN')}<small>${fmt(p.control?.wallClockMs)}</small></td><td>${badge(p.jar?.outcome??'NOT_RUN')}<small>${fmt(p.jar?.wallClockMs)}</small></td><td>${esc(p.functional)}<small>${esc(p.diagnostic??'Not enough evidence')}</small></td><td>${p.ratios?.wallClock!=null?p.ratios.wallClock.toFixed(2)+'×':'—'}</td></tr>`).join('');
  const evidence=runs.map(r=>`<details><summary>${esc(r.task_id)} / ${esc(r.condition)} — ${esc(r.outcome)}</summary><p>${r.evidencePath?`Evidence folder: <code>${esc(r.evidencePath)}</code>`:''}</p><pre>${esc(JSON.stringify(r,null,2))}</pre></details>`).join('');
  const health={infrastructure:s.error?'FAIL':'PASS',controlJarIsolation:pairs.every(p=>p.functional!=='PAIR_IDENTITY_MISMATCH')?'PASS':'FAIL',
    jevLivePath:runs.some(r=>r.condition==='JAR'&&r.jevUsage?.calls>0)?'PASS':runs.length?'FAIL':'NOT_RUN',modelAuth:s.modelSelection?'PASS':'NOT_RUN',
    sandboxLifecycle:runs.every(r=>r.outcome==='INFRA_FAIL'||r.postIdle?.sandboxSessionCount===0)?'PASS':'FAIL',verifierIsolation:runs.every(r=>r.verifier?.modelHadVerifierAccess!==true)?'PASS':'FAIL'};
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JAR Integrated Smoke Benchmark — ${esc(s.status)}</title>
<style>:root{font-family:Segoe UI,Arial,sans-serif;color:#152137;background:#f4f6f9}body{max-width:1180px;margin:0 auto;padding:36px 24px}h1{font-size:32px;margin:8px 0}header{border-bottom:2px solid #152137;padding-bottom:22px}.eyebrow{font-size:13px;letter-spacing:2px;text-transform:uppercase}section{background:white;border:1px solid #dce2e9;border-radius:10px;padding:22px;margin:20px 0}.status{font-size:23px;font-weight:700;margin:14px 0}p{line-height:1.55}.meta{color:#526071}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-size:12px;text-transform:uppercase;color:#526071;border-bottom:2px solid #dce2e9}th,td{padding:13px 10px;vertical-align:top}td{border-bottom:1px solid #e6eaf0}small{display:block;line-height:1.5;color:#526071;font-size:12px;margin-top:5px}.badge{padding:3px 7px;border-radius:4px;background:#e9edf2;white-space:nowrap}.PASS{background:#d6f2e5;color:#064f33}.FAIL{background:#fff0d1;color:#684100}.INFRA_FAIL{background:#ffe0df;color:#8d211d}pre{background:#f4f6f9;white-space:pre-wrap;overflow-wrap:anywhere;padding:15px;font-size:12px;line-height:1.45}code{overflow-wrap:anywhere}details{margin:12px 0;border-top:1px solid #dce2e9;padding-top:14px}summary{cursor:pointer;font-weight:600}.error{border-left:5px solid #b72e26}.table{overflow-x:auto}a{color:#245dbc}@media print{body{padding:0}details{display:block}section{break-inside:avoid}}</style>
<header><div class="eyebrow">JEV Agentic Router · integrated engineering evaluation</div><h1>${esc(s.runLabel??'JAR Integrated Smoke Benchmark')}</h1><div class="status">${esc(s.status)} · ${n}/${s.targetConditions??10} verified conditions</div><p class="meta">${esc(s.startedAt)} · Run: ${esc(s.runId??'legacy')} · Mode: ${esc(s.executionMode??'automatic')} · Model: ${esc(s.model??'not resolved')}</p></header>
<section><h2>Smoke health</h2><div class="table"><table><tbody>${Object.entries(health).map(([name,value])=>`<tr><th>${esc(name)}</th><td>${badge(value)}</td></tr>`).join('')}</tbody></table></div><p class="meta">Functional model failures appear below as benchmark outcomes; they do not turn healthy infrastructure into a harness failure.</p></section>
${s.modelSelection?`<section><h2>Selected model</h2><p><strong>${esc(s.model)} / ${esc(s.effort)}</strong>. Selected from the authenticated account catalog. Native tool boundaries were observed using local loopback, not real inference. No extra inference probe: the first benchmark turn checks live model access; Sandbox starts only at its first authorized tool call.</p></section>`:''}
${s.error?`<section class="error"><h2>Stopped — no further model runs were started</h2><pre>${esc(JSON.stringify(s.error,null,2))}</pre><p>See <code>run.log</code> and the condition's <code>events.jsonl</code>. This is not a loss for CONTROL or JAR.</p></section>`:''}
<section><h2>Benchmark outcomes</h2><div class="table"><table><thead><tr><th>Task</th><th>Control</th><th>JAR</th><th>Interpretation</th><th>Wall J/C*</th></tr></thead><tbody>${rows}</tbody></table></div><p class="meta">* Ratios only when both conditions pass and pair identity matches. One observation per condition: descriptive diagnostic, not statistical proof.</p></section>
<section><h2>Experimental boundaries</h2><p>M8 uses real TypeSafe/JEV; there is no mock or all-visible fallback in JAR. M7 remains <strong>shadow-only</strong> and exact passthrough, so no causal output-filtering claim is made.</p><p>Task 01/02 attribution is marked confounded whenever capability exposure differs. Token and timing fields remain unavailable when the runtime does not expose them.</p></section>
<section><h2>Condition evidence</h2>${evidence||'<p>No model condition has been started.</p>'}</section>
<section><details><summary>Preflight and reproducibility</summary><pre>${esc(JSON.stringify({modelSelection:s.modelSelection,readiness:s.readiness,preflight:s.preflight,fixtureCalibration:s.fixtureCalibration,benchmarkSourceHash:s.benchmarkSourceHash,repoHash:s.repoHash,git:s.git,m7:s.m7},null,2))}</pre></details></section></html>`;
}
function badge(x){return `<span class="badge ${esc(x)}">${esc(x)}</span>`;}
export function publish(runDir,results,s) {
  atomic(path.join(runDir,'SUMMARY.json'),s);atomic(path.join(runDir,'RESULT.html'),renderReport(s),true);
  const latest=path.join(results,'LATEST');fs.rmSync(latest,{recursive:true,force:true});fs.mkdirSync(latest,{recursive:true});
  atomic(path.join(latest,'SUMMARY.json'),s);atomic(path.join(latest,'RESULT.html'),renderReport(s),true);
  const log=path.join(runDir,'run.log');atomic(path.join(latest,'run.log'),fs.existsSync(log)?fs.readFileSync(log,'utf8'):'No log entries yet.\n',true);
}
