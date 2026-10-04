import { canonicalSkills, explicitProposal, makeSkillProposal, renderRoutingContext, SKILL_OUTCOMES } from "./common.js";
import { withSkillInvocation } from "./invocation.js";

const STOP_WORDS=new Set("a an and app are for from i in into me need of on please skill skills the to want with".split(" "));
const FUZZY_EXCLUDED=new Set(["review"]);

function expand(token) {
  const values=new Set([token]);
  if (token.endsWith("ies")&&token.length>4) values.add(`${token.slice(0,-3)}y`);
  if (token.endsWith("es")&&token.length>4&&!token.endsWith("js")) values.add(token.slice(0,-2));
  if (token.endsWith("s")&&token.length>4&&!token.endsWith("js")) values.add(token.slice(0,-1));
  if (token.endsWith("ing")&&token.length>6) values.add(token.slice(0,-3));
  return [...values].filter(Boolean);
}

export function eccTokens(value) {
  const normalized=String(value??"").toLowerCase().replace(/\.js\b/g,"js").replace(/[^a-z0-9:+-]+/g," ").trim();
  return [...new Set(normalized.split(/\s+/).filter((token)=>token&&!STOP_WORDS.has(token)).flatMap(expand))];
}

function metadataText(metadata) {
  return Object.entries(metadata??{}).flatMap(([key,value])=>[key,typeof value==="string"?value:""]).join(" ");
}

export function eccNativeRank(text,skills) {
  const query=eccTokens(text);
  return skills.map((skill)=>{
    const corpus=new Set(eccTokens([skill.id.replaceAll("-"," "),skill.name,skill.description,metadataText(skill.metadata)].join(" ")));
    let score=0; const reasons=[];
    query.forEach((token,index)=>{
      if (corpus.has(token)) { score+=index===0?5:4; reasons.push(`matched ${token}`); }
      else if (token.length>=4&&!FUZZY_EXCLUDED.has(token)&&[...corpus].some((item)=>item.length>=4&&(item.includes(token)||token.includes(item)))) { score+=1; reasons.push(`fuzzy ${token}`); }
    });
    return {id:skill.id,score,reasons:[...new Set(reasons)],relativePath:skill.relativePath,sourceHash:skill.sourceHash};
  }).filter((item)=>item.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
}

export class EccNativeSkillStrategy {
  constructor({limit=5}={}) { this.id="skill/ecc-native-v1"; this.limit=limit; }
  async route(input) {
    return withSkillInvocation(this.id,input,null,()=>this.routeDeterministic(input));
  }
  async routeDeterministic(input) {
    const started=performance.now();
    const skills=canonicalSkills(input.catalog);
    const explicit=explicitProposal(this.id,input,skills);
    if (explicit) { explicit.decision.latencyMs=performance.now()-started; return explicit; }
    const ranked=eccNativeRank(renderRoutingContext(input.task,input.session),skills).slice(0,this.limit);
    if (!ranked.length) return makeSkillProposal({strategy:this.id,...input,outcome:SKILL_OUTCOMES.NO_DECISION,reason:"no_ecc_lexical_match",provenance:{path:"ecc-consult-adaptation",inputCandidateCount:skills.length,postFilterCandidateCount:skills.length},latencyMs:performance.now()-started});
    return makeSkillProposal({strategy:this.id,...input,candidates:ranked,outcome:SKILL_OUTCOMES.SELECTED,selectedSkillIds:[ranked[0].id],confidence:null,reason:"ecc_lexical_match",provenance:{path:"ecc-consult-adaptation",inputCandidateCount:skills.length,postFilterCandidateCount:skills.length},latencyMs:performance.now()-started});
  }
}
