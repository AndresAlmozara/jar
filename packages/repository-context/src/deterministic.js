import { LexicalCandidateGenerator } from "./candidates.js";
import { positiveLimit } from "./contracts.js";
import { contextProposal, repositoryProblem, validateContextCandidates } from "./common.js";
import { contextInvocation } from "./invocation.js";

export class DeterministicContextStrategy {
  constructor({candidateGenerator=new LexicalCandidateGenerator(),outputLimit=5}={}) {this.id="context/deterministic-v1";this.generator=candidateGenerator;this.outputLimit=positiveLimit(outputLimit,"outputLimit")}
  async route(input) {
    const started=performance.now();
    const provenance={invocation:contextInvocation(this.id,input),outputLimit:this.outputLimit,decisionCalls:{attempted:0,settled:0,failed:0}};
    const finish=fields=>contextProposal(this.id,input,{...fields,provenance:{...provenance,...fields.provenance},latencyMs:performance.now()-started});
    const problem=repositoryProblem(input.repository);if(problem)return finish(problem);
    try {
      const generated=await this.generator.generate(input);validateContextCandidates(generated.candidates,input.repository);
      const selected=generated.candidates.slice(0,this.outputLimit);
      return finish({outcome:selected.length?"selected":"no_decision",reason:selected.length?"deterministic_retrieval":"retrieval_empty",candidates:generated.candidates,selectedCandidateIds:selected.map(c=>c.id),provenance:{retrieval:generated.evidence,outputLimit:this.outputLimit,decisionCalls:{attempted:0,settled:0,failed:0}}});
    } catch(error) {return finish({outcome:"error",reason:"candidate_generation_failed",error:{code:error.code??"candidate_generation_failed"}})}
  }
}
