import { DeterministicCapabilityStrategy } from '../../../capability-exposure/src/strategies.js';
import { JevHierarchicalCoverCapabilityStrategy } from '../../../capability-exposure/src/hierarchical-cover.js';
import { OperationalSufficiencyCapabilityStrategyR1 } from '../../../capability-exposure/src/operational-sufficiency-r1.js';
import { JevDecisionEngine } from '../../../decision-providers/jev/src/jev-decision-engine.js';
import { treatmentProfile } from '../../../core/src/treatments.js';

/** Explicit provider selection. Live constructs the existing provider but makes
 * no calls until propose() is invoked. Never silently substitute a mock engine.
 * Network-disabled Sandbox CLI supports deterministic and mock only.
 */
export function createAssistStrategy({provider='deterministic',telemetry,client,treatment='v1'}={}){
  if(provider==='deterministic')return new DeterministicCapabilityStrategy();
  if(!['jev-mock','jev-live'].includes(provider))throw new TypeError('Unsupported Assist provider');
  const mockClient={model:'fixture-lexical',async systemOne({state,questions={decision:{type:'noul'}}}){
    const taskWords=new Set(state.task.toLowerCase().match(/[a-z0-9]+/g)??[]);
    const answers=Object.fromEntries(Object.entries(questions).map(([id,question])=>{
      const evidence=state.decisions?.[id]??state,subjects=evidence.atom?[evidence.atom]:(evidence.coverageAtoms??[evidence.family??'']);
      const words=subjects.flatMap(subject=>String(subject).toLowerCase().match(/[a-z0-9]+/g)??[]);
      return[id,{type:question.type,noul:words.some(w=>taskWords.has(w))?0.9:0.01}];
    }));
    return {model:'fixture-lexical',answers,
      usage:{input_tokens:0,output_tokens:0}};
  }};
  const engine=new JevDecisionEngine({
    ...(provider==='jev-mock'?{client:mockClient}:client?{client}:{}),
    onTelemetry:event=>telemetry?.append({...event,provider:provider==='jev-mock'?'mock-typesafe':event.provider,
      evidence:provider==='jev-mock'?'synthetic':'live'})});
  return treatmentProfile(treatment).m8==='capability/operational-sufficiency-v1'
    ? new OperationalSufficiencyCapabilityStrategyR1({decisionEngine:engine})
    : new JevHierarchicalCoverCapabilityStrategy({decisionEngine:engine});
}
