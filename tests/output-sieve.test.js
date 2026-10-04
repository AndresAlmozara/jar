import test from "node:test";
import assert from "node:assert/strict";
import { freshOutput, JevSieveOutputStrategy, MemoryOutputArchive } from "../packages/output-filtering/src/index.js";

const task = {id:"task", text:"Assess readiness"};
const build = (text = "progress: 10/100\n".repeat(1000), source = {}) => freshOutput({toolInvocationId:"tool", capabilityId:"worker",
  taskId:task.id, sessionId:"session", source:{outputClass:"progress", sensitive:false, ...source}, parts:[{channel:"events", contentType:"text", text}]});
const answer = p => ({primitive:"noul", probability_true:p, probability_false:1-p});
function setup(options = {}) {
  const calls = [], archive = new MemoryOutputArchive();
  const strategy = new JevSieveOutputStrategy({archive, decisionEngine:{noul:async input => {calls.push(input);return answer(.01)}}, ...options});
  return {calls, archive, strategy};
}

test("sieve bounded candidates retain hard keeps and unjudged tail with exact recovery", async () => {
  const {strategy, calls, archive} = setup(), observation = build();
  const result = await strategy.propose({observation, task, invocationId:"known"});
  assert.equal(result.proposal.outcome, "reduced"); assert.equal(result.decision.status, "would_apply");
  assert.equal(calls.length, 6); assert.equal(result.decisionCalls.attempted, 6);
  assert.equal(result.decisionCalls.settled, 6); assert.equal(result.decisionCalls.failed, 0);
  assert.ok(result.hardKeepIds.every(id => result.proposal.retainedSegmentIds.includes(id)));
  const judged = new Set(calls.map(c => c.state.segment.id));
  assert.ok(result.segments.filter(s => !judged.has(s.id)).every(s => result.proposal.retainedSegmentIds.includes(s.id)));
  assert.deepEqual(archive.recover(result.proposal.recoveryRef), observation);
  assert.ok(calls.every(c => c.state.segment.text.length <= 1500));
  assert.ok(calls.every(c => c.decisionContext.invocation_id === "known" && c.decisionContext.session_id === "session"
    && c.decisionContext.component === "output_filtering" && c.decisionContext.operation_id === c.state.segment.id));
  assert.equal(new Set(calls.map(c => c.decisionContext.call_id)).size, 6);
});

test("threshold boundary and uncertainty keep all content", async () => {
  for (const p of [.1, .5, 1]) {
    const {strategy} = setup({decisionEngine:{noul:async () => answer(p)}}), observation = build();
    const result = await strategy.propose({observation, task});
    assert.deepEqual(result.decision.parts, observation.parts); assert.equal(result.proposal.outcome, "passthrough");
  }
});

test("provider failure after an earlier DROP returns the entire original and settles calls", async () => {
  let calls = 0;
  const {strategy} = setup({decisionEngine:{noul:async () => {if (++calls === 2) throw Error("synthetic provider failure");return answer(0)}}});
  const observation = build(), result = await strategy.propose({observation, task});
  assert.equal(result.proposal.reason, "provider_failure"); assert.deepEqual(result.decision.parts, observation.parts);
  assert.deepEqual(result.decisionCalls, {attempted:2, settled:2, failed:1});
});

test("malformed probabilities, primitive and candidate identity never authorize deletion", async () => {
  for (const invalid of [null, {}, {...answer(.1), primitive:"score"}, answer(NaN), answer(-.1), answer(1.1),
    {primitive:"noul", probability_true:0}, {...answer(0), probability_false:.3}, {...answer(0), segment_id:"wrong"}]) {
    const {strategy} = setup({decisionEngine:{noul:async () => invalid}}), observation = build();
    const result = await strategy.propose({observation, task});
    assert.equal(result.proposal.reason, "invalid_semantic_decision"); assert.deepEqual(result.decision.parts, observation.parts);
  }
});

test("no key discovery, old context, task truncation or uncertain transmission", async () => {
  const {strategy, calls} = setup();
  for (const input of [{observation:build()}, {observation:build(), task:{id:task.id, text:"x".repeat(2001)}},
    {observation:build(undefined, {sensitive:undefined}), task}]) {
    // Omitted sensitive flag is valid metadata; undefined supplied explicitly
    // is normalized by the capture and not treated as a false declaration.
    const result = await strategy.propose(input);
    assert.equal(result.proposal.reason, "uncertain"); assert.deepEqual(result.decision.parts, input.observation.parts);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(strategy.propose({observation:build(), task:{...task, history:[]}}));
  await assert.rejects(strategy.propose({observation:build(), task, messages:[]}));
  await assert.rejects(strategy.propose({observation:build(), task:{...task, id:"different-task"}}));
});

test("no provider calls occur before successful exact recovery", async () => {
  const {strategy, calls} = setup({archive:{store:async observation => new MemoryOutputArchive().store(observation), recover:async () => {throw Error("missing")}}});
  const observation = build(), result = await strategy.propose({observation, task});
  assert.equal(calls.length, 0); assert.equal(result.proposal.reason, "archive_failure");
  assert.deepEqual(result.decision.parts, observation.parts);
});

test("oversized segments and lexical task overlap stay unjudged", async () => {
  const {strategy, calls} = setup();
  const observation = build("header\n" + "x".repeat(4000) + "\n" + "readiness evidence\n".repeat(300) + "tail\n");
  const result = await strategy.propose({observation, task});
  assert.equal(calls.length, 0); assert.deepEqual(result.decision.parts, observation.parts);
});

test("diagnostic hard keep wins and remaining channel/order text is exact", async () => {
  const {strategy, calls} = setup();
  const observation = build("progress: 10/100\n".repeat(250) + "WARNING: important needle\n" + "progress: 10/100\n".repeat(500));
  const result = await strategy.propose({observation, task});
  assert.ok(result.decision.parts[0].text.includes("WARNING: important needle"));
  assert.ok(calls.every(c => !c.state.segment.text.includes("WARNING")));
  const expected = result.segments.filter(s => result.proposal.retainedSegmentIds.includes(s.id)).map(s => observation.parts[s.partIndex].text.slice(s.start, s.end)).join("");
  assert.equal(result.decision.parts[0].text, expected);
});

test("candidate and call caps are exposed without tuning defaults", async () => {
  const {strategy, calls} = setup({semanticLimits:{maxCalls:2, maxCandidates:3}});
  const result = await strategy.propose({observation:build(), task});
  assert.equal(calls.length, 2); assert.equal(result.proposal.configuration.maxCalls, 2);
  assert.equal(result.proposal.configuration.dropBelow, .1);
  assert.throws(() => setup({semanticLimits:{dropBelow:.5}}));
});
