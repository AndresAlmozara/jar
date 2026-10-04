import {PRODUCT_FAMILIES} from "../datasets.mjs";

export const SUITES=Object.freeze([
  {id:"m8-operational-closure-v2",version:"2.0.0",supersedes:"m8-operational-closure-v1",contrast:"HIGH_CLOSURE/BROAD_INVENTORY versus LOW_CLOSURE/BROAD_INVENTORY"},
  {id:"m8-inventory-headroom-v2",version:"2.0.0",supersedes:"m8-inventory-headroom-v1",contrast:"HIGH_CLOSURE/BROAD_INVENTORY versus HIGH_CLOSURE/REDUCED_INVENTORY"},
]);
export const CONDITIONS=Object.freeze([
  {id:"HIGH_CLOSURE_BROAD_INVENTORY",closure:"HIGH",inventory:"BROAD",suiteRefs:[SUITES[0].id,SUITES[1].id]},
  {id:"LOW_CLOSURE_BROAD_INVENTORY",closure:"LOW",inventory:"BROAD",suiteRefs:[SUITES[0].id]},
  {id:"HIGH_CLOSURE_REDUCED_INVENTORY",closure:"HIGH",inventory:"REDUCED",suiteRefs:[SUITES[1].id]},
]);
export const ARMS=Object.freeze([{armId:"REFERENCE_V1",treatment:"v1"},{armId:"M8_OPERATIONAL_R1",treatment:"v1+m8-operational-r1"}]);

export function buildPlan(){const pairs=[];let order=0;const families=Object.keys(PRODUCT_FAMILIES).filter(id=>PRODUCT_FAMILIES[id].module==="M8");for(let familyIndex=0;familyIndex<families.length;familyIndex++)for(let repetition=1;repetition<=2;repetition++){const conditions=repetition===1?CONDITIONS:[CONDITIONS[2],CONDITIONS[1],CONDITIONS[0]];for(let conditionIndex=0;conditionIndex<conditions.length;conditionIndex++){const condition=conditions[conditionIndex],arms=(familyIndex+repetition+conditionIndex)%2===0?[...ARMS]:[...ARMS].reverse(),pairId=`PAIR-${families[familyIndex]}-${condition.id}-R${repetition}`;pairs.push({index:order++,pairId,family:families[familyIndex],condition,repetition,arms:arms.map((arm,armIndex)=>({...arm,slotId:`${pairId}-${arm.armId}`,armIndex,reservation:{jevAttempts:24,jevInputTokens:140000,productTurns:1}}))});}}return{schemaVersion:"jar.m8-permanent-diagnostics.plan.v2",planId:"m8-permanent-product-plan-v2",execution:"sequential-paired-frozen",plannedPairs:pairs.length,plannedValidTurns:pairs.length*2,absoluteStartedTurnCap:28,replacementCap:4,pairs,slots:pairs.flatMap(pair=>pair.arms.map(arm=>({...arm,pairId:pair.pairId,family:pair.family,condition:pair.condition,repetition:pair.repetition,pairIndex:pair.index})))};}
