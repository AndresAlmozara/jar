export function normalizeNativeUsage(input,{source="adapter",scope="request",counterKind="delta",provider="main"}={}) {
  if(!input||typeof input!=="object")return {available:false,reason:"usage_missing"};
  const number=name=>Number.isFinite(input[name])&&input[name]>=0?input[name]:null,inputTotal=number("input_total"),inputCached=number("input_cached"),outputTotal=number("output_total"),reasoningOutput=number("reasoning_output");
  if(inputTotal===null||outputTotal===null)return {available:false,reason:"usage_semantics_incomplete"};
  if(inputCached!==null&&inputCached>inputTotal)return {available:false,reason:"cached_input_exceeds_total"};
  return {available:true,payload:{provider,input_total:inputTotal,input_cached:inputCached,input_uncached:inputCached===null?null:inputTotal-inputCached,output_total:outputTotal,reasoning_output:reasoningOutput,scope,counter_kind:counterKind,usage_source:source,completeness:"complete",native_request_key:input.native_request_key||null,native_counter_key:input.native_counter_key||null}};
}
