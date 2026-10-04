import { newId } from "../../core/src/ids.js";

export function contextInvocation(strategy,input) {
  return Object.freeze({invocation_id:input.decisionContext?.invocation_id??newId("invocation"),caller:strategy,
    component:"repository_context",session_id:input.session?.sessionId??input.runtime?.sessionId??null});
}
