import { sha256 } from "../../core/src/hash.js";
import { METRIC_DEFINITION_VERSION } from "./config.js";

const percentile=(values,p)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),index=Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*p)-1));return sorted[index]};
const dayOf=(event,timeZone)=>new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(event.occurred_at_utc||event.observed_at_utc));
const jsonLine=value=>JSON.stringify(value);

function toolKey(event) { return event.tool_invocation_id || `unlinked:${event.event_id}`; }
function turnKey(event) { return [event.installation_id,event.adapter_id,event.session_id||"unlinked",event.actor_id||"unknown",event.turn_id||`event:${event.event_id}`].join("|"); }
function sessionKey(event) { return [event.installation_id,event.adapter_id,event.session_id||`event:${event.event_id}`,event.actor_id||"unknown"].join("|"); }

export function deriveTables(events) {
  const turnMap=new Map(),sessionMap=new Map(),toolMap=new Map();
  for (const event of events) {
    const sk=sessionKey(event),session=sessionMap.get(sk)||{schema_version:"jar.telemetry.derived.session.v1",session_key:sk,session_id:event.session_id,actor_id:event.actor_id,adapter_id:event.adapter_id,source_event_ids:[],first_observed_at:event.observed_at_utc,last_observed_at:event.observed_at_utc,turn_keys:new Set(),finished:false};
    session.source_event_ids.push(event.event_id);session.first_observed_at=session.first_observed_at<event.observed_at_utc?session.first_observed_at:event.observed_at_utc;session.last_observed_at=session.last_observed_at>event.observed_at_utc?session.last_observed_at:event.observed_at_utc;if(event.event_name==="session.observed"&&event.payload?.phase==="end")session.finished=true;sessionMap.set(sk,session);
    if (event.turn_id || event.event_name==="routing.observed" || event.event_name.startsWith("tool.")) {
      const tk=turnKey(event),turn=turnMap.get(tk)||{schema_version:"jar.telemetry.derived.turn.v1",turn_key:tk,turn_id:event.turn_id,session_key:sk,route_id:event.route_id,source_event_ids:[],routing_event_id:null,tool_invocation_keys:new Set(),finished:false,correlation_status:event.correlation_status};
      turn.source_event_ids.push(event.event_id);if(event.event_name==="routing.observed")turn.routing_event_id=event.event_id;if(event.event_name.startsWith("tool."))turn.tool_invocation_keys.add(toolKey(event));if(event.event_name==="hook.finished"&&["Stop","SessionEnd"].includes(event.payload?.hook_kind))turn.finished=true;session.turn_keys.add(tk);turnMap.set(tk,turn);
    }
    if (event.event_name.startsWith("tool.")) {
      const key=toolKey(event),tool=toolMap.get(key)||{schema_version:"jar.telemetry.derived.tool.v1",tool_invocation_key:key,tool_invocation_id:event.tool_invocation_id,turn_key:turnKey(event),source_event_ids:[],tool_name:event.payload?.tool_name||null,started:false,finished:false,blocked:false,failed:false,unfinished:false};
      tool.source_event_ids.push(event.event_id);if(event.event_name==="tool.started")tool.started=true;if(event.event_name==="tool.finished")tool.finished=true;tool.blocked ||= event.payload?.blocked===true;tool.failed ||= event.payload?.failed===true;tool.unfinished=tool.started&&!tool.finished;toolMap.set(key,tool);
    }
  }
  const normalize=item=>Object.fromEntries(Object.entries(item).map(([key,value])=>[key,value instanceof Set?[...value].sort():value]));
  return {turns:[...turnMap.values()].map(normalize).sort((a,b)=>a.turn_key.localeCompare(b.turn_key)),sessions:[...sessionMap.values()].map(normalize).sort((a,b)=>a.session_key.localeCompare(b.session_key)),tools:[...toolMap.values()].map(normalize).sort((a,b)=>a.tool_invocation_key.localeCompare(b.tool_invocation_key))};
}

function usageMetrics(events) {
  const rows=events.filter(x=>x.event_name==="usage.observed"),seen=new Set(),totals={main:{input_total:0,input_cached:0,input_uncached:0,output_total:0,reasoning_output:0},jev:{input_total:0,input_cached:0,input_uncached:0,output_total:0,reasoning_output:0}};let covered=0;
  for (const event of rows) {
    const p=event.payload||{},key=p.native_request_key||p.native_counter_key||event.event_id;if(seen.has(key))continue;seen.add(key);
    if(p.completeness!=="complete"||p.counter_kind!=="delta")continue;covered++;const bucket=p.provider==="typesafe"||p.provider==="jev"?totals.jev:totals.main;
    for(const field of Object.keys(bucket))if(Number.isFinite(p[field]))bucket[field]+=p[field];
  }
  return {observations:rows.length,covered,deduplicated:rows.length-seen.size,totals};
}

export function summarizeEvents(events,{timeZone="Europe/Madrid",asOf=new Date().toISOString(),windowStart=null,windowEnd=null}={}) {
  const filtered=events.filter(event=>(!windowStart||event.observed_at_utc>=windowStart)&&(!windowEnd||event.observed_at_utc<windowEnd)),tables=deriveTables(filtered),overheads=filtered.filter(x=>x.event_name==="hook.finished").map(x=>x.payload?.telemetry_overhead_ms).filter(Number.isFinite),routing=filtered.filter(x=>x.event_name==="routing.observed").map(x=>x.payload?.duration_ms).filter(Number.isFinite),usage=usageMetrics(filtered);
  const delivery=filtered.filter(x=>x.event_name==="routing.observed").reduce((a,x)=>{const p=x.payload||{};a.selected+=p.selected_count||0;a.materialized+=p.materialized_count||0;a.full+=p.full_count||0;a.partial+=p.partial_count||0;a.absent+=p.absent_count||0;return a},{selected:0,materialized:0,full:0,partial:0,absent:0});
  const days=[...new Set(filtered.map(x=>dayOf(x,timeZone)))].sort(),repositories=[...new Set(filtered.map(x=>x.repository_id).filter(Boolean))].sort(),epochs=[...new Set(filtered.map(x=>`${x.runtime_id||"unknown"}|${x.config_hash}`))].sort();
  return {schema_version:"jar.telemetry.metrics.v1",metric_definition_version:METRIC_DEFINITION_VERSION,as_of:asOf,time_zone:timeZone,window:{start:windowStart,end:windowEnd},input:{event_count:filtered.length,input_hash:sha256(filtered.map(x=>x.event_id).sort())},data_health:{observed_days:days,session_count:tables.sessions.length,turn_count:tables.turns.length,finished_turn_count:tables.turns.filter(x=>x.finished).length,partial_turn_count:tables.turns.filter(x=>!x.finished).length,correlated_count:filtered.filter(x=>x.correlation_status==="exact").length,partial_correlation_count:filtered.filter(x=>x.correlation_status==="partial").length,unlinked_count:filtered.filter(x=>x.correlation_status==="unlinked").length,duplicate_count:0,drop_count:filtered.filter(x=>x.event_name==="telemetry.health").reduce((n,x)=>n+(x.payload?.known_loss_count||0),0),truncation_count:filtered.filter(x=>x.truncation?.observation_truncated).length,native_usage_coverage:usage.observations?usage.covered/usage.observations:0,unsupported_integrations:[...new Set(filtered.filter(x=>x.coverage?.supported===false).map(x=>x.adapter_id))].sort()},usage_mix:{repository_count:repositories.length,repositories,session_count:tables.sessions.length,turn_count:tables.turns.length,epochs},jar_health:{hook_count:filtered.filter(x=>x.event_name==="hook.finished").length,hook_error_count:filtered.filter(x=>x.event_name==="hook.finished"&&x.payload?.outcome==="error").length,telemetry_overhead_p50_ms:percentile(overheads,.5),telemetry_overhead_p95_ms:percentile(overheads,.95),routing_p50_ms:percentile(routing,.5),routing_p95_ms:percentile(routing,.95)},evidence_delivery:delivery,downstream_behavior:{unique_tool_count:tables.tools.length,finished_tool_count:tables.tools.filter(x=>x.finished).length,blocked_tool_count:tables.tools.filter(x=>x.blocked).length,failed_tool_count:tables.tools.filter(x=>x.failed).length,unfinished_tool_count:tables.tools.filter(x=>x.unfinished).length,interpretation:"Observed correlations/proxies; not semantic relevance labels."},resource_usage:usage,research_inputs:["Use representative and anomalous episodes for a later controlled review.","Do not infer JAR impact without a compatible control condition or scoped human labels."]};
}

export function dailyGroups(events,timeZone) { const groups=new Map();for(const event of events){const day=dayOf(event,timeZone);if(!groups.has(day))groups.set(day,[]);groups.get(day).push(event)}return groups; }

export function selectReviewQueue(events,metrics) {
  const turns=deriveTables(events).turns,representative=[...turns].sort((a,b)=>sha256(a.turn_key).localeCompare(sha256(b.turn_key))).slice(0,10).map((turn,index)=>({schema_version:"jar.telemetry.review.v1",kind:"representative",selection_reason:"deterministic_hash_sample",selection_rank:index+1,inclusion_method:"lowest_sha256_turn_key",turn_id:turn.turn_id,event_ids:turn.source_event_ids,private_bookmark_available:true}));
  const anomalies=events.filter(x=>x.severity==="error"||x.payload?.failed||x.payload?.freshness==="failed"||x.truncation?.observation_truncated).sort((a,b)=>a.event_id.localeCompare(b.event_id)).slice(0,10).map(event=>({schema_version:"jar.telemetry.review.v1",kind:"anomaly",selection_reason:event.payload?.code||event.payload?.reason||"error_or_truncation",event_ids:[event.event_id],turn_id:event.turn_id,private_bookmark_available:true}));
  return [...representative,...anomalies];
}

export function markdownReport(metrics,{title="JAR telemetry report"}={}) {
  const h=metrics.data_health,m=metrics.usage_mix,j=metrics.jar_health,d=metrics.evidence_delivery,b=metrics.downstream_behavior,u=metrics.resource_usage;
  return `# ${title}\n\nAs of: ${metrics.as_of}\n\nMetric definition: ${metrics.metric_definition_version}\n\n## 1. Data health\n\n- Events: ${metrics.input.event_count}; sessions: ${h.session_count}; turns: ${h.turn_count}; finished: ${h.finished_turn_count}; partial: ${h.partial_turn_count}.\n- Correlation: exact ${h.correlated_count}, partial ${h.partial_correlation_count}, unlinked ${h.unlinked_count}.\n- Native usage coverage: ${(h.native_usage_coverage*100).toFixed(1)}%; duplicates: ${h.duplicate_count}; known drops: ${h.drop_count}; truncations: ${h.truncation_count}.\n\n## 2. Actual usage mix\n\n- Repositories: ${m.repository_count}; runtime/config epochs: ${m.epochs.length}.\n- No undocumented task categories are inferred.\n\n## 3. JAR health and cost\n\n- Hooks: ${j.hook_count}; errors: ${j.hook_error_count}.\n- Telemetry overhead p50/p95: ${j.telemetry_overhead_p50_ms??"unavailable"}/${j.telemetry_overhead_p95_ms??"unavailable"} ms.\n- Routing p50/p95: ${j.routing_p50_ms??"unavailable"}/${j.routing_p95_ms??"unavailable"} ms.\n\n## 4. Evidence delivery\n\n- Selected: ${d.selected}; materialized: ${d.materialized}; full: ${d.full}; partial: ${d.partial}; absent: ${d.absent}.\n- Inclusion confirms JAR output only unless host exposure is explicitly observed.\n\n## 5. Observed downstream behavior\n\n- Unique tools: ${b.unique_tool_count}; finished: ${b.finished_tool_count}; blocked: ${b.blocked_tool_count}; failed: ${b.failed_tool_count}; unfinished: ${b.unfinished_tool_count}.\n- ${b.interpretation}\n\n## 6. Resource usage\n\n- Main model: ${JSON.stringify(u.totals.main)}\n- JEV: ${JSON.stringify(u.totals.jev)}\n- Missing usage is not treated as zero and no monetary counterfactual is reported.\n\n## 7. Review queue\n\nGenerated deterministically in the adjacent review-queue JSONL file.\n\n## 8. Research inputs\n\n${metrics.research_inputs.map(x=>`- ${x}`).join("\n")}\n`;
}

export function jsonl(values) { return values.map(jsonLine).join("\n")+(values.length?"\n":""); }
