import test from "node:test";
import assert from "node:assert/strict";
import { capabilityDescriptor, capabilityInventory, exposureInput, capabilityInvocation, exposureProposal,
  AllVisibleCapabilityStrategy, DeterministicCapabilityStrategy, JevSelectiveCapabilityStrategy,
  CapabilityPolicyGate, CAPABILITY_LIMITS, capabilityTelemetry } from "../packages/capability-exposure/src/index.js";
import { JevDecisionEngine } from "../packages/decision-providers/jev/src/jev-decision-engine.js";

const cap = (name, extra = {}) => capabilityDescriptor({kind:"tool", name, description:name,
  source:{namespace:"test", nativeId:name}, risk:"low", schemaChars:100, ...extra});
const entry = (c, facts = {}) => ({capability:c, available:true, supported:true, enabled:true, permission:"allowed", ...facts});
function input(entries, changes = {}) {
  return exposureInput({task:{id:"task-test", text:"investigate bug regression"},
    inventory:capabilityInventory({runtime:{id:"host", family:"neutral"}, source:"fixture", state:entries === null ? "unknown" : "known", entries}), ...changes});
}
const noul = p => ({primitive:"noul", probability_true:p, probability_false:1-p});
const semantic = engine => new JevSelectiveCapabilityStrategy({decisionEngine:engine ?? {noul:async () => noul(.01)}});
const gate = (i, r) => new CapabilityPolicyGate().evaluate({input:i, proposal:r.proposal});

test("all-visible includes every eligible ID and independently rejects every hard fact", async () => {
  const good = cap("good"), excluded = cap("excluded");
  const i = input([entry(good), entry(excluded), entry(cap("unavailable"), {available:false}),
    entry(cap("unsupported"), {supported:false}), entry(cap("disabled"), {enabled:false}),
    entry(cap("denied"), {permission:"denied"}), entry(cap("risk", {risk:"critical"})),
    entry(cap("skill", {kind:"skill"})), entry(cap("agent", {kind:"agent"})), entry(cap("workflow", {kind:"workflow"}))],
  {constraints:{excludeIds:[excluded.id]}});
  const r = await new AllVisibleCapabilityStrategy().propose(i), effective = gate(i, r);
  assert.deepEqual(r.proposal.proposedIds, [good.id]); assert.deepEqual(effective.effectiveIds, [good.id]);
  assert.equal(r.decisionCalls.attempted, 0); assert.equal(effective.rejections.length, 9);
});

test("deterministic results are stable and weak or partial evidence keeps visible", async () => {
  const entries = [entry(cap("investigate bug")), entry(cap("unrelated search"))];
  const s = new DeterministicCapabilityStrategy();
  const a = await s.propose({...input(entries), invocationId:"fixed"});
  const b = await s.propose({...input([...entries].reverse()), invocationId:"fixed"});
  assert.deepEqual(a, b); assert.equal(a.proposal.proposedIds.length, 2); assert.equal(a.decisionCalls.attempted, 0);
  assert.equal(a.proposal.configuration.strongEvidence, false);
});

test("deterministic strong lexical coverage can withhold zero-overlap capabilities", async () => {
  const relevant = cap("investigate bug regression"), other = cap("weather lookup");
  const i = input([entry(relevant), entry(other)]), r = await new DeterministicCapabilityStrategy().propose(i);
  assert.deepEqual(r.proposal.proposedIds, [relevant.id]); assert.equal(r.proposal.configuration.strongEvidence, true);
});

test("JEV candidate judgments are bounded, eligible only, and keep all unjudged IDs", async () => {
  const requests = [], entries = Array.from({length:12}, (_, n) => entry(cap(`operation ${n}`)));
  const unavailable = cap("investigate bug regression"); entries.push(entry(unavailable, {available:false}));
  const i = input(entries), r = await semantic({noul:async request => {requests.push(request); return noul(.01)}}).propose(i);
  assert.equal(requests.length, CAPABILITY_LIMITS.maxCalls); assert.equal(r.proposal.proposedIds.length, 6);
  assert.ok(requests.every(x => x.state.capability.id !== unavailable.id));
  assert.deepEqual(r.decisionCalls, {attempted:6, settled:6, failed:0});
  assert.equal(new Set(r.semanticRefs.map(r => r.call_id)).size, 6);
  assert.ok(r.proposal.eligibleIds.filter(id => !r.proposal.semanticCandidateIds.includes(id)).every(id => r.proposal.proposedIds.includes(id)));
});

test("explicit include overrides negative semantics, exclusion defeats inclusion", async () => {
  const required = cap("required"), forbidden = cap("forbidden");
  const i = input([entry(required), entry(forbidden)], {constraints:{includeIds:[required.id, forbidden.id], excludeIds:[forbidden.id]}});
  const r = await semantic().propose(i), e = gate(i, r);
  assert.deepEqual(r.proposal.semanticSelectedIds, []); assert.deepEqual(r.proposal.proposedIds, []);
  assert.deepEqual(e.effectiveIds, [required.id]); assert.deepEqual(e.overrides, [{id:required.id, reason:"explicit_include"}]);
  assert.deepEqual(e.unresolvedRequiredIds, [forbidden.id]); assert.deepEqual(e.eligibility.conflicts, [forbidden.id]);
});

test("independent gate rejects semantically selected permission/risk/unavailable IDs", () => {
  const a = cap("denied"), b = cap("risk", {risk:"high"}), c = cap("absent");
  const i = input([entry(a, {permission:"denied"}), entry(b), entry(c, {available:false})]);
  const ids = [a.id, b.id, c.id];
  const proposal = exposureProposal({input:i, invocation:capabilityInvocation("capability/jev-selective-v1"),
    eligibleIds:ids, semanticCandidateIds:ids, semanticSelectedIds:ids, proposedIds:ids});
  const e = new CapabilityPolicyGate().evaluate({input:i, proposal});
  assert.deepEqual(e.semanticSelectedIds, ids.sort()); assert.deepEqual(e.effectiveIds, []);
  assert.deepEqual(e.rejections.flatMap(r => r.reasons).sort(), ["permission_denied", "risk_forbidden", "unavailable"]);
  assert.equal(e.schemaSizeProxy.before, 0); assert.equal(e.schemaSizeProxy.after, 0);
});

test("unknown permission and risk remain unresolved, not denied or allowed", async () => {
  const c = cap("uncertain", {risk:"unknown"}), i = input([entry(c, {permission:"unknown"})], {constraints:{includeIds:[c.id]}});
  const r = await semantic({noul:async () => assert.fail("must not call")}).propose(i), e = gate(i, r);
  assert.deepEqual(e.rejections[0].reasons, ["permission_unknown", "risk_unknown"]);
  assert.deepEqual(e.eligibility.unresolvedIds, [c.id]); assert.deepEqual(e.unresolvedRequiredIds, [c.id]);
});

test("known-empty and unknown are distinct in all strategies and gate", async () => {
  for (const s of [new AllVisibleCapabilityStrategy(), new DeterministicCapabilityStrategy(), semantic()]) {
    for (const entries of [[], null]) {
      const i = input(entries), r = await s.propose(i), e = gate(i, r);
      assert.equal(r.proposal.reason, entries === null ? "inventory_unknown" : "known_empty");
      assert.deepEqual(e.effectiveIds, entries); assert.equal(e.schemaSizeProxy.before, entries === null ? null : 0);
      assert.equal(e.actuallyExposed, false); assert.equal(r.decisionCalls.attempted, 0);
    }
  }
});

test("provider failure after a rejection restores all eligible capabilities", async () => {
  let calls = 0;
  const i = input([entry(cap("one")), entry(cap("two")), entry(cap("three"))]);
  const r = await semantic({noul:async () => {if (++calls === 2) throw new Error("timeout SECRET"); return noul(0)}}).propose(i);
  const e = gate(i, r);
  assert.equal(r.proposal.reason, "provider_failure"); assert.equal(e.effectiveIds.length, 3);
  assert.deepEqual(r.decisionCalls, {attempted:2, settled:2, failed:1});
  assert.deepEqual(e.fallback, {reason:"provider_failure", exposureCount:3});
  assert.ok(!JSON.stringify({r,e}).includes("SECRET"));
});

test("malformed probabilities and returned unknown/duplicate identities fail open", async () => {
  const i = input([entry(cap("one")), entry(cap("two"))]);
  for (const answer of [null, [], {}, noul(NaN), noul(2), {...noul(.2), probability_false:.2},
    {...noul(.2), choice:"unknown"}, {...noul(.2), selectedIds:["x", "x"]}, {...noul(.2), primitive:"choice"}]) {
    const r = await semantic({noul:async () => answer}).propose(i);
    assert.equal(r.proposal.reason, "invalid_semantic_decision"); assert.equal(gate(i, r).effectiveIds.length, 2);
    assert.equal(r.decisionCalls.attempted, 1);
  }
});

test("invalid proposal identity/content fails open through independently recomputed policy", async () => {
  const good = cap("good"), bad = cap("bad"), i = input([entry(good), entry(bad, {permission:"denied"})]);
  const r = await new AllVisibleCapabilityStrategy().propose(i);
  for (const proposal of [{...r.proposal, proposedIds:["unknown"]}, {...r.proposal, proposedIds:[good.id, good.id]},
    {...r.proposal, actuallyExposed:true}, {...r.proposal, taskId:"other"}]) {
    const e = new CapabilityPolicyGate().evaluate({input:i, proposal});
    assert.deepEqual(e.effectiveIds, [good.id]); assert.equal(e.reason, "proposal_validation_failure");
    assert.equal(e.semanticSelectedIds, null);
  }
});

test("uncertainty and threshold boundary keep visible; multi-selection is not Choice", async () => {
  const i = input([entry(cap("a")), entry(cap("b"))]);
  for (const p of [.15, .5, .99]) {
    const r = await semantic({noul:async () => noul(p)}).propose(i);
    assert.equal(r.proposal.semanticSelectedIds.length, 2); assert.equal(gate(i, r).effectiveIds.length, 2);
  }
});

test("input-size limits fail open without provider calls or truncated evidence", async () => {
  const i = input([entry(cap("huge", {description:"x".repeat(5000)}))]);
  const r = await semantic({noul:async () => assert.fail("oversized")}).propose(i);
  assert.equal(r.proposal.reason, "limits_exceeded"); assert.equal(r.decisionCalls.attempted, 0);
  assert.equal(gate(i, r).effectiveIds.length, 1);
});

test("schema proxies remain characters with null unknown cost and empty denominator", async () => {
  const i = input([entry(cap("one")), entry(cap("two"))]), r = await semantic().propose(i), e = gate(i, r);
  assert.deepEqual(e.schemaSizeProxy, {unit:"UTF-16 characters", before:200, after:0, reduction:200, reductionRatio:1});
  assert.equal(capabilityTelemetry(i, r.proposal).actually_exposed, false);
  const missing = input([entry(cap("unknown-cost", {schemaChars:null}))]);
  assert.equal(gate(missing, await new AllVisibleCapabilityStrategy().propose(missing)).schemaSizeProxy.reductionRatio, null);
  const empty = input([]); assert.equal(gate(empty, await semantic().propose(empty)).schemaSizeProxy.reductionRatio, null);
  const overflow = input([entry(cap("large-one", {schemaChars:Number.MAX_SAFE_INTEGER})), entry(cap("large-two"))]);
  assert.equal(gate(overflow, await new AllVisibleCapabilityStrategy().propose(overflow)).schemaSizeProxy.before, null);
});

test("generic engine telemetry joins task, inventory, invocation, stage and candidate call", async () => {
  const events = [], i = input([entry(cap("one"))]);
  const engine = new JevDecisionEngine({client:{model:"mock", systemOne:async () => ({model:"mock", answers:{decision:{type:"noul", noul:.7}}, usage:{input_tokens:5, output_tokens:1}})},
    onTelemetry:e => events.push(e)});
  const r = await semantic(engine).propose({...i, invocationId:"joined", sessionId:"session"});
  assert.equal(events.length, 1); const e = events[0], ref = r.semanticRefs[0];
  assert.equal(e.task_id, i.task.id); assert.equal(r.proposal.inventoryId, i.inventory.id);
  assert.equal(e.decision_context.invocation_id, r.proposal.invocation.invocation_id);
  assert.equal(e.decision_context.operation, "capability_relevance"); assert.equal(e.decision_context.operation_id, ref.candidate_id);
  assert.equal(e.decision_context.call_id, ref.call_id); assert.equal(e.request_id, ref.request_id);
  assert.ok(!("usage" in r)); assert.ok(!("raw" in r));
});

test("semantic state excludes authority facts and unrelated skill/history ownership", async () => {
  let request;
  const i = input([entry(cap("one"))], {task:{id:"t", text:"task", explicitSkills:["SECRET"], recentContext:["SECRET"]}});
  const r = await semantic({noul:async value => {request = value; return noul(.9)}}).propose(i);
  assert.deepEqual(Object.keys(request.state.capability).sort(), ["description", "id", "name", "tags"]);
  assert.ok(!JSON.stringify(request).includes("SECRET"));
  assert.equal(r.proposal.actuallyExposed, false); assert.equal(gate(i, r).application, "not_applied");
  assert.ok(!("nextTool" in r)); assert.ok(Object.isFrozen(r.proposal));
});
