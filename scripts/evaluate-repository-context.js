import { loadContextEvaluation, runContextEvaluation, stableContextEvaluation } from "../packages/evals/src/repository-context.js";
import { sha256 } from "../packages/core/src/hash.js";

const report=await runContextEvaluation({dataset:await loadContextEvaluation()});
report.replay_digest=sha256(stableContextEvaluation(report));
console.log(JSON.stringify(report,null,2));
if(report.rows.some(r=>r.operational.provider_errors||r.operational.strategy_errors))process.exitCode=2;
