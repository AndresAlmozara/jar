import { newId } from "../../core/src/ids.js";
import { sha256 } from "../../core/src/hash.js";
import { CONTEXT_VERSION } from "./contracts.js";

export function contextProposal(strategy,input,{outcome,reason,candidates=[],selectedCandidateIds=[],provenance={},error=null,latencyMs=0}) {
  return {id:newId("proposal"),taskId:input.task.id,component:"repository_context",strategy,candidates,
    decision:{outcome,reason,selectedCandidateIds,confidence:null,error,latencyMs,provenance:{version:CONTEXT_VERSION,repository:{id:input.repository.id,repositoryId:input.repository.repositoryId,git:input.repository.git??null},...provenance}},provider:{kind:"shadow"},createdAt:new Date().toISOString()};
}
export function repositoryProblem(repository) {
  if(repository.status==="unavailable")return {outcome:"unsupported",reason:"repository_unavailable"};
  if(repository.status!=="ready")return {outcome:"error",reason:"repository_discovery_failed",error:{code:repository.error?.code??"invalid_repository"}};
  return null;
}
export function validateContextCandidates(candidates,repository) {
  const ids=new Set();
  if(!Array.isArray(candidates))throw new TypeError("Invalid candidates");
  for(const c of candidates){
    if(!c||typeof c.id!=="string"||c.id!==sha256({repositoryId:repository.repositoryId,path:c.path})||ids.has(c.id)||c.repositoryId!==repository.repositoryId||!repository.files.includes(c.path)||typeof c.excerpt!=="string")throw new TypeError("Invalid candidate identity");
    ids.add(c.id);
  }
}
