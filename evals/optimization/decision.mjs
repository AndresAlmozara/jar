import {createHash} from 'node:crypto';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const pct=(candidate,reference)=>finite(candidate)&&finite(reference)&&reference>0?(candidate-reference)/reference*100:null;
const fail=(code,details={})=>({status:'BLOCKED',code,details});

export function usageFromSnapshots(snapshots=[]){
  const rows=snapshots.filter(row=>row&&typeof row==='object'&&row.total&&finite(row.total.totalTokens));
  if(!rows.length)return null;
  const byTurn=new Map();
  for(const row of rows){
    const key=`${row.threadId??''}:${row.turnId??''}`;
    const prior=byTurn.get(key);
    if(!prior||row.total.totalTokens>=prior.total.totalTokens)byTurn.set(key,row);
  }
  if(byTurn.size!==1)throw Object.assign(new Error('Multiple usage streams are not comparable'),{code:'USAGE_STREAM_AMBIGUOUS'});
  const total=[...byTurn.values()][0].total;
  return {totalTokens:total.totalTokens,inputTokens:total.inputTokens,cachedInputTokens:total.cachedInputTokens,
    outputTokens:total.outputTokens,reasoningOutputTokens:total.reasoningOutputTokens};
}

export function estimatedCreditEquivalent(usage,pricing){
  if(!usage||!finite(usage.inputTokens)||!finite(usage.cachedInputTokens)||!finite(usage.outputTokens))return null;
  if(usage.cachedInputTokens<0||usage.cachedInputTokens>usage.inputTokens)return null;
  const uncached=usage.inputTokens-usage.cachedInputTokens;
  const credits=(uncached*pricing.uncachedInput+usage.cachedInputTokens*pricing.cachedInput+usage.outputTokens*pricing.output)/1_000_000;
  return {kind:'estimated_credit_equivalent',credits,uncachedInputTokens:uncached,cachedInputTokens:usage.cachedInputTokens,
    outputTokens:usage.outputTokens,reasoningAlreadyIncludedInOutput:true,pricing};
}

export function comparableElapsedMs(events,finishedAt){
  const stamped=events.filter(row=>row&&Number.isFinite(Date.parse(row.timestamp))&&finite(row.elapsed_ms));
  if(!stamped.length||!Number.isFinite(Date.parse(finishedAt)))return null;
  const starts=stamped.map(row=>Date.parse(row.timestamp)-row.elapsed_ms);
  const start=Math.min(...starts),spread=Math.max(...starts)-start,end=Date.parse(finishedAt);
  if(spread>1000||end<=start)return null;
  return {elapsedMs:end-start,startAt:new Date(start).toISOString(),finishedAt:new Date(end).toISOString(),
    derivation:'telemetry_clock_origin_to_iteration_finished_at',includes:['routing','main_turn','verification'],excludes:['calibration','dependency_installation']};
}

export function evidenceFingerprint(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}

function checksByName(run){return new Map((run.checks??[]).map(row=>[row.name,row]));}
function preservedChecks(incumbent,candidate){
  const current=checksByName(candidate),lost=[];
  for(const check of incumbent.checks??[])if(check.pass===true&&current.get(check.name)?.pass!==true)lost.push(check.name);
  return {pass:lost.length===0,lost};
}
function validRun(run,scenario){
  if(run?.scenario!==scenario)return fail('WRONG_PRODUCT_OR_SCENARIO',{expected:scenario,actual:run?.scenario??null});
  if(run.sessionStatus!=='completed'||run.infrastructureAnomaly===true)return fail('SESSION_INCOMPLETE_OR_ANOMALOUS');
  if(run.evaluationValid!==true||run.buildPass!==true||run.publicTestsPass!==true)return {status:'REJECTED',code:'FUNCTIONAL_GATE_FAILED'};
  if(run.compatible!==true)return fail('BASELINE_INCOMPATIBLE');
  if(run.mechanismObserved!==true)return fail('ACTIVE_MECHANISM_NOT_OBSERVED');
  if((run.policyViolations??[]).length)return {status:'REJECTED',code:'POLICY_VIOLATION',details:{violations:run.policyViolations}};
  if(scenario==='hard'&&run.correctness!=='CORRECT')return {status:'REJECTED',code:'HARD_NOT_CORRECT'};
  return null;
}

export function decidePromotion({goal,scenarios,budget,policy}){
  if(budget.exhausted===true)return {status:'CHECKPOINTED_BUDGET',code:'BUDGET_EXHAUSTED'};
  const metrics=[];
  for(const scenario of ['soft','hard']){
    const pair=scenarios?.[scenario];
    if(!pair?.incumbent||!pair?.candidate||!pair?.origin)return fail('MISSING_SCENARIO_EVIDENCE',{scenario});
    const gate=validRun(pair.candidate,scenario);if(gate)return gate;
    const preserved=preservedChecks(pair.incumbent,pair.candidate);
    if(!preserved.pass)return {status:'REJECTED',code:'PROTECTED_CHECK_REGRESSION',details:{scenario,lost:preserved.lost}};
    for(const label of ['incumbent','candidate','origin'])if(!finite(pair[label].elapsedMs)||!finite(pair[label].credits))return fail('MISSING_COMPARABLE_EFFICIENCY_EVIDENCE',{scenario,label});
    metrics.push({scenario,creditVsIncumbent:pct(pair.candidate.credits,pair.incumbent.credits),
      latencyVsIncumbent:pct(pair.candidate.elapsedMs,pair.incumbent.elapsedMs),creditVsOrigin:pct(pair.candidate.credits,pair.origin.credits),
      latencyVsOrigin:pct(pair.candidate.elapsedMs,pair.origin.elapsedMs),latencySecondsSaved:(pair.incumbent.elapsedMs-pair.candidate.elapsedMs)/1000,
      jevUsd:pair.candidate.jevUsd});
  }
  if(metrics.some(row=>row.jevUsd>policy.maxAdditionalJevUsdPerScenarioRun))return {status:'REJECTED',code:'JEV_RUN_COST_LIMIT'};
  if(metrics.some(row=>row.creditVsOrigin>policy.maxCumulativeRegressionPercent||row.latencyVsOrigin>policy.maxCumulativeRegressionPercent))
    return {status:'REJECTED',code:'CUMULATIVE_ORIGIN_REGRESSION',metrics};
  let pass=false;
  if(goal.type==='CORRECTNESS_ROBUSTNESS'){
    if(goal.independentRegression?.incumbentFails!==true||goal.independentRegression?.candidatePasses!==true)
      return {status:'REJECTED',code:'INDEPENDENT_REGRESSION_NOT_PROVEN',metrics};
    pass=metrics.every(row=>row.creditVsIncumbent<=5&&row.latencyVsIncumbent<=5);
  }else if(goal.type==='CREDIT'){
    pass=metrics.some(row=>row.creditVsIncumbent<=-5)&&metrics.every(row=>row.creditVsIncumbent<=3&&row.latencyVsIncumbent<=5);
  }else if(goal.type==='LATENCY'){
    pass=metrics.some(row=>row.latencyVsIncumbent<=-5&&row.latencySecondsSaved>=30)&&metrics.every(row=>row.latencyVsIncumbent<=3&&row.creditVsIncumbent<=3);
  }else return fail('UNKNOWN_GOAL');
  return pass?{status:'ACCEPTED_DEV_LIMITED_EVIDENCE',code:'POLICY_SATISFIED',metrics}:
    {status:'INCONCLUSIVE',code:'THRESHOLD_NOT_MET',metrics};
}
