/**
 * RepositorySnapshot: {id,repositoryId,root,status,git:{commit,dirty,statusHash},
 * files:string[],discoveredCount,discoveryTruncated,error,capturedAt}.
 * IDs describe a root/Git/listing observation, NOT a content-atomic snapshot.
 * File candidates: {id,repositoryId,path,sourceHash,excerpt,retrieval:{...}}.
 * Candidate identity is root + normalized relative path; sourceHash identifies
 * the bounded, fully read file bytes. No symbol/range identity is claimed.
 * CandidateGenerator.generate({task,repository}) returns {candidates,evidence}.
 * Context strategies route({task,repository}) return generic RouteProposal with
 * component repository_context; decision owns selectedCandidateIds, outcome,
 * reason, confidence, provenance, error, latencyMs. Array order is rank order.
 * selected/no_context/no_decision/error/unsupported are local context outcomes:
 * no_context requires semantic rejection; empty retrieval is no_decision.
 * No generic core dependency on filesystem, Oko, rg, ECC or provider wire data.
 */
export const CONTEXT_VERSION="repository.context.v1";

export function positiveLimit(value,name) {
  if(!Number.isSafeInteger(value)||value<1)throw new TypeError(`${name} must be a positive integer`);
  return value;
}
