import test from "node:test";
import assert from "node:assert/strict";
import { freshOutput, assertFreshOutput, currentOutputTask, outputInvocation, filterProposal,
  validateFilterProposal, segmentOutput, validateSegments, reconstructOutput, outputRecoveryRef,
  OutputSafetyGate, outputTelemetry, lineCount } from "../packages/output-filtering/src/index.js";

const capture = (parts = [{channel:"result", contentType:"text", text:"first\r\nsecond\nlast"}], extra = {}) => freshOutput({
  toolInvocationId:"tool-1", capabilityId:"generic-capability", taskId:"task-1", sessionId:"session-1", parts, ...extra,
});
function setup(observation = capture()) {
  const segments = segmentOutput(observation, {maxChars:1});
  const invocation = outputInvocation("output/test-v1", observation, "invocation-1");
  const make = changes => filterProposal({observation, invocation, retainedSegmentIds:segments.map(s => s.id), ...changes});
  return {observation, segments, make, proposal:make({}), archive:{recover:async () => observation}};
}
const gate = new OutputSafetyGate();
const reduction = setup => setup.make({outcome:"reduced", method:"deterministic", reason:"reduced",
  retainedSegmentIds:[setup.segments[0].id, setup.segments.at(-1).id], recoveryRef:outputRecoveryRef(setup.observation)});

test("fresh identity is stable and binds text, channels, source, invocation and sequence", () => {
  const a = capture(); assert.equal(a.id, capture().id); assert.equal(a.contentHash, capture().contentHash);
  for (const extra of [{sequence:1}, {toolInvocationId:"tool-2"}, {source:{failed:true}}, {parts:[{channel:"different", contentType:"text", text:"first\r\nsecond\nlast"}]}]) {
    assert.notEqual(a.id, capture(undefined, extra).id);
  }
  assert.equal(a.chars, 18); assert.equal(a.lines, 3); assert.ok(Object.isFrozen(a.parts[0]));
  assert.throws(() => assertFreshOutput({...a, chars:0}));
});

test("ordered repeated channels, whitespace, Unicode and empty text reconstruct exactly", () => {
  const observation = capture([
    {channel:"events", contentType:"text", text:"  α😀\r\n\n"},
    {channel:"diagnostics", contentType:"text", text:""},
    {channel:"events", contentType:"text", text:"tail\rno newline  "},
  ]);
  const segments = segmentOutput(observation, {maxChars:2});
  assert.deepEqual(segments, segmentOutput(observation, {maxChars:2}));
  assert.deepEqual(reconstructOutput(observation, segments, segments.map(s => s.id)), observation.parts);
  assert.equal(segments[0].start, 0); assert.equal(segments[0].end, 7);
  assert.equal(segments[2].partIndex, 1); assert.equal(segments[2].start, segments[2].end);
  assert.equal(lineCount(""), 0); assert.equal(lineCount("\n"), 1); assert.equal(lineCount("a\rb\r\n"), 2);
});

test("segmentation never returns a partial prefix or splits long lines", () => {
  const observation = capture([{channel:"result", contentType:"text", text:"x".repeat(2000)}]);
  assert.equal(segmentOutput(observation, {maxChars:10})[0].end, 2000);
  assert.throws(() => segmentOutput(capture(), {maxChars:1, maxSegments:2}), RangeError);
  assert.throws(() => segmentOutput(capture(), {maxChars:0}));
});

test("non-text stays opaque and passes through without serializing payload", async () => {
  for (const contentType of ["binary", "image", "audio", "opaque"]) {
    const opaque = {toJSON(){throw new Error("Must not serialize")}};
    const s = setup(capture([{channel:"asset", contentType, opaque}]));
    s.proposal = s.make({outcome:"unsupported", reason:"unsupported_content"});
    const decision = await gate.evaluate(s);
    assert.equal(decision.status, "would_fall_open"); assert.equal(decision.parts[0].opaque, opaque);
    assert.equal(s.observation.chars, null); assert.equal(s.observation.contentHash, null);
    assert.throws(() => outputRecoveryRef(s.observation));
    assert.doesNotThrow(() => JSON.stringify(outputTelemetry({...s, decision})));
  }
});

test("history and malformed fresh contracts are rejected without coercion", () => {
  assert.throws(() => capture(undefined, {history:[]}));
  assert.throws(() => currentOutputTask({id:"t", text:"now", recentContext:["old"]}));
  assert.throws(() => currentOutputTask({id:"t", text:"now", messages:[]}));
  assert.deepEqual(currentOutputTask({id:"t", text:"now"}), {id:"t", text:"now"});
  assert.throws(() => capture([{channel:"x", contentType:"text", text:Buffer.from("x")} ]));
  assert.throws(() => capture([{channel:"x", contentType:"image", text:"pretend text"}]));
});

test("proposal identity stable per invocation; independent invocations distinct", () => {
  const s = setup(); assert.equal(s.proposal.id, s.make({}).id);
  const other = filterProposal({observation:s.observation, invocation:outputInvocation("output/test-v1", s.observation)});
  assert.notEqual(s.proposal.id, other.id);
  assert.throws(() => validateFilterProposal({...s.proposal, outcome:"reduced"}, s.observation));
  assert.throws(() => s.make({outcome:"reduced", method:"none"}));
  assert.throws(() => s.make({reason:"raw secret exception"}));
  assert.throws(() => s.make({configuration:{prompt:"secret"}}));
  assert.throws(() => s.make({outcome:"error", reason:"reduced"}));
});

test("control gate is shadow-only and preserves original parts", async () => {
  const s = setup(), decision = await gate.evaluate(s);
  assert.equal(decision.status, "would_apply"); assert.equal(decision.effect, false); assert.equal(decision.shadow, true);
  assert.deepEqual(decision.parts, s.observation.parts); assert.equal(decision.recoveryAvailable, false);
});

test("all failure proposals fall open to original", async () => {
  for (const reason of ["filter_failure", "provider_failure", "archive_failure", "invalid_semantic_decision", "uncertain"]) {
    const s = setup(); s.proposal = s.make({outcome:"error", reason, retainedSegmentIds:[]});
    const decision = await gate.evaluate(s);
    assert.equal(decision.status, "would_fall_open"); assert.deepEqual(decision.parts, s.observation.parts);
  }
});

test("invalid proposal, observation and unknown segment safely preserve input", async () => {
  const s = setup();
  for (const proposal of [null, {...s.proposal, observationId:"wrong"}, s.make({retainedSegmentIds:["unknown"]})]) {
    const decision = await gate.evaluate({...s, proposal});
    assert.equal(decision.status, "would_reject"); assert.deepEqual(decision.parts, s.observation.parts);
  }
  const decision = await gate.evaluate({...s, observation:{...s.observation, id:"bad"}});
  assert.equal(decision.status, "would_fall_open"); assert.deepEqual(decision.parts, s.observation.parts);
});

test("exact recovery is verified before approving a reduction", async () => {
  const s = setup(); s.proposal = reduction(s);
  const decision = await gate.evaluate(s);
  assert.equal(decision.status, "would_apply"); assert.equal(decision.recoveryAvailable, true);
  assert.equal(decision.parts[0].text, "first\r\nlast");
  for (const archive of [null, {recover:async () => {throw Error("secret failure")}}, {recover:async () => capture(undefined, {toolInvocationId:"other"})}, {recover:async () => ({...s.observation, parts:[]})}]) {
    const failed = await gate.evaluate({...s, archive});
    assert.equal(failed.status, "would_fall_open"); assert.deepEqual(failed.parts, s.observation.parts);
  }
  assert.equal((await gate.evaluate({...s, proposal:s.make({outcome:"reduced", method:"semantic", reason:"reduced", retainedSegmentIds:[s.segments[0].id]})})).reason, "recovery_unavailable");
});

test("caller hard keeps cannot be overruled by semantic proposals", async () => {
  const s = setup(); s.proposal = reduction(s);
  const decision = await gate.evaluate({...s, hardKeepIds:[s.segments[1].id]});
  assert.equal(decision.reason, "hard_keep_violation"); assert.deepEqual(decision.parts, s.observation.parts);
  assert.equal((await gate.evaluate({...s, hardKeepIds:["unknown"]})).reason, "invalid_segment_identity");
});

test("structural holes, order changes and range tampering fail safely", async () => {
  const s = setup(); s.proposal = reduction(s);
  for (const segments of [s.segments.slice(1), [...s.segments].reverse(), s.segments.map((seg, i) => i ? seg : {...seg, end:1}), [...s.segments, s.segments[0]]]) {
    assert.throws(() => validateSegments(s.observation, segments));
    const decision = await gate.evaluate({...s, segments});
    assert.equal(decision.status, "would_reject"); assert.deepEqual(decision.parts, s.observation.parts);
  }
});

test("unsafe metadata blocks reduction independently of strategy", async () => {
  for (const source of [{failed:true}, {sensitive:true}, {truncated:true}, {completeRequested:true}, {recoveryRead:true}, {outputClass:"structured"}]) {
    const s = setup(capture(undefined, {source})); s.proposal = reduction(s);
    assert.equal((await gate.evaluate(s)).reason, "unsafe_reduction");
  }
});

test("empty output stays intact and total deletion is rejected", async () => {
  const empty = setup(capture([{channel:"result", contentType:"text", text:""}]));
  assert.deepEqual((await gate.evaluate(empty)).parts, empty.observation.parts);
  const s = setup(); s.proposal = s.make({outcome:"reduced", method:"deterministic", reason:"reduced", retainedSegmentIds:[]});
  assert.equal((await gate.evaluate(s)).reason, "invalid_reduction");
});

test("telemetry preserves joins but excludes raw output and source metadata", async () => {
  const s = setup(capture([{channel:"SECRET_CHANNEL", contentType:"text", text:"SECRET_OUTPUT\nkeep\nend"}], {source:{sourceId:"SECRET_SOURCE"}}));
  s.proposal = reduction(s); const decision = await gate.evaluate(s);
  const event = outputTelemetry({...s, decision});
  assert.equal(event.invocation_id, "invocation-1"); assert.equal(event.tool_invocation_id, "tool-1");
  assert.equal(event.observation_id, s.observation.id); assert.equal(event.session_id, "session-1");
  assert.equal(event.removed_chars, 5); assert.equal(event.removed_lines, 1);
  assert.ok(!JSON.stringify(event).includes("SECRET"));
  for (const key of ["raw", "model", "usage", "probabilities", "parts", "source", "text"]) assert.ok(!(key in event));
});

test("archive await cannot race caller mutation of a valid observation", async () => {
  const s = setup(); const mutable = structuredClone(s.observation);
  const proposal = reduction(s);
  const decision = await gate.evaluate({...s, observation:mutable, proposal, archive:{recover:async () => {
    mutable.parts[0].text = "corrupted after validation"; return s.observation;
  }}});
  assert.equal(decision.status, "would_apply"); assert.equal(decision.parts[0].text, "first\r\nlast");
});
