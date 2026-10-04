import { newId } from "../../core/src/ids.js";
import { sha256, stableStringify } from "../../core/src/hash.js";

export const SKILL_OUTCOMES=Object.freeze({SELECTED:"selected",NO_SKILL:"no_skill",NO_DECISION:"no_decision",UNSUPPORTED:"unsupported",ERROR:"error"});

export function canonicalSkills(catalog) {
  if (!catalog || !Array.isArray(catalog.skills)) throw new TypeError("Skill routing requires CatalogSnapshot.skills");
  const seen=new Set();
  return catalog.skills.map((skill)=>{
    if (!skill || typeof skill.id!=="string" || !skill.id || seen.has(skill.id)) throw new TypeError("Skill routing requires unique canonical skill IDs");
    seen.add(skill.id);
    return {id:skill.id,name:skill.name ?? skill.id,description:skill.description ?? "",relativePath:skill.relativePath ?? null,sourceHash:skill.sourceHash ?? null,metadata:skill.metadata ?? {}};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}

function contextText(value) {
  if (typeof value==="string") return value;
  if (!value || typeof value!=="object") return "";
  for (const key of ["text","content","summary","request"]) if (typeof value[key]==="string") return value[key];
  return stableStringify(value);
}

export function renderRoutingContext(task,session={}) {
  if (!task || typeof task.id!=="string" || typeof task.text!=="string") throw new TypeError("Skill routing requires a TaskSnapshot");
  const parts=[task.text];
  for (const item of task.recentContext ?? []) { const text=contextText(item); if (text) parts.push(text); }
  for (const item of session.recentContext ?? []) { const text=contextText(item); if (text) parts.push(text); }
  for (const value of [task.phase,session.phase,task.project,session.workspace]) { const text=contextText(value); if (text) parts.push(text); }
  return parts.join("\n").slice(0,16000);
}

export function resolveExplicitSkills(task,skills) {
  const requested=Array.isArray(task.explicitSkills)?task.explicitSkills.filter((x)=>typeof x==="string"&&x.trim()).map((x)=>x.trim()):[];
  if (!requested.length) return null;
  const byId=new Map(skills.map((skill)=>[skill.id.toLowerCase(),skill]));
  const byName=new Map(skills.map((skill)=>[skill.name.toLowerCase(),skill]));
  const resolved=[]; const missing=[];
  for (const value of requested) {
    const skill=byId.get(value.toLowerCase()) ?? byName.get(value.toLowerCase());
    if (!skill) missing.push(value); else if (!resolved.some((item)=>item.id===skill.id)) resolved.push(skill);
  }
  return {requested,resolved:resolved.sort((a,b)=>a.id.localeCompare(b.id)),missing};
}

export function makeSkillProposal({strategy,task,catalog,candidates=[],outcome,selectedSkillIds=[],confidence=null,reason,provenance={},latencyMs=0,error=null}) {
  const selected=[...new Set(selectedSkillIds)].sort();
  if (outcome===SKILL_OUTCOMES.NO_SKILL && selected.length) throw new TypeError("NO_SKILL cannot contain selected skills");
  return {id:newId("proposal"),taskId:task.id,component:"skills",strategy,candidates,decision:{outcome,selectedSkillIds:selected,noSkill:outcome===SKILL_OUTCOMES.NO_SKILL,confidence,reason,provenance:{catalogHash:catalog.hash,catalogSource:catalog.source,candidateSnapshotHash:sha256(canonicalSkills(catalog).map(({id,sourceHash})=>({id,sourceHash}))),...provenance},latencyMs,error},provider:{kind:"shadow"},createdAt:new Date().toISOString()};
}

export function explicitProposal(strategy,input,skills) {
  const result=resolveExplicitSkills(input.task,skills);
  if (!result) return null;
  if (result.missing.length) return makeSkillProposal({strategy,...input,outcome:SKILL_OUTCOMES.NO_DECISION,reason:"explicit_skill_unresolved",provenance:{path:"deterministic-explicit",requested:result.requested,missing:result.missing}});
  return makeSkillProposal({strategy,...input,outcome:SKILL_OUTCOMES.SELECTED,selectedSkillIds:result.resolved.map((skill)=>skill.id),confidence:1,reason:"explicit_skill_request",candidates:result.resolved.map((skill)=>({id:skill.id,relativePath:skill.relativePath,sourceHash:skill.sourceHash})),provenance:{path:"deterministic-explicit",requested:result.requested}});
}

export function invalidDecision(code,message) {
  const error=new Error(message);
  error.name="InvalidDecision";
  error.code=code;
  return error;
}

export function assertDecisionProbability(value,label) {
  if (typeof value!=="number" || !Number.isFinite(value) || value<0 || value>1) throw invalidDecision("invalid_probability",`${label} must be a finite probability between 0 and 1`);
  return value;
}

export function strategyErrorProposal(strategy,input,error,provenance={},latencyMs=0) {
  const reason=error?.name==="InvalidDecision"?"strategy_invalid_decision":"strategy_provider_failure";
  return makeSkillProposal({strategy,...input,outcome:SKILL_OUTCOMES.ERROR,reason,error:{name:error?.name??"Error",code:error?.code??null},provenance,latencyMs});
}
