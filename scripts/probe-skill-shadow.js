import assert from "node:assert/strict";
import { runSkillShadow } from "../bin/skill-shadow.js";
import { JsonlTelemetryStore } from "../packages/telemetry/src/jsonl-store.js";

// One task, one tournament, one invocation per arm. No retry or quality tuning.
if (!process.env.TYPESAFE_API_KEY) {
  console.log(JSON.stringify({status:"pending",reason:"TYPESAFE_API_KEY unavailable; no calls made"}));
} else {
  const eccRoot=process.argv[2]??process.env.ECC_ROOT;
  const result=await runSkillShadow({eccRoot,taskText:"Fix a failing PostgreSQL migration and add regression tests."});
  const events=new JsonlTelemetryStore(result.trace_file).readAll();
  const run=events.find(e=>e.event_type==="skill_shadow_run"&&e.tournament_run_id===result.tournament_run_id);
  const arms=events.filter(e=>e.event_type==="skill_shadow_result"&&e.tournament_run_id===result.tournament_run_id);
  const ids=new Set(arms.map(a=>a.strategy_invocation_id));
  const calls=events.filter(e=>e.event_type==="decision_provider_result"&&ids.has(e.decision_context?.invocation_id));
  assert.equal(result.recording.status,"complete");assert.equal(arms.length,5);assert.equal(ids.size,5);
  assert.equal(run.runtime_visibility.state,"unknown");
  for(const arm of result.results){
    const owned=calls.filter(c=>c.decision_context.invocation_id===arm.invocation_id);
    assert.equal(owned.length,arm.jev_calls);
    assert.equal(arm.decision_calls.attempted,arm.decision_calls.settled);
    assert.ok(owned.every(c=>c.decision_context.caller===arm.strategy_id&&c.decision_context.operation&&c.decision_context.call_id));
    const saved=arms.find(a=>a.strategy_invocation_id===arm.invocation_id);
    assert.equal(saved.decision.outcome,arm.outcome);
    assert.equal(saved.decision.noSkill,arm.outcome==="no_skill");
  }
  assert.notEqual(result.results.find(a=>a.strategy_id==="skill/ecc-hermes-v1").reason,"policy_exhausted");
  const knownUsage=key=>calls.reduce((sum,c)=>sum+(c[key]??0),0);
  console.log(JSON.stringify({...result,correlation_verified:true,total_usage:{known_input_tokens:knownUsage("input_tokens"),known_output_tokens:knownUsage("output_tokens"),calls_with_unknown_usage:calls.filter(c=>c.input_tokens===null||c.output_tokens===null).length}},null,2));
  if(result.results.some(a=>a.outcome==="error"))process.exitCode=2;
}
