import { randomUUID } from "node:crypto";
import { sha256 } from "../../../core/src/hash.js";
import { TypeSafeClient, TypeSafeProviderError } from "./typesafe-client.js";

const IMPLEMENTATION_VERSION="jev/typesafe-v1";

function assertAnswer(answer,type) {
  if (!answer || typeof answer!=="object" || answer.type!==type) throw new TypeSafeProviderError("unexpected_response",`TypeSafe returned an invalid ${type} answer`);
  const record=(value)=>value && typeof value==="object" && !Array.isArray(value);
  const number=(value)=>typeof value==="number" && Number.isFinite(value);
  if (type==="choice" && (typeof answer.choice!=="string" || !number(answer.confidence) || !record(answer.probabilities))) throw new TypeSafeProviderError("unexpected_response","TypeSafe returned an invalid choice answer");
  if (type==="noul" && (!number(answer.noul) || answer.noul<0 || answer.noul>1)) throw new TypeSafeProviderError("unexpected_response","TypeSafe returned an invalid noul answer");
  if (type==="score" && (!number(answer.score) || !number(answer.confidence) || !record(answer.legend) || !record(answer.probabilities))) throw new TypeSafeProviderError("unexpected_response","TypeSafe returned an invalid score answer");
}

function questionEntries(questions) {
  if (!Array.isArray(questions) || !questions.length) throw new TypeError("questions must be a non-empty array");
  const seen=new Set();
  return questions.map((item)=>{
    if (!item || typeof item!=="object" || typeof item.id!=="string" || !/^[a-z0-9_.:-]+$/i.test(item.id) || seen.has(item.id)) {
      throw new TypeError("question IDs must be unique stable identifiers");
    }
    seen.add(item.id);
    return [item.id,{type:"noul",instructions:item.instructions ?? null,criteria:item.criteria ?? null}];
  });
}

export class JevDecisionEngine {
  constructor({client=new TypeSafeClient(),onTelemetry=null}={}) { this.client=client; this.onTelemetry=onTelemetry; }
  listModels(options) { return this.client.listModels(options); }

  async decide(primitive,input,question) {
    const requestId=randomUUID();
    const questionName=input.questionName ?? "decision";
    const started=performance.now();
    const decision_context=input.decisionContext
      ? Object.fromEntries(["invocation_id","caller","component","session_id","operation","operation_id","call_id"]
        .filter((key)=>typeof input.decisionContext[key]==="string")
        .map((key)=>[key,input.decisionContext[key]]))
      : null;
    const state_hash=sha256(input.state??null);
    const baseEvent={event_type:"decision_provider_result",task_id:input.taskId ?? requestId,component:"decision",provider:"typesafe",primitive,strategy:IMPLEMENTATION_VERSION,fallback:null,request_id:requestId,decision_context,state_hash,request_hash:sha256({model:input.model ?? this.client.model,questionName,question,state_hash})};
    baseEvent.requested_model=input.model??this.client.model;
    try {
      const raw=await this.client.systemOne({state:input.state,model:input.model,questions:{[questionName]:question},signal:input.signal});
      const latency_ms=Math.round((performance.now()-started)*1000)/1000;
      const answer=raw.answers[questionName];
      assertAnswer(answer,primitive);
      const common={primitive,provider:{name:"typesafe",model:raw.model,request_id:requestId,implementation:IMPLEMENTATION_VERSION},usage:{input_tokens:raw.usage.input_tokens,output_tokens:raw.usage.output_tokens},latency_ms,raw};
      let normalized;
      if (primitive==="choice") normalized={...common,choice:answer.choice,probabilities:answer.probabilities,confidence:answer.confidence};
      else if (primitive==="noul") normalized={...common,probability_true:answer.noul,probability_false:1-answer.noul};
      else normalized={...common,score:answer.score,legend:answer.legend,probabilities:answer.probabilities,confidence:answer.confidence};
      const event={...baseEvent,provider_model:raw.model,latency_ms,input_tokens:raw.usage.input_tokens,output_tokens:raw.usage.output_tokens,confidence:normalized.confidence ?? null,candidate_count:primitive==="choice"?Object.keys(input.criteria).length:null,selected_value:normalized.choice ?? normalized.score ?? normalized.probability_true,probabilities:normalized.probabilities ?? (primitive==="noul"?{true:normalized.probability_true,false:normalized.probability_false}:null),success:true};
      normalized.telemetry=event;
      await this.emit(event);
      return normalized;
    } catch (error) {
      const safeError=error instanceof TypeSafeProviderError?error:new TypeSafeProviderError("unexpected_response","TypeSafe decision failed",{cause:error});
      await this.emit({...baseEvent,provider_model:null,latency_ms:Math.round((performance.now()-started)*1000)/1000,input_tokens:null,output_tokens:null,confidence:null,candidate_count:primitive==="choice"?Object.keys(input.criteria ?? {}).length:null,selected_value:null,probabilities:null,success:false,error_code:safeError.code});
      throw safeError;
    }
  }

  emit(event) { return this.onTelemetry?Promise.resolve(this.onTelemetry(event)):Promise.resolve(); }
  choice(input) { return this.decide("choice",input,{type:"choice",instructions:input.instructions ?? null,criteria:input.criteria}); }
  noul(input) { return this.decide("noul",input,{type:"noul",instructions:input.instructions ?? null,criteria:input.criteria ?? null}); }
  async noulBatch(input) {
    const entries=questionEntries(input.questions), questions=Object.fromEntries(entries), questionIds=entries.map(([id])=>id);
    const requestId=randomUUID(), started=performance.now(), state_hash=sha256(input.state??null);
    const decision_context=input.decisionContext
      ? Object.fromEntries(["invocation_id","caller","component","session_id","operation","operation_id","call_id"]
        .filter((key)=>typeof input.decisionContext[key]==="string")
        .map((key)=>[key,input.decisionContext[key]]))
      : null;
    const baseEvent={event_type:"decision_provider_result",task_id:input.taskId ?? requestId,component:"decision",provider:"typesafe",
      primitive:"noul_batch",strategy:IMPLEMENTATION_VERSION,fallback:null,request_id:requestId,decision_context,state_hash,
      request_hash:sha256({model:input.model ?? this.client.model,questions,state_hash}),requested_model:input.model??this.client.model,
      question_count:questionIds.length,question_ids:questionIds};
    try {
      const raw=await this.client.systemOne({state:input.state,model:input.model,questions,signal:input.signal});
      const failedQuestionIds=[];
      for (const id of questionIds) {
        try { assertAnswer(raw.answers[id],"noul"); }
        catch { failedQuestionIds.push(id); }
      }
      if (failedQuestionIds.length) {
        const error=new TypeSafeProviderError("partial_response","TypeSafe returned invalid answers for part of a batch");
        error.failedQuestionIds=failedQuestionIds;
        throw error;
      }
      const latency_ms=Math.round((performance.now()-started)*1000)/1000;
      const provider={name:"typesafe",model:raw.model,request_id:requestId,implementation:IMPLEMENTATION_VERSION};
      const answers=Object.fromEntries(questionIds.map((id)=>[id,{primitive:"noul",probability_true:raw.answers[id].noul,
        probability_false:1-raw.answers[id].noul,provider:{...provider,question_id:id}}]));
      const event={...baseEvent,provider_model:raw.model,latency_ms,input_tokens:raw.usage.input_tokens,output_tokens:raw.usage.output_tokens,
        confidence:null,candidate_count:null,selected_value:null,selected_values:Object.fromEntries(questionIds.map(id=>[id,answers[id].probability_true])),
        probabilities:null,success:true};
      const normalized={primitive:"noul_batch",answers,provider,usage:{input_tokens:raw.usage.input_tokens,output_tokens:raw.usage.output_tokens},latency_ms,raw,telemetry:event};
      await this.emit(event);
      return normalized;
    } catch (error) {
      const safeError=error instanceof TypeSafeProviderError?error:new TypeSafeProviderError("unexpected_response","TypeSafe batch decision failed",{cause:error});
      await this.emit({...baseEvent,provider_model:null,latency_ms:Math.round((performance.now()-started)*1000)/1000,input_tokens:null,
        output_tokens:null,confidence:null,candidate_count:null,selected_value:null,probabilities:null,success:false,error_code:safeError.code,
        failed_question_ids:Array.isArray(safeError.failedQuestionIds)?safeError.failedQuestionIds:[]});
      throw safeError;
    }
  }
  score(input) { return this.decide("score",input,{type:"score",instructions:input.instructions ?? null,criteria:input.criteria}); }
}
