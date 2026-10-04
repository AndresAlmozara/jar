// Benchmark-scoped app-server driver. Reuses JAR transport and policy-bound tool callback.
// Verification is deliberately OUTSIDE this driver: no 30-second Promise.race around VM teardown + boot.
import {DiagnosticError,errorInfo,sleep} from './common.mjs';
export async function runModelTurn({transport,thread,inputs,dynamicTools,executeTool,emit,scrub,
  timeoutMs=600000,rpcTimeoutMs=30000,toolTimeoutMs=240000,reasoningEffort=null,isCancelled=()=>false}) {
  let nextId=0,threadId=null,turnId=null,completed=null,finalSeen=false,aborted=false,queue=Promise.resolve();
  let failure=null,cleanup={settled:false},startedResult=null,usage=null;
  const pending=new Map(),used=new Set(),texts=[],ops=new Set();let doneYes,doneNo;
  const done=new Promise((y,n)=>{doneYes=y;doneNo=n;});done.catch(()=>{});
  const abort=(code,details=null)=>{
    if(aborted)return;aborted=true;const e=new DiagnosticError(code,details);doneNo(e);
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();
  };
  const request=(method,params)=>new Promise((resolve,reject)=>{
    if(aborted){reject(new DiagnosticError('SESSION_ABORTED'));return;}
    const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new DiagnosticError('RPC_TIMEOUT',{method}));},rpcTimeoutMs);
    pending.set(id,{resolve,reject,timer,method});
    try{transport.send({id,method,params});}catch(e){clearTimeout(timer);pending.delete(id);reject(e);}
  });
  const timer=setTimeout(()=>abort('MODEL_TURN_TIMEOUT'),timeoutMs);
  const cancellation=setInterval(()=>{if(isCancelled())abort('USER_INTERRUPTED');},200);
  const handler=message=>{
    emit('app_server_message',{message});
    if(message.method==='transport/failure'){abort('TRANSPORT_FAILED');return;}
    if(message.id!==undefined&&(message.result!==undefined||message.error!==undefined)){
      const waiter=pending.get(message.id);if(!waiter)return;
      pending.delete(message.id);clearTimeout(waiter.timer);
      if(message.error)waiter.reject(new DiagnosticError('APP_SERVER_RPC_FAILED',{method:waiter.method,error:message.error}));
      else waiter.resolve(message.result);return;
    }
    if(message.id!==undefined&&message.method){
      if(aborted)return;
      const p=message.params;
      if(message.method!=='item/tool/call'){
        transport.send({id:message.id,error:{code:-32601,message:'HUMAN_APPROVAL_REQUIRED'}});
        abort('HUMAN_APPROVAL_REQUIRED',{method:message.method});return;
      }
      if(!threadId||p?.threadId!==threadId||!dynamicTools.some(t=>t.name===p.tool)){
        transport.send({id:message.id,error:{code:-32602,message:'TOOL_POLICY_REJECTED'}});
        abort('TOOL_POLICY_REJECTED',{tool:p?.tool});return;
      }
      // Accept parallel requests but serialize actual workspace operations. No races or wider permissions.
      queue=queue.then(async()=>{
        if(aborted)return;
        const operation=Promise.resolve().then(()=>executeTool(p.tool,p.arguments??{}));ops.add(operation);
        let limit;
        try{
          const output=await Promise.race([operation,new Promise((_,no)=>{limit=setTimeout(()=>no(new DiagnosticError('TOOL_TIMEOUT',{tool:p.tool})),toolTimeoutMs);})]);
          used.add(p.tool);
          if(!aborted)transport.send({id:message.id,result:{success:output.success===true,contentItems:[{type:'inputText',text:JSON.stringify(output)}]}});
        }catch(e){abort(e.code??'TOOL_EXECUTION_FAILED',errorInfo(e,scrub));}
        finally{clearTimeout(limit);operation.finally(()=>ops.delete(operation)).catch(()=>{});}
      });queue.catch(e=>abort('TOOL_QUEUE_FAILED',errorInfo(e,scrub)));return;
    }
    if(message.method==='thread/tokenUsage/updated'&&message.params?.threadId===threadId){
      // Last TOTAL is cumulative. Never sum cumulative notifications or infer counts from characters.
      const total=message.params?.tokenUsage?.total;
      if(total&&Number.isSafeInteger(total.totalTokens))usage=structuredClone(total);
    }
    if(message.method==='item/completed'&&message.params?.threadId===threadId&&message.params?.item?.type==='agentMessage'){
      finalSeen=true;if(typeof message.params.item.text==='string')texts.push(message.params.item.text);
    }
    if(message.method==='turn/completed'){
      const p=message.params;
      if(!threadId||p?.threadId!==threadId||(turnId&&p.turn?.id!==turnId)){abort('TURN_ID_MISMATCH',{received:p?.turn?.id});return;}
      completed=p.turn;
      if(p.turn?.status==='completed')doneYes();else {
        const info=classifyProviderFailure(p.turn?.error);abort(info.code,{turn:p.turn,providerMessage:info.message});
      }
    }
  };
  const unsubscribe=transport.onMessage(handler);
  try{
    await transport.start();
    await request('initialize',{clientInfo:{name:'jar',title:'JAR',version:'0.1.0'},capabilities:{experimentalApi:true}});
    transport.send({method:'initialized'});
    startedResult=await request('thread/start',{...thread,dynamicTools});
    if(typeof startedResult?.thread?.id!=='string'||startedResult.cwd!==thread.cwd||startedResult.model!==thread.model
      ||startedResult.modelProvider!==thread.modelProvider||startedResult.approvalPolicy!=='never'
      ||startedResult.sandbox?.type!=='readOnly'||startedResult.sandbox.networkAccess!==false)
      throw new DiagnosticError('EFFECTIVE_THREAD_MISMATCH',{observed:startedResult,expected:thread});
    const observedEffort=startedResult.reasoningEffort??startedResult.thread?.reasoningEffort??null;
    if(reasoningEffort&&observedEffort!==null&&observedEffort!==reasoningEffort)
      throw new DiagnosticError('EFFECTIVE_EFFORT_MISMATCH',{requested:reasoningEffort,observed:observedEffort});
    threadId=startedResult.thread.id;
    const start=await request('turn/start',{threadId,cwd:thread.cwd,approvalPolicy:'never',...(reasoningEffort?{effort:reasoningEffort}:{}),input:inputs.map(i=>({type:'text',text:i.text,textElements:[]}))});
    turnId=start?.turn?.id;if(typeof turnId!=='string')throw new DiagnosticError('TURN_ID_MISSING');
    await done;await queue;
    if(aborted)throw new DiagnosticError('SESSION_ABORTED');
    if(completed?.id!==turnId)throw new DiagnosticError('TURN_ID_MISMATCH');
  }catch(e){failure=errorInfo(e,scrub);aborted=true;}
  finally{
    clearTimeout(timer);clearInterval(cancellation);
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new DiagnosticError('SESSION_CLOSED'));}pending.clear();
    unsubscribe();
    // Do not race verifier startup with in-flight workspace RPCs.
    if(ops.size){let t;try{await Promise.race([Promise.allSettled([...ops]),new Promise((_,no)=>{t=setTimeout(()=>no(new DiagnosticError('TOOLS_UNSETTLED')),toolTimeoutMs);})]);}
      catch(e){failure=errorInfo(e,scrub);}finally{clearTimeout(t);}}
    try{cleanup=await transport.dispose();}catch(e){failure=errorInfo(e,scrub);}
    if(cleanup?.settled!==true||ops.size)failure??={code:'MODEL_CLEANUP_UNSETTLED'};
  }
  return {schemaVersion:'jar.smoke-benchmark.model-turn.v1',status:failure?'infra_fail':'completed',failure,
    modelTurnStatus:completed?.status??'not_completed',threadId,turnId,modelFinalAnswerObserved:finalSeen,
    finalAnswers:texts,runtimeCleanupSettled:cleanup?.settled===true&&ops.size===0,toolsUsed:[...used].sort(),
    usage,usageSource:usage?'thread/tokenUsage/updated.tokenUsage.total':null,
    effectiveThread:startedResult,verifierStatus:'not_run_by_model_driver'};
}

export function classifyProviderFailure(error){
  let message=typeof error?.message==='string'?error.message:'Provider turn did not complete';
  try{const parsed=JSON.parse(message);message=parsed.detail??parsed.error?.message??message;}catch{}
  const code=/model.*(?:not supported|not available|does not exist)/i.test(message)?'MODEL_NOT_SUPPORTED_FOR_ACCOUNT'
    :/(?:usage limit|rate limit|quota|insufficient credits)/i.test(message)?'MODEL_USAGE_LIMIT'
    :/(?:unauthorized|invalid.*token|expired.*token|authentication)/i.test(message)?'MODEL_AUTH_REJECTED':'TURN_NOT_COMPLETED';
  return {code,message};
}
