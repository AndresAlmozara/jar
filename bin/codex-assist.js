import { readFile, writeFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sha256, stableStringify } from '../packages/core/src/hash.js';
import { runtimeEffectResult } from '../packages/runtime-adapters/src/contracts.js';
import { surfaceConfig, verifySurfaceReceipt } from '../packages/runtime-adapters/codex/src/fixture-surfaces.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const readJson=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

export function verifyAssistReceipt(receipt,disposal){
  const {id,...body}=receipt;
  if(id!==`assist_${sha256(body)}`||!['codex.assist.execution.v1','codex.assist.execution.v2'].includes(receipt.schemaVersion))throw Error('Invalid execution receipt');
  if(receipt.result){
    const result=runtimeEffectResult({plan:receipt.plan,status:receipt.result.status,attemptId:receipt.result.attemptId,
      observed:receipt.result.observed,restoration:receipt.result.restoration});
    if(stableStringify(result)!==stableStringify(receipt.result)||receipt.plan.request.proposalId!==receipt.proposal.id
      ||receipt.proposal.invocation.invocation_id!==receipt.invocationId||receipt.plan.request.taskId!==receipt.taskId
      ||stableStringify(receipt.plan.request.exposedIds)!==stableStringify(receipt.policy.effectiveIds))throw Error('Receipt correlation mismatch');
  }
  if(receipt.status==='succeeded'&&(receipt.result?.status!=='applied'||receipt.result.restoration.status!=='restored'
    ||receipt.failureCode!==null||!receipt.restorationAttempted))throw Error('Unverified success');
  if(receipt.schemaVersion==='codex.assist.execution.v2'){
    const task=receipt.taskExecution,{id:taskId,...taskBody}=task??{};
    if(!task||taskId!==`coding_task_${sha256(taskBody)}`||task.status!=='passed'
      ||receipt.status!=='succeeded'&&receipt.jarOn)throw Error('Unverified coding-task success');
  }
  if(receipt.jarOn!==(receipt.mode==='ASSIST'&&receipt.status==='succeeded'))throw Error('Unverified JAR ON');
  if(disposal.schemaVersion!=='m12.disposal.v1'||disposal.ownedStateDisposed!==true||disposal.ownedProcessesRemaining!==0
    ||disposal.normalGuestStateCreated!==0||disposal.externalNetworkEnabled!==false)throw Error('Disposal not verified');
  return receipt;
}

export async function runAssistCommand({taskText,inventorySource,mode='ASSIST',provider='deterministic',prepareOnly=false,surfaces='none'}){
  const enabledSurfaces=surfaceConfig(surfaces);
  if(surfaces!=='none'&&inventorySource!=='coding-fixture')throw new TypeError('Surfaces require the reviewed coding-fixture');
  if(typeof taskText!=='string'||!taskText.trim()||taskText.length>8000||!['fixture','coding-fixture'].includes(inventorySource)
    ||!['ASSIST','CONTROL'].includes(mode)||!['deterministic','jev-mock'].includes(provider)
    ||inventorySource==='coding-fixture'&&provider!=='deterministic')
    throw new TypeError('Use --task, --inventory fixture|coding-fixture, --mode ASSIST|CONTROL, --strategy deterministic|jev-mock');
  if(process.platform!=='win32')throw new Error('Windows Sandbox is required');
  if(inventorySource==='coding-fixture'){
    const fixture=await readJson(join(root,'fixtures/m14-coding-task/fixture.json'));
    if(taskText!==fixture.task)throw new TypeError(`The reviewed coding fixture requires --task "${fixture.task}"`);
  }
  const base=join(root,'.jar');await mkdir(base,{recursive:true});
  const milestone=inventorySource==='coding-fixture'?'m14':'m13';
  const runRoot=await mkdtemp(join(base,`${milestone}-assist-`)),input=join(runRoot,'input'),output=join(runRoot,'output');
  await mkdir(input);await mkdir(output);
  const previous=await readJson(join(base,'m12-effect-input-v1/m12-manifest.json'));
  const paths=new Map();
  for(const file of previous.files){
    const source=resolve(base,'m12-effect-input-v1',file.relativePath);
    if(!source.startsWith(resolve(base,'m12-effect-input-v1')+'\\'))throw Error('Invalid inherited path');
    if(digest(await readFile(source))!==file.sha256)throw Error('M12 package integrity mismatch');
    paths.set(file.relativePath,source);
  }
  async function add(path){
    const rel=relative(root,path).replaceAll('\\','/');if(rel.startsWith('../'))throw Error('Escaped package');
    if(paths.get(rel)===path)return;paths.set(rel,path);
    if(/\.(js|mjs)$/.test(path))for(const match of (await readFile(path,'utf8')).matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g))
      await add(resolve(dirname(path),match[1]));
  }
  const additions=inventorySource==='coding-fixture'
    ? ['scripts/m14-assist-guest.mjs','scripts/m14-codex-session.mjs','scripts/m14-codex-task-driver.mjs','scripts/m12-effect-guest.ps1',
      'fixtures/m14-coding-task/fixture.json','fixtures/m14-coding-task/math.js','fixtures/m14-coding-task/test.mjs','fixtures/m14-coding-task/package.json']
    : ['scripts/m13-assist-guest.mjs','scripts/m12-effect-guest.ps1','fixtures/m13-codex-assist.json'];
  for(const path of additions)await add(join(root,path));
  if(enabledSurfaces.skills)for(const id of ['backend-patterns','tdd-workflow'])
    paths.set(`fixtures/m14-reviewed-skills/skills/${id}/SKILL.md`,join(root,`fixtures/ecc-mini/skills/${id}/SKILL.md`));
  const files=[];
  for(const [relativePath,source] of paths){const bytes=await readFile(source);await mkdir(dirname(join(input,relativePath)),{recursive:true});
    await copyFile(source,join(input,relativePath));files.push({relativePath,size:bytes.length,sha256:digest(bytes)});}
  const invocationId=`invocation_${randomUUID()}`,taskId=`task_${randomUUID()}`;
  const request=JSON.stringify({task:taskText,taskId,invocationId,mode,provider,inventory:inventorySource,surfaces});
  await writeFile(join(input,'m13-run.json'),request,{flag:'wx'});
  files.push({relativePath:'m13-run.json',size:Buffer.byteLength(request),sha256:digest(request)});
  const manifest=JSON.stringify({schemaVersion:'m12.isolated-package.v1',files},null,2)+'\n';
  await writeFile(join(input,'m12-manifest.json'),manifest,{flag:'wx'});
  const launcher=join(runRoot,'assist.wsb');
  const runner=inventorySource==='coding-fixture'?'m14-assist-guest':'m13-assist-guest';
  await writeFile(launcher,`<Configuration><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><PrinterRedirection>Disable</PrinterRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><MappedFolders><MappedFolder><HostFolder>${xml(input)}</HostFolder><SandboxFolder>C:\\M11\\input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>${xml(output)}</HostFolder><SandboxFolder>C:\\M11\\output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\M11\\input\\scripts\\m12-effect-guest.ps1 -Runner ${runner} -ExpectedManifestHash ${digest(manifest)}</Command></LogonCommand></Configuration>\n`,{flag:'wx'});
  const receiptPath=join(output,`${milestone}-assist-receipt.json`);
  if(prepareOnly)return {status:'prepared_not_executed',jarOn:false,mode,provider,surfaces,launcher,receiptPath,
    surfaceReceiptPath:join(output,'m14-surfaces-receipt.json'),runtimeLaunches:0,providerCalls:0};
  const child=spawn('C:/Windows/System32/WindowsSandbox.exe',[launcher],{windowsHide:true,stdio:'ignore'});
  await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    for(const name of ['m12-bootstrap-failure.json','m13-failure.json','m14-failure.json']){
      try{await readFile(join(output,name));throw new Error(`Guest failed; see ${join(output,name)}`);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    let disposal=null;
    try{disposal=await readJson(join(output,'m12-disposal.json'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    if(disposal){
      const receipt=verifyAssistReceipt(await readJson(receiptPath),disposal);
      if(receipt.taskId!==taskId||receipt.invocationId!==invocationId||receipt.mode!==mode)throw Error('Run binding mismatch');
      const surfaceReceipt=surfaces==='none'?null:verifySurfaceReceipt(await readJson(join(output,'m14-surfaces-receipt.json')),receipt);
      if(surfaceReceipt&&surfaceReceipt.requestedSurfaces!==surfaces)throw Error('Surface configuration mismatch');
      return {status:receipt.status,jarOn:receipt.jarOn,mode,strategy:receipt.strategyId,
        surfaceReceiptId:surfaceReceipt?.id??null,surfaceReceiptPath:surfaceReceipt?join(output,'m14-surfaces-receipt.json'):null,
        candidates:receipt.plan?.supportedIds??null,selected:receipt.policy?.effectiveIds??null,withheld:receipt.policy?.withheldIds??null,
        requested:receipt.plan?.request.exposedIds??null,observed:receipt.result?.observed.visibleIds??null,
        used:receipt.taskExecution?.usedCapabilityIds??null,taskStatus:receipt.taskExecution?.status??null,
        filesRead:receipt.taskExecution?.filesRead??null,filesModified:receipt.taskExecution?.filesModified??null,
        testsRun:receipt.taskExecution?.testsRun??null,toolFailures:receipt.taskExecution?.failedToolCalls??null,
        effectStatus:receipt.result?.status??'not_attempted',restorationStatus:receipt.result?.restoration.status??'not_attempted',
        failureCode:receipt.failureCode,receiptId:receipt.id,receiptPath};
    }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error(`Sandbox receipt timeout; inspect ${output}. JAR ON is unverified.`);
}
export const formatAssist=result=>result.status==='prepared_not_executed'
  ? `Codex ${result.mode}: prepared, not executed; JAR ON = false\nLauncher: ${result.launcher}\nReceipt: ${result.receiptPath}`
  : [`Codex ${result.mode}: ${result.status}; JAR ON = ${result.jarOn}`,`Strategy: ${result.strategy}`,
    `Candidates: ${result.candidates?.join(', ')??'unknown'}`,`Selected: ${result.selected?.join(', ')??'unknown'}`,
    `Requested: ${result.requested?.join(', ')??'unknown'}`,`Observed: ${result.observed?.join(', ')??'unknown'}`,
    `Used: ${result.used?.join(', ')??'not executed'}`,`Task: ${result.taskStatus??'not executed'}`,
    `Effect: ${result.effectStatus}; restoration: ${result.restorationStatus}`,`Receipt: ${result.receiptPath}`].join('\n');
