import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm, lstat, access } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createShadowDelivery } from '../packages/runtime-adapters/codex/src/fixture-surfaces.js';

const [codexPath,inputsPath,statePath,...extra]=process.argv.slice(2);
if(!codexPath||!inputsPath||!statePath||extra.length)throw Error('INVALID_DRIVER_ARGUMENTS');
const digest=value=>createHash('sha256').update(value).digest('hex');
const state={schemaVersion:'m14.coding-driver-state.v1',status:'RUNNING',failureCode:null,codexProcessStarted:false,codexExitCode:null,
  turnCompleted:false,toolCalls:[],filesRead:[],filesModified:[],testsRun:[],promptsPersisted:false,rawRequestBodiesPersisted:false};
let writes=Promise.resolve();const persist=()=>{const snapshot=JSON.stringify(state)+'\n';writes=writes.then(()=>writeFile(statePath,snapshot));return writes;};
const fail=code=>Object.assign(new Error(code),{code});
const input=JSON.parse(await readFile(inputsPath,'utf8')),project=resolve(input.projectRoot);
const shadow=input.outputShadow?createShadowDelivery():null;state.outputShadow=[];
const allowed=new Set(input.allowedFiles);
function ownedPath(value,{existing=true}={}){
  if(typeof value!=='string'||!allowed.has(value)||value.includes('\\'))throw fail('WORKSPACE_ESCAPE_BLOCKED');
  const path=resolve(project,value),rel=relative(project,path);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`))throw fail('WORKSPACE_ESCAPE_BLOCKED');
  if(existing)return lstat(path).then(stat=>{if(stat.isSymbolicLink())throw fail('WORKSPACE_ESCAPE_BLOCKED');return path;});
  return Promise.resolve(path);
}
const runNode=()=>new Promise(resolveRun=>{
  const child=spawn(process.execPath,['test.mjs'],{cwd:project,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,
    PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,TEMP:process.env.TEMP,TMP:process.env.TMP},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const chunks=[];let bytes=0;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{if(bytes<16384){bytes+=chunk.length;chunks.push(chunk);}});
  child.once('error',()=>resolveRun({exitCode:127,passed:false,outputHash:digest('spawn-error')}));
  child.once('exit',code=>resolveRun({exitCode:code??127,passed:code===0,outputHash:digest(Buffer.concat(chunks))}));
});
let stopProviderWait=false;
const waitForProviderSequence=async()=>{
  const deadline=Date.now()+60000;
  while(!stopProviderWait&&Date.now()<deadline){try{await access(input.completionPath);return 'provider';}catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(yes=>setTimeout(yes,100));}
  if(!stopProviderWait)throw fail('PROVIDER_SEQUENCE_TIMEOUT');return 'cancelled';
};
async function execute(params){
  const id=input.toolCapabilityIds[params.tool];let success=true,code='OK',text='';
  try{
    if(!id||!input.dynamicTools.some(tool=>tool.name===params.tool))throw fail('UNEXPOSED_TOOL');
    if(params.tool==='workspace_read'){
      const path=await ownedPath(params.arguments?.path),value=await readFile(path,'utf8');
      if(value.length>16384)throw fail('READ_LIMIT');state.filesRead.push(params.arguments.path);text=value;
    }else if(params.tool==='workspace_write'){
      if(typeof params.arguments?.content!=='string'||params.arguments.content.length>16384)throw fail('WRITE_LIMIT');
      const path=await ownedPath(params.arguments.path);await writeFile(path,params.arguments.content,{flag:'w'});
      state.filesModified.push(params.arguments.path);text='written';
    }else if(params.tool==='workspace_test'){
      const result=await runNode();state.testsRun.push({name:'node test.mjs',exitCode:result.exitCode,passed:result.passed});
      success=result.passed;code=result.passed?'OK':'TEST_FAILED';text=result.passed?'tests passed':'tests failed';
    }else if(params.tool==='workspace_delete'){
      const path=await ownedPath(params.arguments?.path);await rm(path);state.filesModified.push(params.arguments.path);text='deleted';
    }else throw fail('UNKNOWN_TOOL');
  }catch(error){success=false;code=error.code??'TOOL_FAILED';text=code;}
  state.toolCalls.push({capabilityId:id??null,name:params.tool,success,code});await persist();
  if(shadow){const delivered=await shadow.deliver({text,success,toolInvocationId:params.callId??`call-${state.toolCalls.length}`,
    capabilityId:id??'unknown',taskId:input.taskId,sessionId:input.sessionId,sequence:state.toolCalls.length-1});
    state.outputShadow.push(delivered.evidence);await persist();}
  return {contentItems:[{type:'inputText',text}],success};
}

let child,childExit=null,buffer='',rpcId=0,turnSettled=false,resolveTurn,rejectTurn;
const pending=new Map(),turnDone=new Promise((yes,no)=>{resolveTurn=yes;rejectTurn=no;});turnDone.catch(()=>{});
const send=(method,params,code)=>new Promise((yes,no)=>{const id=++rpcId,timer=setTimeout(()=>{pending.delete(String(id));no(fail('DRIVER_TIMEOUT'));},30000);
  pending.set(String(id),{yes,no,timer,code});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
try{
  child=spawn(codexPath,['-c','cli_auth_credentials_store="ephemeral"','app-server','--stdio','--strict-config'],{
    cwd:project,env:process.env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',()=>no(fail('CODEX_START_FAILED')));});
  state.codexProcessStarted=true;await persist();child.stderr.resume();child.stdin.on('error',()=>{});child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(!line)continue;
    let message;try{message=JSON.parse(line);}catch{rejectTurn(fail('PROTOCOL_FAILURE'));continue;}
    if(message.id!==undefined&&(message.result!==undefined||message.error!==undefined)){
      const waiter=pending.get(String(message.id));if(waiter){pending.delete(String(message.id));clearTimeout(waiter.timer);message.error?waiter.no(fail(waiter.code)):waiter.yes(message.result);}
    }else if(message.id!==undefined&&message.method==='item/tool/call'){
      execute(message.params).then(result=>child.stdin.write(JSON.stringify({id:message.id,result})+'\n'),()=>child.stdin.write(JSON.stringify({id:message.id,result:{contentItems:[{type:'inputText',text:'tool failed'}],success:false}})+'\n'));
    }else if(message.id!==undefined&&message.method){child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'unsupported'}})+'\n');}
    else if(message.method==='turn/completed'&&!turnSettled){turnSettled=true;message.params?.turn?.status==='completed'?resolveTurn():rejectTurn(fail('TURN_FAILED'));}
  }});
  child.once('exit',(code,signal)=>{childExit={code,signal};for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.no(fail(waiter.code));}pending.clear();if(!turnSettled){turnSettled=true;rejectTurn(fail('CODEX_EXITED'));}});
  await send('initialize',{clientInfo:{name:'m14-coding-task',title:'M14 coding task',version:'1.0.0'},capabilities:{experimentalApi:true}},'INITIALIZE_FAILED');
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  const thread=await send('thread/start',{...input.threadStartCommon,dynamicTools:input.dynamicTools},'THREAD_START_FAILED');
  const threadId=thread?.thread?.id;if(typeof threadId!=='string')throw fail('THREAD_START_FAILED');
  await send('turn/start',{threadId,input:[{type:'text',text:input.task,textElements:[]},...(input.surfaceInputs??[])],cwd:project,approvalPolicy:'never'},'TURN_START_FAILED');
  const completion=await Promise.race([turnDone.then(()=> 'turn',()=> 'turn_failed'),waitForProviderSequence()]);
  if(completion==='turn_failed')throw fail('TURN_FAILED');
  stopProviderWait=true;state.turnCompleted=completion==='turn';
  try{await access(input.completionPath);state.providerSequenceCompleted=true;}catch{state.providerSequenceCompleted=false;}
  child.stdin.end();
  if(!childExit){
    const graceful=await Promise.race([new Promise(yes=>child.once('exit',(code,signal)=>yes({code,signal}))),new Promise(yes=>setTimeout(()=>yes(null),1000))]);
    if(graceful)childExit=graceful;else{
      const killer=spawn('C:/Windows/System32/taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      await new Promise(yes=>{killer.once('error',yes);killer.once('exit',yes);});
      if(!childExit)childExit=await new Promise(yes=>child.once('exit',(code,signal)=>yes({code,signal})));
      state.completedTurnTermination=true;
    }
  }
  state.codexExitCode=childExit.code;
  if(!state.completedTurnTermination&&(childExit.code!==0||childExit.signal!==null))throw fail('CODEX_EXITED');state.status='SUCCEEDED';await persist();
}catch(error){state.status='FAILED';state.failureCode=error.code??'DRIVER_FAILED';try{if(child&&child.exitCode===null)child.kill();}catch{}await persist();process.exitCode=2;}
finally{stopProviderWait=true;shadow?.clear();}
