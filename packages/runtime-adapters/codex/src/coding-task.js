import { freeze } from '../../../capability-exposure/src/contracts.js';
import { sha256, stableStringify } from '../../../core/src/hash.js';

const allowedPath=/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const strings=(value,label)=>{
  if(!Array.isArray(value)||value.some(v=>typeof v!=='string'||!v||!allowedPath.test(v))||new Set(value).size!==value.length)
    throw new TypeError(`Invalid ${label}`);
  return [...value].sort();
};

export function codingTaskAcceptance(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Coding-task acceptance required');
  const allowed=['fixtureId','taskTextHash','requiredCapabilityIds','expectedModifiedFiles','allowedFiles'];
  if(Object.keys(input).some(k=>!allowed.includes(k))||typeof input.fixtureId!=='string'||!input.fixtureId
    ||!/^[0-9a-f]{64}$/.test(input.taskTextHash))throw new TypeError('Invalid coding-task acceptance');
  const ids=strings(input.requiredCapabilityIds,'required capabilities');
  if(ids.some(id=>!id.startsWith('capability_')))throw new TypeError('Invalid required capability');
  const expectedModifiedFiles=strings(input.expectedModifiedFiles,'expected files');
  const allowedFiles=strings(input.allowedFiles,'allowed files');
  if(expectedModifiedFiles.some(path=>!allowedFiles.includes(path)))throw new TypeError('Expected file is not allowed');
  return freeze({fixtureId:input.fixtureId,taskTextHash:input.taskTextHash,requiredCapabilityIds:ids,
    expectedModifiedFiles,allowedFiles});
}

export function codingTaskReport(input,{acceptance,requestedIds}){
  const expected=codingTaskAcceptance(acceptance);
  const allowed=['schemaVersion','fixtureId','taskTextHash','status','observedCapabilityIds','usedCapabilityIds',
    'failedToolCalls','toolCallCount','filesRead','filesModified','testsRun','verification','timings'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k))
    ||input.schemaVersion!=='codex.coding-task-report.v1'||input.fixtureId!==expected.fixtureId
    ||input.taskTextHash!==expected.taskTextHash||!['passed','failed'].includes(input.status)
    ||!Number.isSafeInteger(input.toolCallCount)||input.toolCallCount<0)throw new TypeError('Invalid coding-task report');
  const observedCapabilityIds=strings(input.observedCapabilityIds,'observed capabilities');
  const usedCapabilityIds=strings(input.usedCapabilityIds,'used capabilities');
  const requested=[...requestedIds].sort();
  if(stableStringify(observedCapabilityIds)!==stableStringify(requested)
    ||usedCapabilityIds.some(id=>!observedCapabilityIds.includes(id)))throw new TypeError('Coding-task exposure mismatch');
  const failures=Array.isArray(input.failedToolCalls)?input.failedToolCalls.map(item=>{
    if(!item||typeof item!=='object'||Object.keys(item).some(k=>!['capabilityId','code'].includes(k))
      ||!observedCapabilityIds.includes(item.capabilityId)||typeof item.code!=='string'||!item.code)return null;
    return {capabilityId:item.capabilityId,code:item.code};
  }):null;
  if(!failures||failures.includes(null))throw new TypeError('Invalid tool failures');
  const filesRead=strings(input.filesRead,'read files'),filesModified=strings(input.filesModified,'modified files');
  if([...filesRead,...filesModified].some(path=>!expected.allowedFiles.includes(path)))throw new TypeError('Workspace escape observed');
  if(!Array.isArray(input.testsRun)||input.testsRun.some(t=>!t||typeof t!=='object'||Object.keys(t).some(k=>!['name','exitCode','passed'].includes(k))
    ||typeof t.name!=='string'||!Number.isSafeInteger(t.exitCode)||typeof t.passed!=='boolean')
    ||!input.verification||typeof input.verification!=='object'
    ||Object.keys(input.verification).some(k=>!['codeHash','expectedCodeHash','targetPassed','existingTestsPassed','forbiddenModifications'].includes(k))
    ||![input.verification.codeHash,input.verification.expectedCodeHash].every(v=>/^[0-9a-f]{64}$/.test(v))
    ||![input.verification.targetPassed,input.verification.existingTestsPassed].every(v=>typeof v==='boolean')
    ||!Array.isArray(input.verification.forbiddenModifications))throw new TypeError('Invalid verification result');
  const timings=input.timings;
  if(!timings||typeof timings!=='object'||Object.keys(timings).some(k=>!['executionMs','verificationMs'].includes(k))
    ||Object.values(timings).some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0))throw new TypeError('Invalid task timings');
  const passed=input.status==='passed'&&failures.length===0
    &&expected.requiredCapabilityIds.every(id=>usedCapabilityIds.includes(id))
    &&expected.expectedModifiedFiles.every(path=>filesModified.includes(path))
    &&input.testsRun.length>0&&input.testsRun.every(t=>t.passed)
    &&input.verification.targetPassed&&input.verification.existingTestsPassed
    &&input.verification.codeHash===input.verification.expectedCodeHash
    &&input.verification.forbiddenModifications.length===0;
  const body={schemaVersion:input.schemaVersion,fixtureId:input.fixtureId,taskTextHash:input.taskTextHash,
    status:passed?'passed':'failed',observedCapabilityIds,usedCapabilityIds,failedToolCalls:failures,
    toolCallCount:input.toolCallCount,filesRead,filesModified,testsRun:input.testsRun.map(t=>({...t})),
    verification:{...input.verification,forbiddenModifications:[...input.verification.forbiddenModifications].sort()},timings:{...timings}};
  return freeze({...body,id:`coding_task_${sha256(body)}`});
}
