import { assertTaskSnapshot } from "../../core/src/contracts.js";
import { newId } from "../../core/src/ids.js";
import { sha256 } from "../../core/src/hash.js";
import { contextProposal, validateContextCandidates } from "./common.js";
import { contextInvocation } from "./invocation.js";

/** One captured logical input, cloned per sequential arm; local retrieval may
 * reread files. This is NOT a content-atomic capture. Strategies must settle all
 * owned work before route settles. No runtime adapter or promotion policy.
 * Provider events join invocation_id -> result -> tournament_run_id.
 * Unknown evidence/counts on uncaught failures is null, never invented zero.
 */
export const CONTEXT_SHADOW_VERSION="context.shadow.v1";
export function contextConfiguration(strategy) {
  const g=strategy.generator;
  return {limits:strategy.limits?{...strategy.limits}:{outputLimit:strategy.outputLimit??null},threshold:strategy.threshold??null,
    retrieval:{candidateLimit:g?.candidateLimit??null,maxFileBytes:g?.maxFileBytes??null,maxTotalBytes:g?.maxTotalBytes??null,
      excerptChars:g?.excerptChars??null,method:g?.constructor?.name==="LexicalCandidateGenerator"?"path-content-token-v1":"custom"}};
}
function assertProposal(p,input,id,invocation) {
  const d=p?.decision,provenance=d?.provenance;
  validateContextCandidates(p?.candidates,input.repository);
  const ids=new Set(p.candidates.map(c=>c.id));
  const subset=values=>Array.isArray(values)&&new Set(values).size===values.length&&values.every(v=>ids.has(v));
  const calls=provenance?.decisionCalls;
  if(p.taskId!==input.task.id||p.strategy!==id||p.component!=="repository_context"||p.provider?.kind!=="shadow"
      ||!["selected","no_context","no_decision","error","unsupported"].includes(d?.outcome)
      ||!subset(d?.selectedCandidateIds)||(d.outcome==="selected"?d.selectedCandidateIds.length===0:d.selectedCandidateIds.length!==0)
      ||provenance?.repository?.id!==input.repository.id||provenance.repository.repositoryId!==input.repository.repositoryId
      ||provenance?.invocation?.invocation_id!==invocation.invocation_id||provenance.invocation.caller!==id
      ||(provenance.shortlist!==undefined&&!subset(provenance.shortlist))
      ||!calls||![calls.attempted,calls.settled,calls.failed].every(n=>Number.isSafeInteger(n)&&n>=0)
      ||calls.attempted!==calls.settled||calls.failed>calls.settled)throw new TypeError("Invalid context proposal");
}
const failureStages={repository_unavailable:"repository",repository_discovery_failed:"repository",candidate_generation_failed:"retrieval",
  provider_failure:"provider",invalid_semantic_decision:"semantic_validation",strategy_execution_failure:"execution",strategy_invalid_proposal:"normalization"};

// Deliberate allowlist: no excerpts, raw task, provider payloads or arbitrary errors.
export function contextArmSummary(arm,repository) {
  const {decision:d,candidates}=arm.proposal,p=d.provenance;
  const retrieved=p.retrieval!==undefined;
  const shortlist=p.shortlist??(arm.strategy_id==="context/deterministic-v1"?[]:null);
  return {strategy_id:arm.strategy_id,strategy_version:arm.strategy_version,invocation_id:arm.invocation_id,
    repository_id:repository.repositoryId,repository_snapshot_id:repository.id,
    discovered_file_count:repository.discoveredCount??null,observable_file_count:repository.files.length,
    discovery_truncated:repository.discoveryTruncated??null,configuration:arm.configuration,
    candidates:candidates.map(c=>({id:c.id,path:c.path,source_hash:c.sourceHash??null})),
    generated_candidate_count:retrieved?(p.generatedCandidateCount??candidates.length):null,
    retained_candidate_count:retrieved?candidates.length:null,
    retrieval_method:retrieved?arm.configuration.retrieval.method:null,
    retrieval:retrieved?{matched_count:p.retrieval.matchedCount??null,read_files:p.retrieval.readFiles??null,read_bytes:p.retrieval.readBytes??null,limits:p.retrieval.limits??null}:null,
    shortlist_ids:shortlist,shortlist_count:shortlist?.length??null,
    selected_candidate_ids:d.selectedCandidateIds,selected_count:d.selectedCandidateIds.length,
    outcome:d.outcome,reason:d.reason,failure_stage:failureStages[d.reason]??null,
    decision_calls:p.decisionCalls??null,latency_ms:arm.latency_ms,
    semantic_call_refs:(p.semantic??[]).map(e=>({candidate_id:e.candidateId,call_id:e.call_id,request_id:e.request_id})),
    error:d.error?{code:d.error.code??"strategy_error"}:null};
}

export class ContextShadowTournament {
  constructor({onTelemetry=null}={}) {this.onTelemetry=onTelemetry;}
  async run({task,repository,runtime,session,strategies}) {
    assertTaskSnapshot(task);
    if(!repository||typeof repository.id!=="string"||typeof repository.repositoryId!=="string"||!Array.isArray(repository.files)
        ||repository.files.some(p=>typeof p!=="string")||new Set(repository.files).size!==repository.files.length)throw new TypeError("RepositorySnapshot required");
    if(!Array.isArray(strategies)||!strategies.length||strategies.some(s=>!s||typeof s.id!=="string"||!s.id||typeof s.route!=="function")
        ||new Set(strategies.map(s=>s.id)).size!==strategies.length)throw new TypeError("Unique ordered context strategies required");
    const snapshot=structuredClone({task,repository,runtime,session});
    const arms=strategies.map(s=>({id:s.id,version:s.version??s.id.match(/-(v\d+)$/)?.[1]??null,configuration:contextConfiguration(s),route:s.route.bind(s)}));
    const result={version:CONTEXT_SHADOW_VERSION,tournament_run_id:newId("tournament"),task_id:task.id,
      session_id:session?.sessionId??runtime?.sessionId??null,repository_snapshot_id:repository.id,repository_id:repository.repositoryId,
      shadow:true,execution:"sequential",results:[]};
    for(const arm of arms) {
      const invocation=contextInvocation(arm.id,snapshot),started=performance.now();let returned=false,proposal;
      const entry={strategy_id:arm.id,strategy_version:arm.version,invocation_id:invocation.invocation_id,configuration:arm.configuration};
      const normalize=()=>{entry.latency_ms=performance.now()-started;entry.proposal=proposal;entry.summary=contextArmSummary(entry,snapshot.repository)};
      const input={...structuredClone(snapshot),decisionContext:invocation,tournamentRunId:result.tournament_run_id};
      try {
        proposal=await arm.route(input);returned=true;
        assertProposal(proposal,snapshot,arm.id,invocation);proposal=structuredClone(proposal);normalize();
      } catch {
        const reason=returned?"strategy_invalid_proposal":"strategy_execution_failure";
        proposal=contextProposal(arm.id,snapshot,{outcome:"error",reason,error:{code:reason},provenance:{invocation,decisionCalls:null}});
        normalize();
      }
      result.results.push(entry);
    }
    result.recording={status:this.onTelemetry?"complete":"disabled",errors:[]};
    const events=[{event_type:"context_shadow_run",task_id:result.task_id,tournament_run_id:result.tournament_run_id,
      version:result.version,shadow:true,execution:result.execution,session_id:result.session_id,
      repository_snapshot_id:result.repository_snapshot_id,repository_id:result.repository_id,task_hash:sha256(snapshot.task),
      runtime_hash:sha256(snapshot.runtime??null),strategies:result.results.map(a=>({strategy_id:a.strategy_id,invocation_id:a.invocation_id}))},
      ...result.results.map(a=>({event_type:"context_shadow_result",task_id:result.task_id,tournament_run_id:result.tournament_run_id,shadow:true,...a.summary}))];
    if(this.onTelemetry)for(const event of events)try{await this.onTelemetry(event)}catch{result.recording.status="incomplete";result.recording.errors.push({event_type:event.event_type,invocation_id:event.invocation_id??null})}
    return result;
  }
}
