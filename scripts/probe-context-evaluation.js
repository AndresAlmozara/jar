// Run once only, after offline verification. No discovery calls/retries/tuning.
import { loadContextEvaluation, runContextEvaluation } from "../packages/evals/src/repository-context.js";
import { JevDecisionEngine } from "../packages/decision-providers/jev/src/index.js";

if(!process.env.TYPESAFE_API_KEY){
  console.log(JSON.stringify({status:"LIVE_EVAL_PENDING",calls:0,reason:"TYPESAFE_API_KEY unavailable; no calls made"}));
} else {
  const dataset=await loadContextEvaluation(),config=dataset.config;
  const ids=config.liveCaseIds;
  if(ids.length>3||new Set(ids).size!==ids.length||ids.length*config.oko.shortlistSize>18||config.liveCallCeiling>18)throw new Error("Live budget invalid");
  const events=[];let calls=0;
  const provider=new JevDecisionEngine({onTelemetry:e=>events.push(e)});
  const engine={noul:async input=>{if(calls>=config.liveCallCeiling)throw new Error("Live budget exhausted");calls++;return provider.noul(input)}};
  const report=await runContextEvaluation({dataset,engine,mode:"live-sample",caseIds:ids});
  console.log(JSON.stringify({status:"LIVE_SAMPLE_COMPLETE",calls,report,provider_events:events},null,2));
  if(report.rows.some(r=>r.operational.provider_errors||r.operational.strategy_errors))process.exitCode=2;
}
