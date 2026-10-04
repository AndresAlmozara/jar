import crypto from 'node:crypto';

const MAX_LABEL_LENGTH=160;
const MAX_SEGMENT_LENGTH=72;

function words(value){
  return String(value??'').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\\/]+/g,' ').replace(/\s+/g,' ').trim();
}

function title(value){
  return words(value).replace(/[-_]+/g,' ').replace(/\b([a-z])/g,match=>match.toUpperCase());
}

export function runSlugSegment(value,{fallback='run',lowercase=true}={}){
  let slug=words(value).normalize('NFKD').replace(/\p{M}/gu,'');
  slug=slug.replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'');
  if(lowercase)slug=slug.toLowerCase();
  slug=slug.slice(0,MAX_SEGMENT_LENGTH).replace(/-+$/,'');
  if(!slug)slug=fallback;
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(slug))slug=`run-${slug}`;
  return slug;
}

export function createRunIdentity({suite='run',suiteLabel=null,task=null,condition=null,name=null,clock=()=>new Date(),randomBytes=crypto.randomBytes}={}){
  const custom=words(name).slice(0,MAX_LABEL_LENGTH);
  const taskLabel=task?title(task):'';
  const conditionLabel=condition?words(condition).toUpperCase():'';
  const contextLabel=[taskLabel,conditionLabel].filter(Boolean).join(' — ');
  const automatic=words(suiteLabel)||title(suite)||'Run';
  const runLabel=[custom,contextLabel].filter(Boolean).join(' — ')||automatic;
  const segments=[];
  if(custom)segments.push(runSlugSegment(custom));
  if(task)segments.push(runSlugSegment(task));
  if(condition)segments.push(runSlugSegment(condition,{lowercase:false}));
  if(!segments.length)segments.push(runSlugSegment(suite));
  const runSlug=segments.join('_');
  const timestamp=clock().toISOString();
  const suffix=randomBytes(3).toString('hex');
  return {runId:`RUN_${timestamp.replace(/[:.]/g,'-')}_${runSlug}_${suffix}`,runLabel,runSlug,timestamp};
}
