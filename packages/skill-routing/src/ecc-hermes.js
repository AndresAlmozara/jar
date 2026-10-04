import { canonicalSkills } from "./common.js";
import { HermesTwoStageSkillStrategy } from "./hermes-two-stage.js";
import { withSkillInvocation } from "./invocation.js";

function printable(value) {
  if (typeof value==="string" || typeof value==="number" || typeof value==="boolean") return String(value);
  if (Array.isArray(value) && value.every((item)=>["string","number","boolean"].includes(typeof item))) return value.join(", ");
  return null;
}

export function eccSoftSignals(skill) {
  const signals=[];
  if (skill.name && skill.name!==skill.id) signals.push({field:"name",value:skill.name});
  if (skill.relativePath) signals.push({field:"relativePath",value:skill.relativePath});
  for (const [field,value] of Object.entries(skill.metadata??{}).sort(([a],[b])=>a.localeCompare(b))) {
    if (field==="name" || field==="description") continue;
    const rendered=printable(value);
    if (rendered) signals.push({field:`metadata.${field}`,value:rendered});
  }
  return signals;
}

function annotationFor(skill) {
  const signals=eccSoftSignals(skill);
  return signals.length?`ECC annotations: ${signals.map(({field,value})=>`${field}=${value}`).join("; ")}`:"";
}

export function prepareEccHermesCatalog(input) {
  if (!input.catalog || !Array.isArray(input.catalog.skills)) throw new TypeError("ECC + Hermes requires CatalogSnapshot.skills");
  const structurallyValid=[]; const hardExcluded=[]; const seen=new Set();
  input.catalog.skills.forEach((skill,index)=>{
    if (!skill || typeof skill.id!=="string" || !skill.id.trim()) {
      hardExcluded.push({id:null,sourceIndex:index,reason:"invalid_canonical_identity"});
    } else if (seen.has(skill.id)) {
      hardExcluded.push({id:skill.id,sourceIndex:index,reason:"duplicate_canonical_identity"});
    } else {
      seen.add(skill.id); structurallyValid.push(skill);
    }
  });
  const visible=Array.isArray(input.runtime?.visibleSkills)?new Set(input.runtime.visibleSkills):null;
  const remaining=[];
  for (const skill of structurallyValid) {
    if (visible && !visible.has(skill.id)) hardExcluded.push({id:skill.id,reason:"not_runtime_visible"});
    else remaining.push(skill);
  }
  const catalog={...input.catalog,skills:remaining};
  const canonical=canonicalSkills(catalog);
  return {
    catalog,
    provenance:{
      initialCandidateCount:input.catalog.skills.length,
      hardExcludedCandidates:hardExcluded,
      remainingCandidateCount:canonical.length,
      hardFactSources:visible?["RuntimeState.visibleSkills"]:[],
      visibility:visible===null?"unknown":"known",
      eccSoftSignalsUsed:canonical.map((skill)=>({id:skill.id,signals:eccSoftSignals(skill)})),
    },
  };
}

export class EccHermesSkillStrategy {
  constructor(options={}) {
    this.id="skill/ecc-hermes-v1";
    this.hermes=new HermesTwoStageSkillStrategy({...options,candidateAnnotation:annotationFor});
  }

  async route(input) {
    return withSkillInvocation(this.id,input,this.hermes.engine,(engine)=>this.routeWithEngine(input,engine));
  }
  async routeWithEngine(input,engine) {
    const started=performance.now();
    const prepared=prepareEccHermesCatalog(input);
    const proposal=await this.hermes.routeWithEngine({...input,catalog:prepared.catalog},engine);
    if (!prepared.catalog.skills.length && prepared.provenance.hardExcludedCandidates.length) {
      proposal.decision.reason=prepared.provenance.hardExcludedCandidates.some((item)=>item.reason==="not_runtime_visible")
        ? "policy_exhausted" : "invalid_candidates_exhausted";
    }
    proposal.strategy=this.id;
    proposal.decision.latencyMs=performance.now()-started;
    const hermes=proposal.decision.provenance;
    proposal.decision.provenance={
      catalogHash:hermes.catalogHash,
      catalogSource:hermes.catalogSource,
      candidateSnapshotHash:hermes.candidateSnapshotHash,
      path:"ecc-hermes",
      ...prepared.provenance,
      hermes,
    };
    return proposal;
  }
}
