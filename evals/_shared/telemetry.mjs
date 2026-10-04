import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const filesUnder=root=>{const out=[];const walk=(dir,prefix='')=>{for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(e.isSymbolicLink())throw Object.assign(Error('TELEMETRY_SYMLINK_REJECTED'),{code:'TELEMETRY_SYMLINK_REJECTED'});const rel=prefix+e.name,full=path.join(dir,e.name);if(e.isDirectory())walk(full,rel+'/');else if(e.isFile())out.push(rel);}};walk(root);return out.sort();};

export const TELEMETRY_SCHEMA_VERSION='jar.shared-telemetry.v1';

export function createToolObserver({emit=()=>{},clock=()=>performance.now(),sanitizeError=e=>({code:e?.code??e?.name??'TOOL_FAILED',message:String(e?.message??e)})}={}){
  const events=[];
  return {events,async run(name,arguments_,operation){const call={name,arguments:arguments_,started_ms:clock()};emit('tool_started',{name,arguments:arguments_,condition_elapsed_ms:call.started_ms});
    try{const result=await operation();call.success=result?.success===true;call.result=result;return result;}
    catch(error){call.error=sanitizeError(error);throw error;}
    finally{call.completed_ms=clock();events.push(call);emit('tool_completed',call);}}
  };
}

export function toolTimingMetrics(toolEvents=[]){
  const first=name=>toolEvents.find(e=>e.name===name)?.started_ms??null,reads=toolEvents.filter(e=>e.name==='workspace_read'),readPaths=reads.map(e=>e.arguments?.path).filter(Boolean),runEvents=toolEvents.filter(e=>e.name==='workspace_run'),testRuns=runEvents.filter(e=>e.arguments?.commandId==='test');
  return {toolCalls:toolEvents.length,uniqueToolsUsed:[...new Set(toolEvents.map(e=>e.name))].sort(),toolCallSequence:toolEvents.map(e=>e.name),
    fileReads:reads.length,uniqueFilesRead:new Set(readPaths).size,repeatedFileReads:readPaths.length-new Set(readPaths).size,searches:toolEvents.filter(e=>e.name==='workspace_search').length,
    testExecutions:testRuns.length,failedTestExecutions:testRuns.filter(e=>e.success!==true).length,buildExecutions:runEvents.filter(e=>e.arguments?.commandId==='build').length,
    timeToFirstToolMs:toolEvents[0]?.started_ms??null,timeToFirstReadMs:first('workspace_read'),timeToFirstSearchMs:first('workspace_search'),
    timeToFirstSuccessfulWriteMs:toolEvents.find(e=>e.name==='workspace_write'&&e.success)?.completed_ms??null,
    timeToFirstTestMs:toolEvents.find(e=>e.name==='workspace_run'&&e.arguments?.commandId==='test')?.started_ms??null,
    timeToFirstBuildMs:toolEvents.find(e=>e.name==='workspace_run'&&e.arguments?.commandId==='build')?.started_ms??null,
    toolCounts:Object.fromEntries([...new Set(toolEvents.map(e=>e.name))].sort().map(name=>[name,toolEvents.filter(e=>e.name===name).length]))};
}

export function summarizeJevUsage(events=[]){const successful=events.filter(e=>e.success===true);return successful.length?{
  calls:successful.length,models:[...new Set(successful.map(e=>e.provider_model).filter(Boolean))],
  input_tokens:successful.every(e=>Number.isInteger(e.input_tokens))?successful.reduce((n,e)=>n+e.input_tokens,0):null,
  output_tokens:successful.every(e=>Number.isInteger(e.output_tokens))?successful.reduce((n,e)=>n+e.output_tokens,0):null,
  latency_ms:successful.every(e=>Number.isFinite(e.latency_ms))?successful.reduce((n,e)=>n+e.latency_ms,0):null}:null;}

export function routingMetrics(gt,plan,toolEvents=[]) {
  const selectedSkills=plan.surfaces?.skills?.items?.map(x=>x.id)??[],selectedContext=plan.surfaces?.context?.items?.map(x=>x.path)??[],selectedTools=plan.selectedToolNames??null;
  const skillCandidates=plan.surfaces?.skills?.candidates??[],contextCandidates=plan.surfaces?.context?.candidates??[],capabilityCandidates=plan.capabilityMapping?.map(x=>x.toolName)??[];
  const selectedContextBytes=(plan.surfaces?.context?.items??[]).reduce((n,x)=>n+(Number.isFinite(x.bytes)?x.bytes:0),0),skillPayloadBytes=(plan.modelInputHashes??[]).filter(x=>x.channel==='skill-instructions').reduce((n,x)=>n+x.bytes,0);
  const fraction=(wanted,selected)=>wanted.length?new Set(wanted.filter(x=>selected.includes(x))).size/wanted.length:null,precision=(wanted,selected)=>selected.length?selected.filter(x=>wanted.includes(x)).length/selected.length:null;
  const skills=gt.skills??{},context=gt.context??{},caps=gt.capabilities??{},used=[...new Set(toolEvents.map(x=>x.name))],acceptableCapabilities=[...(caps.required??[]),...(caps.acceptable??[])];
  return {selectedSkills,selectedContext,selectedTools,skillCandidates,skillGroundTruth:skills.required??[],skillPayloadBytes,contextCandidates,selectedContextBytes,capabilityCandidates,selectedCapabilities:selectedTools,
    withheldCapabilities:selectedTools?capabilityCandidates.filter(x=>!selectedTools.includes(x)):null,capabilityRetentionRatio:selectedTools&&capabilityCandidates.length?selectedTools.length/capabilityCandidates.length:null,actualToolsCalled:used,
    skillRecall:fraction(skills.required??[],selectedSkills),skillPrecision:precision([...(skills.required??[]),...(skills.acceptable??[])],selectedSkills),skillDistractorSuppression:skillCandidates.length&&(skills.distractors??[]).length?(skills.distractors??[]).filter(x=>!selectedSkills.includes(x)).length/(skills.distractors??[]).length:null,
    contextCoreRecall:fraction(context.core??[],selectedContext),contextPrecision:precision([...(context.core??[]),...(context.supporting??[])],selectedContext),capabilityRecall:selectedTools?fraction(caps.required??[],selectedTools):null,
    capabilityPrecision:selectedTools?precision(acceptableCapabilities,selectedTools):null,capabilityDistractorSuppression:selectedTools&&(caps.distractors??[]).length?caps.distractors.filter(x=>!selectedTools.includes(x)).length/caps.distractors.length:null,
    exposedAndInvoked:selectedTools?.filter(x=>used.includes(x))??null,exposedButUnused:selectedTools?.filter(x=>!used.includes(x))??null,withheldAndUnobserved:selectedTools?capabilityCandidates.filter(x=>!selectedTools.includes(x)&&!used.includes(x)):null,
    demonstrablyRequiredCapabilities:caps.required??[],requiredCapabilityEvidence:(caps.required??[]).length?'task-ground-truth':'unavailable-for-open-ended-product-solution',
    unusedExposedToolFraction:selectedTools?.length?selectedTools.filter(x=>!used.includes(x)).length/selectedTools.length:null,notes:'Mechanism-specific descriptors, not an overall JAR score. Unused does not imply unnecessary; alternative tool paths may exist. Empty/non-applicable precision is null.'};
}

export function fileChanges(initial,final) {const names=[...new Set([...filesUnder(initial),...filesUnder(final)])].sort(),changes=[];
  for(const file of names){const a=path.join(initial,file),b=path.join(final,file),x=fs.existsSync(a)?fs.readFileSync(a):null,y=fs.existsSync(b)?fs.readFileSync(b):null,before=x===null?null:sha(x),after=y===null?null:sha(y);if(before!==after)changes.push({path:file,beforeSha256:before,afterSha256:after,beforeBytes:x?.length??null,afterBytes:y?.length??null});}
  return {filesModified:changes.map(x=>x.path),changes};}
