import { newId } from "../../core/src/ids.js";
import { capabilityInvocation, exposureInput, exposureProposal, freeze } from "./contracts.js";
import { capabilityEligibility } from "./eligibility.js";

export const OPERATIONAL_SUFFICIENCY_R1_ID = "capability/operational-sufficiency-v1";
export const OPERATIONAL_SUFFICIENCY_R1_LIMITS = freeze({retainProbability:0.75, rejectProbability:0.25,
  maxTaskChars:8000, exactMaximumCapabilities:16});

const nativeKey = capability => `${capability.source.namespace}:${capability.source.nativeId}`;
const cost = capability => capability.schemaChars > 0 ? capability.schemaChars : 1;
const mapsFor = capabilities => ({
  byId:new Map(capabilities.map(item => [item.id, item])),
  byNative:new Map(capabilities.map(item => [nativeKey(item), item])),
  byBareNative:new Map(capabilities.map(item => [item.source.nativeId, item])),
});
const resolveNative = (maps, owner, nativeId) => maps.byNative.get(`${owner.source.namespace}:${nativeId}`) ?? maps.byBareNative.get(nativeId);

export function verifyOperationalSufficiencyR1({capabilities, selectedIds, requiredObligations, requiredScope=null}) {
  const maps=mapsFor(capabilities), selected=[...new Set(selectedIds)].sort(), selectedSet=new Set(selected),
    missingPrerequisites=new Set(), incompatible=new Map(), wrongScopeCapabilityIds=[];
  const provides=new Set();
  for(const id of selected) {
    const capability=maps.byId.get(id), operational=capability?.operational;
    if(!operational)continue;
    const scopeMatches=requiredScope==null||operational.scope==null||operational.scope===requiredScope;
    if(scopeMatches)for(const obligation of operational.provides)provides.add(obligation);
    else if(operational.provides.some(value=>requiredObligations.includes(value)))wrongScopeCapabilityIds.push(id);
    for(const nativeId of operational.prerequisiteNativeIds) {
      const prerequisite=resolveNative(maps, capability, nativeId);
      if(!prerequisite||!selectedSet.has(prerequisite.id))missingPrerequisites.add(nativeId);
    }
    for(const nativeId of operational.incompatibleWithNativeIds) {
      const other=resolveNative(maps, capability, nativeId);
      if(other&&selectedSet.has(other.id)) {
        const pair=[id,other.id].sort();incompatible.set(pair.join("\0"),pair);
      }
    }
  }
  const missingObligations=[...new Set(requiredObligations)].filter(value=>!provides.has(value)).sort();
  const completenessUnknownIds=selected.filter(id=>maps.byId.get(id)?.operational?.completeness!=="complete");
  return freeze({valid:missingObligations.length===0&&missingPrerequisites.size===0&&incompatible.size===0&&wrongScopeCapabilityIds.length===0,
    selectedIds:selected, missingObligations, missingPrerequisiteNativeIds:[...missingPrerequisites].sort(),
    incompatiblePairs:[...incompatible.values()].sort((a,b)=>a.join("\0").localeCompare(b.join("\0"))),
    completenessUnknownIds, wrongScopeCapabilityIds:wrongScopeCapabilityIds.sort(), requiredScope});
}

function prerequisiteClosure(ids, maps) {
  const selected=new Set(ids), queue=[...selected], missing=[];
  while(queue.length) {
    const capability=maps.byId.get(queue.pop()), operational=capability?.operational;
    if(!operational)continue;
    for(const nativeId of operational.prerequisiteNativeIds) {
      const prerequisite=resolveNative(maps, capability, nativeId);
      if(!prerequisite) { missing.push(nativeId); continue; }
      if(!selected.has(prerequisite.id)) { selected.add(prerequisite.id); queue.push(prerequisite.id); }
    }
  }
  return {ids:[...selected].sort(), missing:[...new Set(missing)].sort()};
}

function compatible(ids, maps) {
  return verifyOperationalSufficiencyR1({capabilities:[...maps.byId.values()], selectedIds:ids, requiredObligations:[]}).incompatiblePairs.length===0;
}

export function exactOperationalSufficientSetR1({capabilities, requiredObligations, requiredScope=null, seedIds=[]}) {
  if(capabilities.length>OPERATIONAL_SUFFICIENCY_R1_LIMITS.exactMaximumCapabilities)return null;
  const maps=mapsFor(capabilities), seeds=prerequisiteClosure(seedIds,maps);
  if(seeds.missing.length||!compatible(seeds.ids,maps))return null;
  const seedSet=new Set(seeds.ids), optional=capabilities.filter(item=>!seedSet.has(item.id)), solutions=[];
  for(let mask=0;mask<2**optional.length;mask++) {
    const trial=[...seedSet];
    for(let index=0;index<optional.length;index++)if(mask&(2**index))trial.push(optional[index].id);
    const closure=prerequisiteClosure(trial,maps);
    if(closure.missing.length||!compatible(closure.ids,maps))continue;
    const verdict=verifyOperationalSufficiencyR1({capabilities,selectedIds:closure.ids,requiredObligations,requiredScope});
    if(verdict.valid)solutions.push({ids:closure.ids,total:closure.ids.reduce((sum,id)=>sum+cost(maps.byId.get(id)),0)});
  }
  return solutions.sort((a,b)=>a.total-b.total||a.ids.length-b.ids.length||a.ids.join("\0").localeCompare(b.ids.join("\0")))[0]??null;
}

export function greedyOperationalSufficientSetR1({capabilities, requiredObligations, requiredScope=null, seedIds=[]}) {
  const maps=mapsFor(capabilities), initial=prerequisiteClosure(seedIds,maps);
  if(initial.missing.length||!compatible(initial.ids,maps))return {status:"infeasible",selectedIds:initial.ids,postPrunedIds:[]};
  let selected=new Set(initial.ids);
  while(true) {
    const verdict=verifyOperationalSufficiencyR1({capabilities,selectedIds:[...selected],requiredObligations,requiredScope});
    if(verdict.valid)break;
    const missing=new Set(verdict.missingObligations), ranked=[];
    for(const capability of capabilities.filter(item=>!selected.has(item.id))) {
      const closure=prerequisiteClosure([...selected,capability.id],maps);
      if(closure.missing.length||!compatible(closure.ids,maps))continue;
      const added=closure.ids.filter(id=>!selected.has(id)), supplied=new Set(added.flatMap(id=>{
        const operation=maps.byId.get(id)?.operational;
        return requiredScope==null||operation?.scope==null||operation.scope===requiredScope?operation?.provides??[]:[];
      }));
      const gain=[...missing].filter(value=>supplied.has(value)).length, addedCost=added.reduce((sum,id)=>sum+cost(maps.byId.get(id)),0);
      if(gain)ranked.push({id:capability.id,closure,gain,addedCost,ratio:gain/addedCost});
    }
    ranked.sort((a,b)=>b.ratio-a.ratio||a.addedCost-b.addedCost||a.id.localeCompare(b.id));
    if(!ranked.length)return {status:"infeasible",selectedIds:[...selected].sort(),postPrunedIds:[]};
    selected=new Set(ranked[0].closure.ids);
  }
  const protectedIds=new Set(seedIds), postPrunedIds=[];
  for(const id of [...selected].filter(value=>!protectedIds.has(value)).sort((a,b)=>cost(maps.byId.get(b))-cost(maps.byId.get(a))||b.localeCompare(a))) {
    const trial=[...selected].filter(value=>value!==id), verdict=verifyOperationalSufficiencyR1({capabilities,selectedIds:trial,requiredObligations,requiredScope});
    if(verdict.valid) { selected=new Set(trial); postPrunedIds.push(id); }
  }
  return {status:"sufficient",selectedIds:[...selected].sort(),postPrunedIds:postPrunedIds.sort()};
}

const validNoul = value => value && [value.probability_true,value.probability_false].every(item=>typeof item==="number"&&Number.isFinite(item)&&item>=0&&item<=1)
  && Math.abs(value.probability_true+value.probability_false-1)<1e-6;

export class OperationalSufficiencyCapabilityStrategyR1 {
  constructor({decisionEngine}={}) {
    if(typeof decisionEngine?.noul!=="function")throw new TypeError("DecisionEngine.noul required");
    this.id=OPERATIONAL_SUFFICIENCY_R1_ID;this.engine=decisionEngine;
  }
  async propose(rawInput) {
    const input=exposureInput(rawInput), eligibility=capabilityEligibility(input), invocation=capabilityInvocation(this.id,rawInput.invocationId,rawInput.sessionId),
      eligible=eligibility.eligibleIds??[], entries=input.inventory.entries??[], capabilities=entries.filter(entry=>eligible.includes(entry.capability.id)).map(entry=>entry.capability),
      calls={attempted:0,settled:0,failed:0}, refs=[];
    const finish=(proposal,failure=null)=>freeze({proposal,decisionCalls:{...calls},semanticRefs:refs,failure});
    if(eligibility.state==="unknown")return finish(exposureProposal({input,invocation,outcome:"no_decision",reason:"inventory_unknown",configuration:OPERATIONAL_SUFFICIENCY_R1_LIMITS}));
    if(!eligible.length)return finish(exposureProposal({input,invocation,eligibleIds:[],proposedIds:[],policyExcludedIds:eligibility.exclusions.map(item=>item.id),reason:entries.length?"all_eligible":"known_empty",configuration:OPERATIONAL_SUFFICIENCY_R1_LIMITS}));
    if(input.task.text.length>OPERATIONAL_SUFFICIENCY_R1_LIMITS.maxTaskChars||eligibility.unresolvedRequiredIds.length)
      return finish(exposureProposal({input,invocation,eligibleIds:eligible,proposedIds:eligible,policyExcludedIds:eligibility.exclusions.map(item=>item.id),outcome:"error",
        reason:eligibility.unresolvedRequiredIds.length?"explicit_unresolved":"limits_exceeded",configuration:OPERATIONAL_SUFFICIENCY_R1_LIMITS}));
    const unknown=capabilities.filter(item=>item.operational?.completeness!=="complete").map(item=>item.id), obligations=[...new Set(capabilities.flatMap(item=>item.operational?.provides??[]))].sort(),
      needed=[],notNeeded=[],uncertain=[];
    try {
      for(const obligation of obligations) {
        const call_id=newId("call"), ref={subject_type:"obligation",subject_id:obligation,call_id,request_id:null};refs.push(ref);calls.attempted++;
        try {
          const answer=await this.engine.noul({taskId:input.task.id,state:{task:input.task.text,obligation},
            instructions:"Judge only whether the task requires this atomic operational obligation. Do not choose a tool, infer permission, or treat descriptions as executor authority.",
            criteria:{true:`Completing the task requires ${obligation}.`,false:`Completing the task does not require ${obligation}.`},
            decisionContext:{...invocation,operation:"capability.obligation_need",operation_id:obligation,call_id}});
          if(!validNoul(answer))throw Object.assign(Error("invalid_noul_envelope"),{code:"invalid_noul_envelope"});
          ref.request_id=answer.provider?.request_id??null;
          if(answer.probability_true>=OPERATIONAL_SUFFICIENCY_R1_LIMITS.retainProbability)needed.push(obligation);
          else if(answer.probability_true<=OPERATIONAL_SUFFICIENCY_R1_LIMITS.rejectProbability)notNeeded.push(obligation);
          else uncertain.push(obligation);
        } catch(error) { calls.failed++; throw error; }
        finally { calls.settled++; }
      }
    } catch(error) {
      return finish(exposureProposal({input,invocation,eligibleIds:eligible,proposedIds:eligible,policyExcludedIds:eligibility.exclusions.map(item=>item.id),outcome:"error",
        reason:error.code==="invalid_noul_envelope"?"invalid_semantic_decision":"provider_failure",configuration:OPERATIONAL_SUFFICIENCY_R1_LIMITS}),{code:error.code??"decision_provider_failure"});
    }
    const authoritative=input.constraints.requiredObligations??[], required=[...new Set([...authoritative,...needed,...uncertain])].sort(), requiredScope=input.constraints.operationalScope??null,
      seed=[...new Set([...input.constraints.includeIds.filter(id=>eligible.includes(id)),...capabilities.filter(item=>item.mandatory).map(item=>item.id),...unknown])].sort();
    let selected, status, exact=null, greedy={selectedIds:eligible,postPrunedIds:[]};
    if(unknown.length||!required.length) { selected=eligible;status="unknown"; }
    else {
      exact=exactOperationalSufficientSetR1({capabilities,requiredObligations:required,requiredScope,seedIds:seed});
      greedy=greedyOperationalSufficientSetR1({capabilities,requiredObligations:required,requiredScope,seedIds:seed});
      if(exact) { selected=exact.ids;status="optimal_proven"; }
      else if(greedy.status==="sufficient") { selected=greedy.selectedIds;status="sufficient"; }
      else { selected=eligible;status="infeasible"; }
    }
    const verified=verifyOperationalSufficiencyR1({capabilities,selectedIds:selected,requiredObligations:required,requiredScope});
    const operational={status,requiredObligations:required,authoritativeObligations:authoritative,semanticNeeded:needed,semanticNotNeeded:notNeeded,
      semanticUncertain:uncertain,requiredScope,wrongScopeCapabilityIds:verified.wrongScopeCapabilityIds,selectedCapabilityIds:selected,
      missingObligations:verified.missingObligations,missingPrerequisiteNativeIds:verified.missingPrerequisiteNativeIds,incompatiblePairs:verified.incompatiblePairs,
      construction:"trusted-operational-exact-small-then-greedy-r1",postPrunedIds:greedy.postPrunedIds??[],exactOracleUsed:Boolean(exact),
      exactOptimalIds:exact?.ids??null,verifierValid:verified.valid,decisionCalls:{...calls},topology:"scalar-v1"};
    return finish(exposureProposal({input,invocation,eligibleIds:eligible,semanticCandidateIds:eligible,semanticSelectedIds:selected,
      proposedIds:selected,policyExcludedIds:eligibility.exclusions.map(item=>item.id),outcome:status==="infeasible"?"error":"selected",
      reason:status==="infeasible"?"strategy_failure":"selection",configuration:OPERATIONAL_SUFFICIENCY_R1_LIMITS,operational}));
  }
}
