import {PRODUCT_FAMILIES} from "./datasets.mjs";

export const M8_CONDITIONS=Object.freeze([
  {id:"HIGH_CLOSURE_WIDE_INVENTORY",closure:"HIGH",inventory:"WIDE",suiteRefs:["m8-operational-closure-v1","m8-inventory-headroom-v1"]},
  {id:"LOW_CLOSURE_WIDE_INVENTORY",closure:"LOW",inventory:"WIDE",suiteRefs:["m8-operational-closure-v1"]},
  {id:"HIGH_CLOSURE_NARROW_INVENTORY",closure:"HIGH",inventory:"NARROW",suiteRefs:["m8-inventory-headroom-v1"]},
]);
export const M8_ARMS=Object.freeze([{armId:"REFERENCE_V1",treatment:"v1"},{armId:"M8_OPERATIONAL_R1",treatment:"v1+m8-operational-r1"}]);
export const M6_ARMS=Object.freeze([{armId:"REFERENCE_V1",treatment:"v1"},{armId:"M6_RECALL_R1",treatment:"v1+m6-recall-r1"},{armId:"M6_EVIDENCE_R2",treatment:"v1+m6-evidence-r2"}]);

export function buildPlan({r2Qualified=true}={}){
  const slots=[];let order=0;
  const m8Families=Object.keys(PRODUCT_FAMILIES).filter(id=>PRODUCT_FAMILIES[id].module==="M8");
  for(let familyIndex=0;familyIndex<m8Families.length;familyIndex++)for(let repetition=1;repetition<=2;repetition++){
    const conditions=repetition===1?M8_CONDITIONS:[M8_CONDITIONS[2],M8_CONDITIONS[1],M8_CONDITIONS[0]];
    for(let conditionIndex=0;conditionIndex<conditions.length;conditionIndex++){
      const arms=(familyIndex+repetition+conditionIndex)%2===0?[...M8_ARMS]:[...M8_ARMS].reverse();
      for(const arm of arms)slots.push({index:order++,slotId:`M8-${m8Families[familyIndex]}-${conditions[conditionIndex].id}-R${repetition}-${arm.armId}`,module:"M8",family:m8Families[familyIndex],condition:conditions[conditionIndex],repetition,...arm,reservation:{jevAttempts:24,jevInputTokens:140000,productTurns:1}});
    }
  }
  const m6Families=Object.keys(PRODUCT_FAMILIES).filter(id=>PRODUCT_FAMILIES[id].module==="M6"),baseArms=r2Qualified?M6_ARMS:M6_ARMS.slice(0,2);
  for(let familyIndex=0;familyIndex<m6Families.length;familyIndex++)for(let repetition=1;repetition<=2;repetition++){
    const offset=(familyIndex*2+repetition-1)%baseArms.length,arms=[...baseArms.slice(offset),...baseArms.slice(0,offset)];
    for(const arm of arms)slots.push({index:order++,slotId:`M6-${m6Families[familyIndex]}-R${repetition}-${arm.armId}`,module:"M6",family:m6Families[familyIndex],condition:null,repetition,...arm,reservation:{jevAttempts:8,jevInputTokens:140000,productTurns:1}});
  }
  return{schemaVersion:"jar.component-diagnostics.campaign-plan.v1",planId:"m6-m8-permanent-product-plan-v1",r2Disposition:r2Qualified?"QUALIFIED":"NO_REFINEMENT_QUALIFIED",plannedValidSlots:slots.length,referenceV1Slots:slots.filter(x=>x.armId==="REFERENCE_V1").length,
    absoluteStartedTurnCap:40,replacementCap:4,phase2JevCaps:{attempts:900,inputTokens:6000000},jointJevCaps:{attempts:1500,inputTokens:10000000},execution:"sequential",slots};
}
