import { newId } from "../../core/src/ids.js";

export function createSkillInvocation(strategy,input) {
  return Object.freeze({
    invocation_id:input.decisionContext?.invocation_id??newId("invocation"),
    caller:strategy,
    component:"skills",
    session_id:input.session?.sessionId??input.runtime?.sessionId??null,
  });
}

// Local to one route call; composed stages share this engine, never mutable instance state.
export async function withSkillInvocation(strategy,input,decisionEngine,run) {
  const context=createSkillInvocation(strategy,input);
  const counts={attempted:0,settled:0,failed:0};
  const engine={};
  for (const primitive of ["choice","noul","score"]) {
    engine[primitive]=async (request)=>{
      const decisionContext={
        ...context,
        operation:request.decisionContext?.operation??primitive,
        operation_id:request.decisionContext?.operation_id??null,
        call_id:newId("call"),
      };
      counts.attempted++;
      try { return await decisionEngine[primitive]({...request,decisionContext}); }
      catch (error) { counts.failed++; throw error; }
      finally { counts.settled++; }
    };
  }
  const proposal=await run(engine);
  proposal.decision.provenance={
    ...proposal.decision.provenance,
    invocation:context,
    decisionCalls:{...counts},
    jevCallCount:counts.attempted,
  };
  return proposal;
}
