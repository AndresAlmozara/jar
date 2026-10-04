export const TREATMENT_IDS = Object.freeze(["v1", "v1+m6-recall-r1", "v1+m6-evidence-r2", "v1+m8-operational-r1"]);

const profiles = Object.freeze({
  "v1": Object.freeze({id:"v1", m6:"context/deterministic-v1", m8:"capability/jev-hierarchical-cover-v1", disposition:"CANONICAL", default:true}),
  "v1+m6-recall-r1": Object.freeze({id:"v1+m6-recall-r1", m6:"context/recall-first-r1", m8:"capability/jev-hierarchical-cover-v1", disposition:"VALIDATED_SPECIALIST_NOT_PROMOTED", default:false}),
  "v1+m6-evidence-r2": Object.freeze({id:"v1+m6-evidence-r2", m6:"context/evidence-efficiency-r2", m8:"capability/jev-hierarchical-cover-v1", disposition:"NEGATIVE_RESULT", default:false}),
  "v1+m8-operational-r1": Object.freeze({id:"v1+m8-operational-r1", m6:"context/deterministic-v1", m8:"capability/operational-sufficiency-v1", disposition:"REJECTED_PRODUCT_CANDIDATE", default:false}),
});

export function treatmentProfile(id="v1") {
  const profile=profiles[id];
  if(!profile)throw Object.assign(Error("TREATMENT_UNKNOWN"),{code:"TREATMENT_UNKNOWN",treatmentId:id});
  return profile;
}
