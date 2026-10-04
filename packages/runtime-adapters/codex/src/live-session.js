import { sha256 } from '../../../core/src/hash.js';
import { bounded } from './live-transport.js';

const fail=code=>Object.assign(Error(code),{code});
// Transport owns process containment. This loop never authorizes extra tools,
// permissions, credentials or model requests outside the supplied single turn.
export async function driveLiveSession({transport,thread,inputs,dynamicTools,executeTool,verify,
  timeoutMs=120000,rpcTimeoutMs=15000}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isSafeInteger(rpcTimeoutMs)
    ||rpcTimeoutMs<1||rpcTimeoutMs>15000)throw fail('TIMEOUT_INVALID');
  let id=0,threadId=null,turnId=null,completedTurnId=null,turnStatus='not_started',failureCode=null,finalAnswerObserved=false,aborted=false;
  let resolveDone,rejectDone,active=false,outstandingTools=0;const pending=new Map(),used=new Set();
  const done=new Promise((yes,no)=>{resolveDone=yes;rejectDone=no;});done.catch(()=>{});
  const abort=code=>{aborted=true;rejectDone(fail(code));for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.no(fail(code));}pending.clear();};
  const timers=new Set();const deadline=setTimeout(()=>abort('LIVE_TIMEOUT'),timeoutMs);
  const request=(method,params)=>new Promise((yes,no)=>{
    if(aborted){no(fail('SESSION_ABORTED'));return;}
    const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);no(fail('RPC_TIMEOUT'));},rpcTimeoutMs);timers.add(timer);
    pending.set(requestId,{yes,no,timer});transport.send({id:requestId,method,params});
  });
  const reject=abort;
  const unsubscribe=transport.onMessage(async message=>{
    if(message.method==='transport/failure'){reject('TRANSPORT_FAILED');return;}
    if(message.id!==undefined&&(message.result!==undefined||message.error!==undefined)){
      const waiter=pending.get(message.id);if(!waiter)return;
      pending.delete(message.id);clearTimeout(waiter.timer);
      message.error?waiter.no(fail('APP_SERVER_RPC_FAILED')):waiter.yes(message.result);return;
    }
    if(message.id!==undefined&&message.method){
      if(aborted)return;
      const p=message.params;
      if(message.method!=='item/tool/call'){
        transport.send({id:message.id,error:{code:-32601,message:'HUMAN_APPROVAL_REQUIRED'}});
        reject('HUMAN_APPROVAL_REQUIRED');return;
      }
      if(active||!threadId||p?.threadId!==threadId||!dynamicTools.some(t=>t.name===p.tool)){
        transport.send({id:message.id,error:{code:-32602,message:'TOOL_POLICY_REJECTED'}});reject('TOOL_POLICY_REJECTED');return;
      }
      active=true;
      try{
        outstandingTools++;
        const operation=Promise.resolve().then(()=>executeTool(p.tool,p.arguments??{})).finally(()=>{outstandingTools--;});
        const output=await bounded(operation,30000);used.add(p.tool);
        if(aborted)return;
        transport.send({id:message.id,result:{success:output.success===true,
          contentItems:[{type:'inputText',text:JSON.stringify(output)}]}});
      }catch{reject('TOOL_EXECUTION_FAILED');}
      finally{active=false;}return;
    }
    if(message.method==='item/completed'&&message.params?.threadId===threadId&&message.params?.item?.type==='agentMessage')finalAnswerObserved=true;
    if(message.method==='turn/completed'){
      const p=message.params;
      if(!threadId||p?.threadId!==threadId||(turnId&&p.turn?.id!==turnId)){reject('TURN_ID_MISMATCH');return;}
      if(active){reject('TOOL_STILL_ACTIVE');return;}
      turnStatus=['completed','failed','interrupted'].includes(p.turn?.status)?p.turn.status:'unknown';
      completedTurnId=p.turn?.id;
      turnStatus==='completed'?resolveDone():reject('TURN_NOT_COMPLETED');
    }
  });
  let cleanup={settled:false},verifier={status:'not_run'};
  try{
    await bounded(transport.start(),rpcTimeoutMs);
    await request('initialize',{clientInfo:{name:'jar',title:'JAR',version:'0.1.0'},capabilities:{experimentalApi:true}});
    transport.send({method:'initialized'});
    const started=await request('thread/start',{...thread,dynamicTools});
    if(typeof started?.thread?.id!=='string'||started.cwd!==thread.cwd||started.model!==thread.model
      ||started.modelProvider!==thread.modelProvider||started.approvalPolicy!=='never'
      ||started.sandbox?.type!=='readOnly'||started.sandbox.networkAccess!==false)throw fail('EFFECTIVE_THREAD_MISMATCH');
    threadId=started.thread.id;
    const turn=await request('turn/start',{threadId,cwd:thread.cwd,approvalPolicy:'never',
      input:inputs.map(item=>({type:'text',text:item.text,textElements:[]}))});
    turnId=turn?.turn?.id;if(typeof turnId!=='string')throw fail('TURN_ID_MISSING');
    await done;
    if(completedTurnId!==turnId)throw fail('TURN_ID_MISMATCH');
  }catch(error){failureCode=['LIVE_TIMEOUT','RPC_TIMEOUT','SESSION_ABORTED','APP_SERVER_RPC_FAILED','TRANSPORT_FAILED',
    'HUMAN_APPROVAL_REQUIRED','TOOL_POLICY_REJECTED','TOOL_EXECUTION_FAILED','TURN_ID_MISMATCH','TOOL_STILL_ACTIVE',
    'TURN_NOT_COMPLETED','EFFECTIVE_THREAD_MISMATCH','TURN_ID_MISSING'].includes(error.code)?error.code:'LIVE_SESSION_FAILED';}
  finally{
    clearTimeout(deadline);for(const timer of timers)clearTimeout(timer);
    for(const waiter of pending.values())waiter.no(fail('SESSION_CLOSED'));pending.clear();unsubscribe();
    try{cleanup=await bounded(transport.dispose(),15000);}catch{cleanup={settled:false};}
  }
  if(!failureCode&&turnStatus==='completed'&&cleanup.settled===true&&!active&&outstandingTools===0){
    try{verifier=await bounded(verify({nativeTurnCompleted:true,runtimeSettled:true,modelFinalAnswerObserved:finalAnswerObserved}),30000);}
    catch{verifier={status:'failed'};}
  }
  const body={schemaVersion:'jar.live-session.v1',modelTurnStatus:turnStatus,modelFinalAnswerObserved:finalAnswerObserved,
    verifierStatus:verifier.status==='passed'?'passed':verifier.status==='not_run'?'not_run':'failed',
    runtimeCleanupSettled:cleanup.settled===true&&outstandingTools===0,failureCode,toolsUsed:[...used].sort(),
    effectiveObservedToolIds:null,observationScope:'tool_call_events_not_full_request',
    status:!failureCode&&turnStatus==='completed'&&verifier.status==='passed'&&cleanup.settled===true?'passed':'failed'};
  return {id:sha256(body),...body};
}
