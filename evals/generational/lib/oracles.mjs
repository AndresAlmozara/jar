import {canonicalJson} from './spec.mjs';

const sorted=value=>[...new Set(value)].sort();
const subsets=items=>{const result=[];for(let mask=0;mask<2**items.length;mask++)result.push(items.filter((_,index)=>mask&(1<<index)));return result;};
const sameSets=(a,b)=>canonicalJson(a.map(sorted).sort((x,y)=>canonicalJson(x).localeCompare(canonicalJson(y))))===canonicalJson(b.map(sorted).sort((x,y)=>canonicalJson(x).localeCompare(canonicalJson(y))));

export function executableSetVerdict(fixture,gold,selectedIds){
  const capabilities=new Map(fixture.input.capabilities.map(item=>[item.id,item])),selected=sorted(selectedIds),unknown=selected.filter(id=>!capabilities.has(id));
  const forbidden=selected.filter(id=>gold.policyForbidden.includes(id)||capabilities.get(id)?.permission==='denied');
  const mandatory=fixture.input.capabilities.filter(item=>item.mandatory).map(item=>item.id),missingMandatory=mandatory.filter(id=>!selected.includes(id));
  const missingPrerequisites=[],scopeErrors=[];
  for(const id of selected){const cap=capabilities.get(id);if(!cap)continue;for(const required of cap.prerequisiteIds??[])if(!selected.includes(required))missingPrerequisites.push([id,required]);if(cap.scope&&fixture.input.requiredScope&&cap.scope!==fixture.input.requiredScope)scopeErrors.push(id);}
  const supplied=new Set(selected.flatMap(id=>{const cap=capabilities.get(id);return cap&&(!cap.scope||!fixture.input.requiredScope||cap.scope===fixture.input.requiredScope)?cap.provides??[]:[];}));
  const requirements=selected.flatMap(id=>capabilities.get(id)?.requires??[]),missingRequirements=sorted(requirements.filter(value=>!supplied.has(value))),missingObligations=gold.semanticObligations.filter(value=>!supplied.has(value));
  const valid=!unknown.length&&!forbidden.length&&!missingMandatory.length&&!missingPrerequisites.length&&!scopeErrors.length&&!missingRequirements.length&&!missingObligations.length;
  return{valid,selected,unknown,forbidden,missingMandatory,missingPrerequisites,scopeErrors,missingRequirements,missingObligations};
}

export function exactSmallSufficientSets(fixture,gold,{maximumCapabilities=12}={}){
  const ids=fixture.input.capabilities.map(item=>item.id);if(ids.length>maximumCapabilities)return null;
  const valid=subsets(ids).filter(set=>executableSetVerdict(fixture,gold,set).valid),minimal=valid.filter(set=>!valid.some(other=>other.length<set.length&&other.every(id=>set.includes(id))));
  return minimal.map(sorted).sort((a,b)=>a.length-b.length||canonicalJson(a).localeCompare(canonicalJson(b)));
}

export function validateExecutableGold(fixture,gold){
  const exact=exactSmallSufficientSets(fixture,gold);if(exact===null)return{valid:true,exact:null};
  const declared=gold.sufficientSets.map(sorted).sort((a,b)=>a.length-b.length||canonicalJson(a).localeCompare(canonicalJson(b)));
  const invalidDeclared=declared.filter(set=>!executableSetVerdict(fixture,gold,set).valid),declaredIntersection=declared.reduce((intersection,set)=>intersection.filter(id=>set.includes(id)),declared[0]??[]).sort();
  return{valid:invalidDeclared.length===0&&sameSets(exact,declared)&&canonicalJson(declaredIntersection)===canonicalJson(sorted(gold.indispensable)),exact,declared,invalidDeclared,declaredIntersection};
}
