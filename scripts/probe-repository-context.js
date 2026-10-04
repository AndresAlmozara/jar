import { LocalRepositoryAdapter, OkoContextStrategy } from "../packages/repository-context/src/index.js";
const repository=await new LocalRepositoryAdapter(process.argv[2]??process.cwd()).snapshot();
const task={id:"context-offline-probe",text:"Find the files responsible for TypeSafe/JEV decision attribution and strategy correlation."};
const strategy=new OkoContextStrategy({decisionEngine:{noul:async()=>({probability_true:0.8,probability_false:0.2})}});
const proposal=await strategy.route({task,repository});
const p=proposal.decision.provenance;
console.log(JSON.stringify({mode:"offline-synthetic",repository:repository.id,outcome:proposal.decision.outcome,reason:proposal.decision.reason,discovered:repository.discoveredCount,generated:p.generatedCandidateCount,limits:p.limits,
  shortlist:proposal.candidates.filter(c=>p.shortlist?.includes(c.id)).map(c=>c.path),selected:proposal.decision.selectedCandidateIds.map(id=>proposal.candidates.find(c=>c.id===id).path),latency_ms:proposal.decision.latencyMs,decision_calls:p.decisionCalls},null,2));
if(proposal.decision.outcome==="error"||proposal.decision.outcome==="unsupported")process.exitCode=2;
