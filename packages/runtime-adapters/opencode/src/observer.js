import path from "node:path";
import { JsonlTelemetryStore } from "../../../telemetry/src/jsonl-store.js";
import { sha256 } from "../../../core/src/hash.js";
import { TelemetryRecorder } from "../../../telemetry/src/recorder.js";

function str(x) { return typeof x === "string" ? x : x == null ? null : JSON.stringify(x); }
function taskIdFrom(sessionId, prompt) { return `oc_${sha256(`${sessionId ?? "nosession"}:${prompt ?? ""}`).slice(0,16)}`; }
class MemoryTelemetryStore {
  constructor(){this.events=[]}
  append(event){this.events.push(event);return event}
  readAll(){return [...this.events]}
  byTask(taskId){return this.events.filter(x=>x.task_id===taskId)}
}

export class OpenCodeObserver {
  constructor({directory=process.cwd(), traceFile=null, runtime="opencode", jarHome=null, current=null}={}) {
    this.directory=path.resolve(directory);
    this.traceFile=traceFile;
    this.store=traceFile?new JsonlTelemetryStore(traceFile):new MemoryTelemetryStore();
    this.recorder=new TelemetryRecorder({jarHome,current,adapterId:"opencode-observer",adapterVersion:"1",hostRuntimeVersion:null,dataOrigin:"production"});
    this.runtime=runtime;
    this.sessionId=null;
    this.currentTaskId=null;
    this.currentPrompt=null;
    this.visibleSkills=null;
    this.activeTools=[];
  }

  emit(event_type,payload={}) {
    const task_id=payload.task_id ?? this.currentTaskId ?? `session_${this.sessionId ?? "unknown"}`;
    return this.store.append({event_type,task_id,session_id:this.sessionId,runtime:this.runtime,payload,...payload});
  }

  onSessionCreated(event={}) {
    this.sessionId=str(event.sessionID ?? event.id ?? event.session?.id ?? event.sessionId) ?? `unknown-${Date.now()}`;
    this.emit("execution_observation",{task_id:`session_${this.sessionId}`,payload:{kind:"session.created"}});
    this.recorder.recordBestEffort("session.observed",{identifiers:{session:this.sessionId,actor:event.agentID||null},correlation_status:"partial",correlation_missing_reason:"native_turn_id_missing",coverage:{integration:"opencode",supported:true},payload:{phase:"start",kind:"session.created"}});
  }

  onPrompt(event={}) {
    const prompt=str(event.prompt?.text ?? event.text ?? event.prompt ?? event.message?.text ?? event.parts?.map?.((p)=>p.text).filter(Boolean).join(" ")) ?? "";
    const sessionId=str(event.sessionID ?? event.sessionId ?? event.session?.id) ?? this.sessionId;
    if (sessionId) this.sessionId=sessionId;
    this.currentPrompt=prompt;
    this.currentTaskId=taskIdFrom(this.sessionId,prompt);
    this.emit("task_snapshot",{payload:{promptHash:sha256(prompt),promptBytes:Buffer.byteLength(prompt),selectedSkills:event.prompt?.skills ?? event.skills ?? []}});
    this.recorder.recordBestEffort("hook.finished",{identifiers:{session:this.sessionId,turn:event.turnID||event.turnId||null,actor:event.agentID||null},correlation_status:event.turnID||event.turnId?"exact":"partial",correlation_missing_reason:event.turnID||event.turnId?null:"native_turn_id_missing",coverage:{integration:"opencode",supported:true},payload:{hook_kind:"chat.message",outcome:"success",prompt_bytes:Buffer.byteLength(prompt),prompt_characters:prompt.length,prompt_fingerprint:this.recorder.id("prompt",prompt)}});
    return this.currentTaskId;
  }

  onContext(event={}) {
    const tools=event.tools && typeof event.tools === "object" ? Object.keys(event.tools) : [];
    this.activeTools=tools;
    this.emit("execution_observation",{tools_exposed:tools,payload:{kind:"model.context",messageCount:Array.isArray(event.messages)?event.messages.length:null,systemCount:Array.isArray(event.system)?event.system.length:null}});
  }

  onFileEdited(event={}) { this.emit("execution_observation",{context_items:[event.path?sha256(String(event.path)):null].filter(Boolean),payload:{kind:"file.edited"}}); }
  onToolBefore(event={}) { const tool=str(event.tool),id=event.callID||event.callId||event.id||null;this.emit("execution_observation",{tools_called:[tool].filter(Boolean),payload:{kind:"tool.before",inputHash:sha256(event.input ?? event.args ?? null)}});this.recorder.recordBestEffort("tool.started",{identifiers:{session:this.sessionId,turn:event.turnID||event.turnId||null,actor:event.agentID||null,toolInvocation:id},correlation_status:id&&event.turnID||id&&event.turnId?"exact":"partial",correlation_missing_reason:id?"native_turn_id_missing":"tool_invocation_id_missing",coverage:{integration:"opencode",supported:true},payload:{tool_name:tool,tool_category:"host_tool",argument_fingerprint:this.recorder.id("tool-arguments",JSON.stringify(event.input??event.args??null)),extraction_coverage:"unknown"}}); }
  onToolAfter(event={}) { const tool=str(event.tool),id=event.callID||event.callId||event.id||null;this.emit("execution_observation",{tools_called:[tool].filter(Boolean),payload:{kind:"tool.after",ok:!event.error,errorCode:event.error?"tool_error":null}});this.recorder.recordBestEffort("tool.finished",{identifiers:{session:this.sessionId,turn:event.turnID||event.turnId||null,actor:event.agentID||null,toolInvocation:id},correlation_status:id&&event.turnID||id&&event.turnId?"exact":"partial",correlation_missing_reason:id?"native_turn_id_missing":"tool_invocation_id_missing",coverage:{integration:"opencode",supported:true},payload:{tool_name:tool,tool_category:"host_tool",failed:Boolean(event.error),unfinished:false}}); }
  onSessionIdle() { this.emit("execution_receipt",{payload:{kind:"session.idle"},task_outcome:"observed_complete"});this.recorder.recordBestEffort("session.observed",{identifiers:{session:this.sessionId},correlation_status:"partial",correlation_missing_reason:"native_turn_id_missing",coverage:{integration:"opencode",supported:true},payload:{phase:"idle",kind:"session.idle"}}); }
  onSessionError() { this.emit("execution_receipt",{payload:{kind:"session.error",code:"runtime_error"},task_outcome:"runtime_error"});this.recorder.recordBestEffort("session.observed",{identifiers:{session:this.sessionId},correlation_status:"partial",correlation_missing_reason:"native_turn_id_missing",severity:"error",coverage:{integration:"opencode",supported:true},payload:{phase:"error",kind:"session.error",code:"OPENCODE_SESSION_ERROR"}}); }

  async capabilities() { return {runtime:this.runtime,observation:true,mutation:false,skill_visibility:"unknown",tool_visibility:"unknown",effort:"advisory"}; }
  async snapshot() { return {runtime:this.runtime,sessionId:this.sessionId,visibleSkills:this.visibleSkills,activeTools:this.activeTools,model:null,effort:null,metadata:{traceFile:this.traceFile,directory:this.directory}}; }
  async apply() { throw new Error("M0-M3 observer is read-only; route application is intentionally disabled"); }
}
