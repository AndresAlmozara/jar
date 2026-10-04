import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {treeHash,iso} from '../../smoke-test/lib/common.mjs';
import {toolTimingMetrics,fileChanges} from '../../_shared/telemetry.mjs';
import {classifyCorrectness} from '../lib/correctness.mjs';
import {offlineIdentity,ROOT} from '../scenario-run.mjs';
import {compatibilityEnvelope,MODEL,REASONING_EFFORT,PROTOCOL_VERSION,BENCHMARK_ID} from './protocol.mjs';
import {activateBaseline,baselineRoot} from './storage.mjs';
import {assessBaseline,BASELINE_POLICIES} from './baseline-policy.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const lines=file=>fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const fail=(code,details={})=>{throw Object.assign(Error(code),{code,details});};

export function reconstructDiagnosticControl(repo,baselineId){
  const runDir=path.join(baselineRoot(repo),baselineId),conditionDir=path.join(runDir,'CONTROL'),eventsFile=path.join(conditionDir,'telemetry','events.jsonl'),routingFile=path.join(conditionDir,'telemetry','routing-plan.json'),failedFile=path.join(runDir,'FAILED_CONTROL.json');
  for(const file of [eventsFile,routingFile,failedFile,path.join(runDir,'model-selection.json'),path.join(runDir,'native-baseline-proof.json')])if(!fs.existsSync(file))fail('CONTROL_PROMOTION_EVIDENCE_MISSING',{file});
  if(fs.existsSync(path.join(runDir,'BASELINE.json')))fail('CONTROL_BASELINE_IMMUTABLE',{baselineId});
  const failed=read(failedFile),evaluationFile=path.resolve(repo,failed.correctedEvaluation?.evaluationPath??'');
  if(!evaluationFile.startsWith(path.resolve(repo)+path.sep)||!fs.existsSync(evaluationFile))fail('CONTROL_CORRECTED_EVALUATION_MISSING',{evaluationFile});
  const evaluation=read(evaluationFile),events=lines(eventsFile),routingPlan=read(routingFile),selection=read(path.join(runDir,'model-selection.json')),proof=read(path.join(runDir,'native-baseline-proof.json'));
  const turns=events.filter(event=>event.event==='app_server_send'&&event.message?.method==='turn/start').length,completion=events.findLast(event=>event.event==='app_server_message'&&event.message?.method==='turn/completed'),usageEvent=events.findLast(event=>event.event==='app_server_message'&&event.message?.method==='thread/tokenUsage/updated'),processClosed=events.findLast(event=>event.event==='owned_process_closed'),toolEvents=events.filter(event=>event.event==='tool_completed'),usage=usageEvent?.message?.params?.tokenUsage?.total;
  if(completion?.message?.params?.turn?.status!=='completed'||processClosed?.exitCode!==0)fail('CONTROL_SESSION_NOT_COMPLETED');
  const product=path.join(conditionDir,'product'),runtime={runtimeVersion:proof.runtimeVersion,runtimeHash:proof.runtimeHash,nativeBaselineId:proof.id,modelSelection:selection},offline=offlineIdentity(repo),control={
    schemaVersion:'jar.canonical-condition.v1',condition:'CONTROL',status:'COMPLETED',model:MODEL,reasoningEffort:REASONING_EFFORT,mainModelTurnsStarted:turns,
    initialWorkspaceHash:treeHash(path.join(ROOT,'starter')),finalWorkspaceHash:treeHash(product),productPath:product,
    routing:{controlBypassedJar:true,jevDecisionCalls:0,allCapabilitiesVisible:routingPlan.selectedCapabilityIds?.length===routingPlan.capabilityMapping?.length,selectedCapabilityIds:routingPlan.selectedCapabilityIds,selectedToolNames:routingPlan.selectedToolNames,surfaces:routingPlan.surfaces},
    session:{status:'completed',failure:null,usage,usageSource:'thread/tokenUsage/updated',turnId:completion.message.params.turn.id},
    telemetry:{mainModelUsage:usage,usageSource:'thread/tokenUsage/updated',wallTimeMs:processClosed.elapsed_ms,timings:toolTimingMetrics(toolEvents),jevUsage:null,fileChanges:fileChanges(path.join(ROOT,'starter'),product),runtimeMetadata:{codexRuntimeVersion:proof.runtimeVersion,codexRuntimeHash:proof.runtimeHash,baselineId:proof.id}},
    evaluation,correctness:classifyCorrectness(evaluation)
  };
  const admission=assessBaseline(control,BASELINE_POLICIES.DIAGNOSTIC_REFERENCE);
  if(!admission.admitted)fail('CONTROL_BASELINE_EVIDENCE_INCOMPLETE',{admission});
  const record={schemaVersion:'jar.benchmark-control-baseline.v2',benchmarkId:BENCHMARK_ID,baselineId,status:'ACTIVE_DIAGNOSTIC_REFERENCE',baselineAcceptancePolicy:BASELINE_POLICIES.DIAGNOSTIC_REFERENCE,admission,createdAt:iso(),protocolVersion:PROTOCOL_VERSION,compatibilityEnvelope:compatibilityEnvelope({...offline.static,runtime}),control,mainModelTurnsStarted:turns,promotion:{sourceStatus:failed.status,sourceRecord:path.relative(repo,failedFile).replaceAll('\\','/'),correctedEvaluation:path.relative(repo,evaluationFile).replaceAll('\\','/'),reason:'Previously completed CONTROL satisfies the diagnostic-reference evidence policy; no new inference was consumed.'}};
  return{runDir,record};
}

export function promoteDiagnosticControl(repo,baselineId){const {runDir,record}=reconstructDiagnosticControl(repo,baselineId);activateBaseline(repo,runDir,record);return record;}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const baselineId=process.argv[2];
  if(!baselineId)fail('CONTROL_BASELINE_ID_REQUIRED');
  console.log(JSON.stringify(promoteDiagnosticControl(process.cwd(),baselineId),null,2));
}
