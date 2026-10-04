import { sha256 } from "../../core/src/hash.js";
import { assertDecisionProbability, canonicalSkills, explicitProposal, invalidDecision, makeSkillProposal, renderRoutingContext, SKILL_OUTCOMES, strategyErrorProposal } from "./common.js";
import { HermesTwoStageSkillStrategy } from "./hermes-two-stage.js";
import { withSkillInvocation } from "./invocation.js";

const NO_GROUP="__no_group__";

function callEvidence(result) {
  return {provider:result.provider??null,usage:result.usage??null,latencyMs:result.latency_ms??null};
}

export function deriveEccHierarchy(catalog) {
  const skills=canonicalSkills(catalog);
  if (!Array.isArray(catalog.modules) || !catalog.modules.length) return {supported:false,reason:"catalog_modules_missing",groups:[],unmappedSkillIds:skills.map((skill)=>skill.id),multiplyMappedSkillIds:[]};
  const canonicalIds=new Set(skills.map((skill)=>skill.id));
  const memberships=new Map(skills.map((skill)=>[skill.id,[]]));
  const groups=[];
  for (const module of catalog.modules) {
    if (!module || typeof module.id!=="string" || !module.id || !Array.isArray(module.paths)) continue;
    const memberIds=[...new Set(module.paths.filter((value)=>typeof value==="string"&&value.startsWith("skills/")).map((value)=>value.slice(7)).filter((id)=>canonicalIds.has(id)))].sort((a,b)=>a.localeCompare(b));
    if (!memberIds.length) continue;
    for (const id of memberIds) memberships.get(id).push(module.id);
    groups.push({id:module.id,description:typeof module.description==="string"?module.description:"",stability:module.stability??null,memberIds});
  }
  groups.sort((a,b)=>a.id.localeCompare(b.id));
  const unmappedSkillIds=[]; const multiplyMappedSkillIds=[];
  for (const [id,moduleIds] of memberships) {
    if (!moduleIds.length) unmappedSkillIds.push(id);
    else if (moduleIds.length>1) multiplyMappedSkillIds.push(id);
  }
  const supported=groups.length>0&&!unmappedSkillIds.length&&!multiplyMappedSkillIds.length;
  return {supported,reason:supported?null:"incomplete_or_ambiguous_module_membership",groups,unmappedSkillIds,multiplyMappedSkillIds,hierarchyHash:sha256(groups.map(({id,memberIds})=>({id,memberIds})))};
}

export class EccHierarchySkillStrategy {
  constructor(options={}) {
    if (!options.decisionEngine) throw new TypeError("decisionEngine is required");
    this.id="skill/ecc-hierarchy-v1";
    this.engine=options.decisionEngine;
    this.hermes=new HermesTwoStageSkillStrategy(options);
  }

  async route(input) {
    return withSkillInvocation(this.id,input,this.engine,(engine)=>this.routeWithEngine(input,engine));
  }
  async routeWithEngine(input,engine) {
    const started=performance.now(); const skills=canonicalSkills(input.catalog); const explicit=explicitProposal(this.id,input,skills);
    if (explicit) { explicit.decision.latencyMs=performance.now()-started; return explicit; }
    const hierarchy=deriveEccHierarchy(input.catalog);
    const grouping={groupingSource:"CatalogSnapshot.modules",hierarchyHash:hierarchy.hierarchyHash??null,groups:hierarchy.groups.map(({id,description,stability,memberIds})=>({id,description,stability,memberIds})),initialCandidateCount:skills.length};
    if (!hierarchy.supported) return makeSkillProposal({strategy:this.id,...input,outcome:SKILL_OUTCOMES.UNSUPPORTED,reason:hierarchy.reason,provenance:{path:"ecc-hierarchy",...grouping,unmappedSkillIds:hierarchy.unmappedSkillIds,multiplyMappedSkillIds:hierarchy.multiplyMappedSkillIds},latencyMs:performance.now()-started});
    const state=renderRoutingContext(input.task,input.session);
    const criteria=Object.fromEntries(hierarchy.groups.map((group)=>[group.id,`${group.description}\nCanonical skills: ${group.memberIds.join(", ")}`]));
    criteria[NO_GROUP]="No ECC module group is relevant to this task";
    let groupChoice;
    try {
      groupChoice=await engine.choice({taskId:input.task.id,state,decisionContext:{operation:"hierarchy.group-choice"},instructions:"Which ECC module group contains the specialized skill this task needs, if any?",criteria});
      if (!Object.hasOwn(criteria,groupChoice.choice)) throw invalidDecision("invalid_hierarchy_group","Hierarchy selected a group outside the ECC module manifest");
      assertDecisionProbability(groupChoice.probabilities?.[groupChoice.choice],`Hierarchy probability for ${groupChoice.choice}`);
    } catch (error) { return strategyErrorProposal(this.id,input,error,{path:"ecc-hierarchy",...grouping,failureStage:"group_selection"},performance.now()-started); }
    const groupEvidence={choice:groupChoice.choice,probabilities:groupChoice.probabilities??{},confidence:groupChoice.confidence??null,call:callEvidence(groupChoice)};
    if (groupChoice.choice===NO_GROUP) return makeSkillProposal({strategy:this.id,...input,outcome:SKILL_OUTCOMES.NO_SKILL,confidence:groupChoice.confidence??null,reason:"no_relevant_ecc_group",provenance:{path:"ecc-hierarchy",...grouping,groupChoice:groupEvidence,reducedCandidateCount:0},latencyMs:performance.now()-started});
    const selectedGroup=hierarchy.groups.find((group)=>group.id===groupChoice.choice);
    const memberIds=new Set(selectedGroup.memberIds);
    const reducedCatalog={...input.catalog,skills:input.catalog.skills.filter((skill)=>memberIds.has(skill?.id))};
    const proposal=await this.hermes.routeWithEngine({...input,catalog:reducedCatalog},engine);
    proposal.strategy=this.id;
    proposal.decision.latencyMs=performance.now()-started;
    const hermes=proposal.decision.provenance;
    proposal.decision.provenance={catalogHash:hermes.catalogHash,catalogSource:hermes.catalogSource,candidateSnapshotHash:hermes.candidateSnapshotHash,path:"ecc-hierarchy",...grouping,groupChoice:groupEvidence,selectedGroupId:selectedGroup.id,reducedCandidateCount:selectedGroup.memberIds.length,hermes};
    return proposal;
  }
}
