import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {capabilityDescriptor,capabilityInventory,exposureInput,JevHierarchicalCoverCapabilityStrategy,CAPABILITY_TAXONOMY} from '../../packages/capability-exposure/src/index.js';
import {loadCapabilityEvaluation,runCapabilityEvaluation,compactCapabilityEvaluation} from '../../packages/evals/src/capability-exposure.js';

const engine={noul:async({state})=>{const selected=state.atom?state.atom==='workspace.read':state.family==='workspace';
  return{primitive:'noul',probability_true:selected ? .9 : .05,probability_false:selected ? .1 : .95};}};
const families=Object.entries(CAPABILITY_TAXONOMY).filter(([family])=>family!=='workspace');
const irrelevant=families.flatMap(([,atoms])=>atoms),seeds=families.map(([,atoms])=>atoms[0]);
const descriptor=(name,coverageAtoms,schemaChars)=>capabilityDescriptor({kind:'tool',name,description:`Generated offline ${name}`,
  source:{namespace:'hsce-scale-v1',nativeId:name},risk:'low',schemaChars,coverageAtoms});
const row=async count=>{
  const capabilities=[descriptor('relevant',['workspace.read'],50)];
  for(let n=1;n<count;n++)capabilities.push(descriptor(`distractor-${n}`,[n<=seeds.length?seeds[n-1]:irrelevant[(n-1)%irrelevant.length]],100+n));
  const input=exposureInput({task:{id:'hsce-scale-task',text:'Read the owned workspace file'},inventory:capabilityInventory({
    runtime:{id:'offline-scale',family:'fixture'},source:'generated-offline',state:'known',entries:capabilities.map(capability=>({
      capability,available:true,supported:true,enabled:true,permission:'allowed',requirementsSatisfied:true}))})});
  const result=await new JevHierarchicalCoverCapabilityStrategy({decisionEngine:engine}).propose(input),h=result.proposal.hierarchical;
  return{candidateCount:count,selectedCount:result.proposal.proposedIds.length,selectionRatio:result.proposal.proposedIds.length/count,
    exposureCostRatio:h.selectedExposureCost/h.totalEligibleExposureCost,semanticDecisionCount:h.jevDecisionCalls,mustExposeRecall:1};
};

const dataset=await loadCapabilityEvaluation(),evaluation=await runCapabilityEvaluation({dataset});
const hsce=compactCapabilityEvaluation(evaluation).summary.find(summary=>summary.strategy_id==='capability/jev-hierarchical-cover-v1');
const report={version:'m8.hsce.offline-report.v1',evidence:'deterministic offline fixture evidence; no production token-savings claim',
  before:{strategy:'capability/jev-selective-v1',maximumIndividuallyJudged:6,unjudgedEligibleSurvive:true,
    scalingLimitation:'semantic exclusions are bounded while eligible inventory can grow without bound'},
  after:{strategy:'capability/jev-hierarchical-cover-v1',taxonomyFamilies:Object.keys(CAPABILITY_TAXONOMY),
    semanticComplexity:'O(fixed taxonomy families + atoms in selected families), independent of capability count',
    cover:'deterministic greedy marginal binary coverage per serialized descriptor cost',semanticFailure:'all deterministic-policy-eligible capabilities'},
  fixtureEvidence:{cases:hsce.cases,mustExposeRecall:hsce.must_expose_recall,falseExclusions:hsce.false_exclusions,
    policyViolations:hsce.policy_violations,meanCountReduction:hsce.mean_count_reduction,meanExposureCostReduction:hsce.mean_schema_size_proxy_reduction},
  scale:await Promise.all([21,50,100,300].map(row))};
const output=fileURLToPath(new URL('../../.jar/evaluations/m8-hsce/offline-report.json',import.meta.url));
await fs.mkdir(fileURLToPath(new URL('../../.jar/evaluations/m8-hsce/',import.meta.url)),{recursive:true});
await fs.writeFile(output,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({status:'READY',output,report},null,2));
