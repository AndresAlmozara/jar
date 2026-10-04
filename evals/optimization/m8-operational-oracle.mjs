import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const subsets=items=>Array.from({length:2**items.length},(_,mask)=>items.filter((_,index)=>mask&(1<<index)));
const covers=(selected,required,claims)=>required.every(need=>selected.some(id=>(claims[id]??[]).includes(need)));
const compatible=(selected,fixture)=>!(fixture.incompatiblePairs??[]).some(pair=>pair.every(id=>selected.includes(id)))&&
  !(fixture.sameProviderEffects??[]).some(effects=>{
    const providers=new Set(selected.filter(id=>effects.some(effect=>(fixture.capabilities[id].effects??[]).includes(effect)))
      .map(id=>fixture.capabilities[id].provider));return providers.size>1;
  });
const actualSufficient=(selected,fixture)=>fixture.requiredEffects.every(effect=>selected.some(id=>fixture.capabilities[id].effects.includes(effect)))&&compatible(selected,fixture);
const cost=(selected,fixture)=>selected.reduce((sum,id)=>sum+fixture.capabilities[id].cost,0);

function operationalCoverageSeeds(fixture,claims,required,operationalClaims,operationalAtoms=[]){
  const allowed=Object.keys(fixture.capabilities).filter(id=>fixture.capabilities[id].permission!=='denied');
  return operationalAtoms.flatMap(atom=>{
    const providers=allowed.filter(id=>(operationalClaims[id]??[]).includes(atom)
        &&(claims[id]??[]).some(claim=>required.includes(claim)))
      .sort((a,b)=>fixture.capabilities[a].cost-fixture.capabilities[b].cost||a.localeCompare(b));
    return providers.slice(0,1);
  });
}

function greedy(fixture,claims,required,{operationalAtoms=[],operationalClaims=claims,relevanceClaims=claims,relevanceRequired=required}={}){
  const allowed=Object.keys(fixture.capabilities).filter(id=>fixture.capabilities[id].permission!=='denied');
  const selected=new Set([...allowed.filter(id=>fixture.capabilities[id].mandatory||fixture.capabilities[id].unknown),
    ...operationalCoverageSeeds(fixture,relevanceClaims,relevanceRequired,operationalClaims,operationalAtoms)]);
  const covered=new Set([...selected].flatMap(id=>claims[id]??[]));
  while(required.some(atom=>!covered.has(atom))){
    const ranked=allowed.filter(id=>!selected.has(id)).map(id=>({id,gain:(claims[id]??[]).filter(atom=>required.includes(atom)&&!covered.has(atom)).length,
      cost:fixture.capabilities[id].cost})).filter(row=>row.gain).sort((a,b)=>(b.gain/b.cost)-(a.gain/a.cost)||a.cost-b.cost||a.id.localeCompare(b.id));
    if(!ranked.length)break;selected.add(ranked[0].id);for(const atom of claims[ranked[0].id]??[])covered.add(atom);
  }
  return [...selected].sort();
}

export function evaluateOperationalFixtures(document){
  const rows=document.fixtures.map(fixture=>{
    const oracleSets=subsets(Object.keys(fixture.capabilities)).filter(set=>actualSufficient(set,fixture))
      .filter(set=>!subsets(Object.keys(fixture.capabilities)).some(smaller=>smaller.length<set.length&&smaller.every(id=>set.includes(id))&&actualSufficient(smaller,fixture)))
      .sort((a,b)=>cost(a,fixture)-cost(b,fixture)||JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const evaluate=variant=>{
      const claimVariant=variant==='h2'?'h1':variant;
      const claims=Object.fromEntries(Object.entries(fixture.capabilities).map(([id,cap])=>[id,cap[`${claimVariant}Claims`]??[]]));
      const relevanceClaims=Object.fromEntries(Object.entries(fixture.capabilities).map(([id,cap])=>[id,cap.h0Claims??[]]));
      const required=fixture[`${claimVariant}Required`],selected=greedy(fixture,claims,required,
        {operationalAtoms:variant==='h2'?document.operationalAtoms:[],operationalClaims:claims,
          ...(variant==='h2'?{relevanceClaims,relevanceRequired:fixture.h0Required}: {})}),semanticCover=covers(selected,required,claims),
        declared=semanticCover&&(variant==='h0'||compatible(selected,fixture));
      const sufficient=actualSufficient(selected,fixture),policySafe=selected.every(id=>fixture.capabilities[id].permission!=='denied')&&
        Object.entries(fixture.capabilities).filter(([,cap])=>cap.mandatory||cap.unknown).every(([id])=>selected.includes(id));
      return {selected,semanticCover,declaredSufficient:declared,operationallySufficient:sufficient,falseSufficient:declared&&!sufficient,
        uncovered:required.filter(need=>!selected.some(id=>claims[id].includes(need))),cost:cost(selected,fixture),policySafe};
    };
    return {id:fixture.id,oracleMinimalSufficientSets:oracleSets,h0:evaluate('h0'),h1:evaluate('h1'),h2:evaluate('h2')};
  });
  const aggregate=variant=>({falseSufficient:rows.filter(row=>row[variant].falseSufficient).length,
    operationallySufficient:rows.filter(row=>row[variant].operationallySufficient).length,
    policyViolations:rows.filter(row=>!row[variant].policySafe).length,total:rows.length});
  const h0=aggregate('h0'),h1=aggregate('h1'),h2=aggregate('h2');
  return {schemaVersion:'jar.m8-operational-oracle.v1',fixtureVersion:document.schemaVersion,rows,aggregate:{h0,h1,h2},
    gate:{pass:h2.falseSufficient===0&&h2.policyViolations===0,meaning:'Offline phase A only; does not establish semantic accuracy or production readiness.'}};
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const document=JSON.parse(await readFile(process.argv[2],'utf8'));console.log(JSON.stringify(evaluateOperationalFixtures(document),null,2));
}
