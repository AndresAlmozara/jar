import {capabilityInventory,exposureInput} from "../../../packages/capability-exposure/src/contracts.js";
import {toolInventory} from "../../benchmark/lib/tools.mjs";
import {sha256} from "../../../packages/core/src/hash.js";

export const OPERATIONAL_SCOPE="isolated-opsdesk-product@current-arm";
export const WIDTHS=Object.freeze({BROAD:"BROAD",REDUCED:"REDUCED"});
const reducedNames=new Set(["workspace_list","workspace_search","workspace_read","workspace_write","workspace_run","ecc_catalog_search","ecc_skill_read"]);

export function canonicalConditionInventory(width=WIDTHS.BROAD){
  if(!Object.values(WIDTHS).includes(width))throw Object.assign(Error("M8_WIDTH_UNKNOWN"),{code:"M8_WIDTH_UNKNOWN",width});
  const source=toolInventory("v1+m8-operational-r1");
  const mapping=width===WIDTHS.REDUCED?source.mapping.filter(row=>reducedNames.has(row.native.name)):source.mapping;
  const ids=new Set(mapping.map(row=>row.capability.id));
  const entries=source.inventory.entries.filter(row=>ids.has(row.capability.id));
  const inventory=capabilityInventory({runtime:source.inventory.runtime,source:"bounded-host-product-trial/m8-v2-authoritative-condition",revision:`m8-v2-${width.toLowerCase()}`,state:"known",entries});
  return{mapping,inventory,width,inventoryHash:sha256(inventory),capabilityUniverse:mapping.map(row=>({capabilityId:row.capability.id,nativeId:row.native.name,nativeHash:sha256(row.native),operational:row.capability.operational,permissions:row.capability.requiredPermissions})),operationalFactsHash:sha256(mapping.map(row=>({id:row.capability.id,operational:row.capability.operational,permissions:row.capability.requiredPermissions})))};
}

export function canonicalRequiredObligations(){return["workspace.inspect","workspace.modify","verification.execute"];}
export function canonicalExposureInput({task,inventory}){return exposureInput({task,inventory,constraints:{requiredObligations:canonicalRequiredObligations(),operationalScope:OPERATIONAL_SCOPE}});}
export function canonicalGateInput({taskText,mapping}){return{taskText,eligibleCapabilityContracts:mapping.map(row=>({nativeId:row.capability.source.nativeId,provides:row.capability.operational.provides,scope:row.capability.operational.scope,completeness:row.capability.operational.completeness}))};}
export function gateInputHash(input){return sha256(input);}
export function legacyTreatmentDependentInventory(treatment,width=WIDTHS.BROAD){const source=toolInventory(treatment);const mapping=width===WIDTHS.REDUCED?source.mapping.filter(row=>reducedNames.has(row.native.name)):source.mapping,ids=new Set(mapping.map(row=>row.capability.id));return{mapping,inventory:capabilityInventory({runtime:source.inventory.runtime,source:source.inventory.source,state:"known",entries:source.inventory.entries.filter(row=>ids.has(row.capability.id))})};}
