import test from "node:test";
import assert from "node:assert/strict";
import { freshOutput, MemoryOutputArchive, PassthroughOutputStrategy, DeterministicOutputStrategy,
  OutputSafetyGate } from "../packages/output-filtering/src/index.js";

export const observation = (text, source = {outputClass:"progress"}, parts = null) => freshOutput({toolInvocationId:"tool", capabilityId:"test",
  parts:parts ?? [{channel:"result", contentType:"text", text}], source});
const progress = "progress: 10/100\n".repeat(1000);

test("archive exact round trips preserve all supported text and channels", () => {
  const archive = new MemoryOutputArchive();
  for (const text of ["", "\r\n\n\r", "  trailing  ", "😀 café 中文\r\nend", "x".repeat(5000)]) {
    const original = observation(text, {}, [{channel:"a", contentType:"text", text}, {channel:"b", contentType:"text", text:""}, {channel:"a", contentType:"text", text:"tail\n"}]);
    const ref = archive.store(original);
    assert.equal(ref, archive.store(original)); assert.deepEqual(archive.recover(ref), original);
    assert.notEqual(archive.recover(ref), original);
  }
});

test("archive capacity has no eviction and explicit release invalidates recovery", () => {
  const archive = new MemoryOutputArchive({maxEntries:1, maxChars:10});
  const ref = archive.store(observation("first"));
  assert.throws(() => archive.store(observation("next"))); assert.equal(archive.recover(ref).parts[0].text, "first");
  assert.equal(archive.release(ref), true); assert.throws(() => archive.recover(ref));
  assert.throws(() => archive.store(observation("x".repeat(11))));
  archive.store(observation("new")); archive.clear(); assert.equal(archive.size, 0);
});

test("archive detects corrupted and missing entries, not just reference existence", () => {
  const backing = new Map(), archive = new MemoryOutputArchive({backing});
  const ref = archive.store(observation("original")); backing.get(ref).parts[0].text = "corrupt";
  assert.throws(() => archive.recover(ref)); assert.throws(() => archive.store(observation("original")));
  assert.throws(() => archive.recover("absent"));
});

test("control arm is always exact and has zero semantic calls", async () => {
  for (const text of ["", "ok", progress, "Error: failure\n at foo\n", "a\r\nb\n"]) {
    const original = observation(text), result = await new PassthroughOutputStrategy().propose({observation:original});
    assert.deepEqual(result.decision.parts, original.parts); assert.equal(result.telemetry.reduction_ratio, 0);
    assert.deepEqual(result.decisionCalls, {attempted:0, settled:0, failed:0});
  }
});

test("deterministic progress reduction is reproducible, ordered and exactly recoverable", async () => {
  const archive = new MemoryOutputArchive(), strategy = new DeterministicOutputStrategy({archive});
  const original = observation(progress), first = await strategy.propose({observation:original, invocationId:"repeat"}), second = await strategy.propose({observation:original, invocationId:"repeat"});
  assert.equal(first.proposal.id, second.proposal.id); assert.equal(first.proposal.outcome, "reduced");
  assert.equal(first.decision.status, "would_apply"); assert.deepEqual(archive.recover(first.proposal.recoveryRef), original);
  assert.ok(first.telemetry.removed_chars > 0); assert.ok(first.telemetry.removed_lines > 0);
  assert.equal(first.telemetry.retained_chars + first.telemetry.removed_chars, original.chars);
  assert.ok(first.hardKeepIds.every(id => first.proposal.retainedSegmentIds.includes(id)));
});

test("clear fixture classes bypass conservatively, including mixed channels", async () => {
  const fixtures = [
    ["short success", "ok\n", {}], ["empty", "", {}], ["test failure", "FAIL test\n" + progress, {outputClass:"log", failed:true}],
    ["stack", "Error: boom\n at foo:12\n" + progress, {outputClass:"log"}],
    ["search", progress, {outputClass:"search"}], ["listing", progress, {outputClass:"listing"}],
    ["json", '{"items":[' + '"item",'.repeat(1000) + 'null]}', {outputClass:"log"}],
    ["reference", progress, {outputClass:"reference"}], ["truncated", progress, {outputClass:"progress", truncated:true}],
    ["sensitive", "api_key=synthetic-not-real\n" + progress, {outputClass:"log"}],
    ["unknown", progress, {}], ["unicode", "完成 😀\n", {}],
  ];
  const strategy = new DeterministicOutputStrategy({archive:new MemoryOutputArchive()});
  for (const [name, text, source] of fixtures) {
    const original = observation(text, source), result = await strategy.propose({observation:original});
    assert.deepEqual(result.decision.parts, original.parts, name); assert.equal(result.proposal.outcome, "passthrough", name);
  }
  const original = observation("", {outputClass:"progress"}, [{channel:"stdout", contentType:"text", text:progress}, {channel:"stderr", contentType:"text", text:"warning"}]);
  assert.deepEqual((await strategy.propose({observation:original})).decision.parts, original.parts);
});

test("arbitrary duplicates and warnings are not treated as removable progress", async () => {
  const strategy = new DeterministicOutputStrategy({archive:new MemoryOutputArchive()});
  for (const text of ["important evidence\n".repeat(1000), "warning: important\n".repeat(1000), "progress: 1/10 important detail\n".repeat(500)]) {
    const original = observation(text), result = await strategy.propose({observation:original});
    assert.deepEqual(result.decision.parts, original.parts); assert.equal(result.proposal.outcome, "passthrough");
  }
});

test("archive and filter failures keep original with distinct reasons", async () => {
  const original = observation(progress);
  for (const [options, reason] of [[{}, "recovery_unavailable"], [{archive:{store(){throw Error("secret")}}}, "archive_failure"],
    [{archive:{store:() => "invalid secret reference"}}, "archive_failure"],
    [{archive:new MemoryOutputArchive(), select(){throw Error("secret")}}, "filter_failure"],
    [{archive:new MemoryOutputArchive(), limits:{maxSegments:1}}, "segmentation_limit"]]) {
    const result = await new DeterministicOutputStrategy(options).propose({observation:original});
    assert.deepEqual(result.decision.parts, original.parts); assert.equal(result.proposal.reason, reason);
    assert.ok(!JSON.stringify(result.telemetry).includes("secret"));
  }
});

test("a removed archive or lying archive cannot authorize reduction", async () => {
  const archive = new MemoryOutputArchive(), original = observation(progress);
  const result = await new DeterministicOutputStrategy({archive}).propose({observation:original});
  archive.clear();
  const decision = await new OutputSafetyGate().evaluate({observation:original, ...result, archive});
  assert.equal(decision.status, "would_fall_open"); assert.deepEqual(decision.parts, original.parts);
  const liar = {store:obs => new MemoryOutputArchive().store(obs), recover:() => observation("wrong")};
  assert.equal((await new DeterministicOutputStrategy({archive:liar}).propose({observation:original})).decision.status, "would_fall_open");
});

test("strategy boundary refuses old conversation input", async () => {
  await assert.rejects(new DeterministicOutputStrategy().propose({observation:observation(progress), history:[]}));
  await assert.rejects(new PassthroughOutputStrategy().propose({observation:observation("ok"), task:{id:"t", text:"now", recentContext:[]}}));
});
