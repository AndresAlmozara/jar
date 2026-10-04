import {executableSetVerdict} from './oracles.mjs';

const set=value=>new Set(value??[]),intersection=(a,b)=>[...a].filter(value=>b.has(value)),ratio=(n,d)=>d?n/d:null;
const result=(status,metrics={},details={})=>({status,metrics,details});
export const failureStatus=failureClass=>failureClass==='not_implemented'?'NOT_IMPLEMENTED':failureClass==='not_applicable'?'NOT_APPLICABLE':failureClass==='provider'||failureClass==='infrastructure'?'INFRA_FAILURE':'FAIL';

export function gradeM5(observation,gold){
  if(observation.failureClass)return result(failureStatus(observation.failureClass),{}, {failureClass:observation.failureClass});
  const candidates=set(observation.candidateSkills),requiredCandidates=set(gold.requiredCandidateSkills),supports=set(observation.supportingSkills),requiredSupports=set(gold.requiredSupportingSkills),allowedSupports=set(gold.allowedSupportingSkills);
  const primaryCorrect=gold.abstained?observation.abstained===true:gold.acceptablePrimarySkills.includes(observation.primarySkill),explicitCorrect=gold.explicitSkills?gold.explicitSkills.every(id=>(observation.explicitSkills??[]).includes(id)):true;
  const candidateRecall=requiredCandidates.size?ratio(intersection(requiredCandidates,candidates).length,requiredCandidates.size):1,supportCompleteness=requiredSupports.size?ratio(intersection(requiredSupports,supports).length,requiredSupports.size):1,unnecessary=[...supports].filter(id=>!allowedSupports.has(id));
  const pass=primaryCorrect&&explicitCorrect&&candidateRecall===1&&supportCompleteness===1&&!unnecessary.length&&supports.size<=2;
  return result(pass?'PASS':'FAIL',{candidateRecall,primaryCorrect,supportCompleteness,unnecessarySupportCount:unnecessary.length,noSkillCorrect:gold.abstained?observation.abstained===true:null,explicitCorrect},{unnecessarySupports:unnecessary});
}

export function gradeM6(observation,gold){
  if(observation.failureClass)return result(failureStatus(observation.failureClass),{}, {failureClass:observation.failureClass});
  const candidates=set(observation.candidatePaths),selected=set(observation.selectedPaths),materialized=set(observation.materializedPaths),required=set(gold.requiredCandidates),requiredMaterialized=set(gold.requiredMaterialized);
  const candidateRecall=required.size?ratio(intersection(required,candidates).length,required.size):1,selectedRecall=required.size?ratio(intersection(required,selected).length,required.size):observation.selectedPaths.length===0?1:0,materializedRecall=requiredMaterialized.size?ratio(intersection(requiredMaterialized,materialized).length,requiredMaterialized.size):observation.materializedPaths.length===0?1:0;
  const acceptable=gold.acceptableSelectedSets.some(alternative=>alternative.every(id=>selected.has(id))&&[...selected].every(id=>alternative.includes(id))),duplicateBound=gold.maximumSemanticDuplicates===undefined||observation.maximumSemanticDuplicates<=gold.maximumSemanticDuplicates;
  const pass=candidateRecall===1&&acceptable&&materializedRecall===1&&duplicateBound;
  return result(pass?'PASS':'FAIL',{candidateRecall,selectedRecall,materializedRecall,acceptableSelection:acceptable,duplicateBound},{failureLayer:observation.failureLayer??null});
}

export function gradeM7(observation,gold){
  if(observation.failureClass)return result(failureStatus(observation.failureClass),{}, {failureClass:observation.failureClass});
  const missing=gold.requiredProperties.filter(property=>!observation.properties.includes(property));return result(missing.length?'FAIL':'PASS',{required:gold.requiredProperties.length,passed:gold.requiredProperties.length-missing.length},{missing});
}

export function gradeM8(observation,fixture,gold){
  if(observation.failureClass)return result(failureStatus(observation.failureClass),{}, {failureClass:observation.failureClass});
  const selected=set(observation.exposedCapabilityIds),required=set(gold.semanticObligations),observed=set(observation.semanticObligations),semanticRecall=ratio(intersection(required,observed).length,required.size),verdict=executableSetVerdict(fixture,gold,[...selected]);
  const chosen=gold.sufficientSets.filter(alternative=>alternative.every(id=>selected.has(id))).sort((a,b)=>a.length-b.length)[0]??[],unnecessary=[...selected].filter(id=>!chosen.includes(id)&&!fixture.input.capabilities.find(cap=>cap.id===id)?.mandatory);
  const pass=semanticRecall===1&&verdict.valid&&!(observation.policyViolations??[]).length&&!(observation.prerequisiteViolations??[]).length&&!(observation.scopeErrors??[]).length;
  return result(pass?'PASS':'FAIL',{semanticRecall,executableSufficiency:verdict.valid,falseSufficiency:!verdict.valid,unnecessaryExposureCount:unnecessary.length,policyViolationCount:(observation.policyViolations??[]).length,prerequisiteViolationCount:(observation.prerequisiteViolations??[]).length,scopeErrorCount:(observation.scopeErrors??[]).length},{verdict,unnecessary});
}

export function gradeObservation(observation,fixture,gold){
  if(observation.id!==fixture.id||gold.id!==fixture.id)return result('INFRA_FAILURE',{}, {failureClass:'binding'});
  if(fixture.module==='M5')return gradeM5(observation,gold);if(fixture.module==='M6')return gradeM6(observation,gold);if(fixture.module==='M7')return gradeM7(observation,gold);return gradeM8(observation,fixture,gold);
}
