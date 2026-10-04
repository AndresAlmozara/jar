import {sha} from './common.mjs';
// HTTP schema repair only. The JAR strategy, threshold, policy and real provider stay unchanged.
// Noul criteria is an object, not a string: https://docs.typesafe.ai/api#noul
export function normalizeNoulQuestions(questions) {
  const result=structuredClone(questions);let repairs=0;
  for(const q of Object.values(result)){
    if(q?.type==='noul'&&typeof q.criteria==='string'){
      // Preserve the supplied YES definition verbatim. The API permits the NO description to be omitted.
      q.criteria={true:q.criteria};repairs++;
    }
  }
  return {questions:result,repairs};
}
export function compatibleClient(BaseClient,{emit,scrub,fetchImpl=globalThis.fetch,timeoutMs=15000}) {
  const observed=[];
  const loggedFetch=async(url,options)=>{
    const start=performance.now();
    try{
      const response=await fetchImpl(url,options);
      let details=null;
      if(!response.ok){try{details=(await response.clone().text()).slice(0,4096);}catch{}}
      const row={status:response.status,ok:response.ok,duration_ms:performance.now()-start,
        http_payload_sha256:sha(options?.body??''),request_id:response.headers?.get?.('x-request-id')??null,details:scrub.text(details??'')};
      observed.push(row);emit('typesafe_http',row);return response;
    }catch(e){emit('typesafe_http_error',{code:e.code??e.name,message:scrub.text(e.message)});throw e;}
  };
  const base=new BaseClient({timeoutMs,fetchImpl:loggedFetch});
  const client={get model(){return base.model;},listModels:options=>base.listModels(options),
    async systemOne(input){const fixed=normalizeNoulQuestions(input.questions);
      if(fixed.repairs)emit('compatibility_adapter',{id:'noul-string-criteria-to-true-object-v1',repairs:fixed.repairs});
      emit('typesafe_request',{requested_model:input.model??base.model,state:input.state,questions:fixed.questions});
      const result=await base.systemOne({...input,questions:fixed.questions});
      emit('typesafe_response',{model:result.model,answers:result.answers,usage:result.usage});return result;}};
  return {client,observed};
}
