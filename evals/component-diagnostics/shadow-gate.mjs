import {sha256} from "../../packages/core/src/hash.js";

export const SHADOW_GATE_ID="m8-activation-shadow-v1";
export const SHADOW_GATE_CONTRACT=Object.freeze({
  permitted:["taskText","eligibleCapabilityContracts"],
  forbidden:["suiteId","conditionId","armId","benchmarkName","gold","outcomes","futureTrace"],
  behavior:"recommendation only; never changes prompts, exposure, order, or execution",
});

export function predictM8Mode({taskText,eligibleCapabilityContracts}){
  const started=performance.now(),input={taskText,eligibleCapabilityContracts:eligibleCapabilityContracts.map(item=>({nativeId:item.nativeId,provides:item.provides,scope:item.scope,completeness:item.completeness}))},
    incomplete=input.eligibleCapabilityContracts.some(item=>item.completeness!=="complete"||!item.scope),verbs=(taskText.toLowerCase().match(/\b(inspect|read|modify|write|execute|run|verify|test)\b/g)??[]).length,
    providers=new Map();
  for(const item of input.eligibleCapabilityContracts)for(const obligation of item.provides??[])providers.set(obligation,(providers.get(obligation)??0)+1);
  const redundant=[...providers.values()].filter(count=>count>1).length;
  let recommendation,reason;
  if(incomplete){recommendation="PRESERVE_INTEGRATION_BEHAVIOR";reason="UNKNOWN_OPERATIONAL_CONTRACT";}
  else if(verbs<2||redundant>0||input.eligibleCapabilityContracts.length>7){recommendation="OPERATIONAL_M8";reason=verbs<2?"LOW_OBSERVABLE_TASK_CLOSURE":"OBSERVED_INVENTORY_HEADROOM";}
  else{recommendation="LEAN_V1";reason="EXPLICIT_OBLIGATIONS_AND_LOW_HEADROOM";}
  return{schemaVersion:"jar.m8-shadow-gate.v1",gateId:SHADOW_GATE_ID,inputHash:sha256(input),recommendation,reason,proxies:{explicitOperationalVerbCount:verbs,redundantObligationCount:redundant,eligibleCount:input.eligibleCapabilityContracts.length},latencyMs:performance.now()-started,providerUsage:{attemptedRequests:0,inputTokens:0,outputTokens:0},causalEffect:false};
}
