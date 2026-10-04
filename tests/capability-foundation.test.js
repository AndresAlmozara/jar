import test from "node:test";
import assert from "node:assert/strict";
import { capabilityDescriptor, capabilityInventory, exposureInput, exposureConstraints, exposurePolicy,
  capabilityEligibility, capabilityInvocation, exposureProposal, validateExposureProposal, capabilityTelemetry,
  schemaSizeProxy } from "../packages/capability-exposure/src/index.js";

const descriptor = (nativeId = "read", extra = {}) => capabilityDescriptor({kind:"tool", name:"Read file", description:"Read local files",
  source:{namespace:"fixture", nativeId}, risk:"low", schemaChars:100, ...extra});
const entry = (capability = descriptor(), facts = {}) => ({capability, available:true, supported:true, enabled:true, permission:"allowed", ...facts});
const inventory = (entries = [entry()], extra = {}) => capabilityInventory({runtime:{id:"runtime-one", family:"generic-host"}, source:"fixture-capture", state:"known", entries, ...extra});
const input = (changes = {}) => exposureInput({task:{id:"task", text:"Read a file"}, inventory:inventory(), ...changes});
function proposalFor(value) {
  const e = capabilityEligibility(value);
  return exposureProposal({input:value, invocation:capabilityInvocation("capability/test-v1", "invocation-one", "session-one"),
    eligibleIds:e.eligibleIds ?? [], proposedIds:e.eligibleIds ?? [], policyExcludedIds:e.exclusions.map(e => e.id),
    outcome:e.state === "unknown" ? "no_decision" : "selected", reason:e.state === "unknown" ? "inventory_unknown" : "all_eligible"});
}

test("stable namespaced identity is independent of display name and descriptor version", () => {
  const a = descriptor(), b = descriptor("read", {name:"Renamed", version:"v2", description:"Updated description"});
  assert.equal(a.id, b.id); assert.notEqual(a.id, descriptor("other").id);
  assert.notEqual(a.id, descriptor("read", {source:{namespace:"another-provider", nativeId:"read"}}).id);
  assert.notEqual(a.id, descriptor("read", {kind:"mcp_tool"}).id);
  assert.equal(a.source.nativeId, "read"); assert.ok(Object.isFrozen(a.source));
  assert.throws(() => descriptor("read", {id:"display-name"}));
});

test("snapshot identity is order-stable and binds runtime facts and descriptor revision", () => {
  const a = entry(), b = entry(descriptor("write"));
  assert.equal(inventory([a, b]).id, inventory([b, a]).id);
  assert.notEqual(inventory([a]).id, inventory([{...a, available:false}]).id);
  assert.notEqual(inventory([a]).id, inventory([entry(descriptor("read", {version:"v2"}))]).id);
  assert.deepEqual(capabilityInventory(inventory([a])), inventory([a]));
  assert.throws(() => inventory([a, a]));
  assert.throws(() => capabilityInventory({...inventory(), id:"wrong"}));
});

test("unknown inventory is not known-empty or a partial known set", () => {
  const unknown = inventory(null, {state:"unknown"}), empty = inventory([]);
  assert.notEqual(unknown.id, empty.id); assert.equal(unknown.entries, null); assert.deepEqual(empty.entries, []);
  assert.equal(capabilityEligibility(input({inventory:unknown})).eligibleIds, null);
  assert.deepEqual(capabilityEligibility(input({inventory:empty})).eligibleIds, []);
  assert.throws(() => inventory([], {state:"unknown"}));
  assert.equal(inventory([entry(descriptor("only-observed"))]).entries.length, 1);
});

test("explicit includes/excludes are independent immutable policy facts", () => {
  const id = descriptor().id, missing = descriptor("missing").id;
  const constraints = exposureConstraints({includeIds:[missing, id], excludeIds:[id]});
  const result = capabilityEligibility(input({constraints}));
  assert.deepEqual(result.eligibleIds, []); assert.deepEqual(result.conflicts, [id]);
  assert.deepEqual(result.unresolvedRequiredIds, [missing, id].sort());
  assert.ok(result.exclusions[0].reasons.includes("explicit_exclusion"));
  assert.throws(() => constraints.includeIds.push("new"));
  assert.throws(() => exposureConstraints({includeIds:[id, id]}));
});

test("malformed capabilities, schemas and executable handles are not admitted", () => {
  for (const changes of [{name:""}, {kind:"invalid kind"}, {risk:"safe-ish"}, {schemaChars:-1}, {schemaChars:"100"},
    {input_schema:{secret:"huge schema"}}, {execute:() => {}}, {source:{namespace:"x", nativeId:""}}]) assert.throws(() => descriptor("read", changes));
  assert.throws(() => inventory([entry(descriptor(), {available:"yes"})]));
  assert.throws(() => inventory([entry(descriptor(), {permission:"admin"})]));
});

test("eligibility deterministically excludes denied facts, unrelated scope and risk", () => {
  for (const [facts, expected] of [[{available:false}, "unavailable"], [{supported:false}, "runtime_unsupported"],
    [{enabled:false}, "disabled"], [{permission:"denied"}, "permission_denied"]]) {
    const result = capabilityEligibility(input({inventory:inventory([entry(descriptor(), facts)])}));
    assert.deepEqual(result.eligibleIds, []); assert.ok(result.exclusions[0].reasons.includes(expected));
  }
  for (const kind of ["skill", "agent", "workflow", "future_kind"]) {
    const result = capabilityEligibility(input({inventory:inventory([entry(descriptor("x", {kind}))])}));
    assert.ok(result.exclusions[0].reasons.includes("outside_tool_scope"));
  }
  const result = capabilityEligibility(input({inventory:inventory([entry(descriptor("dangerous", {risk:"critical"}))])}));
  assert.ok(result.exclusions[0].reasons.includes("risk_forbidden"));
});

test("missing facts default unknown, not available or low risk", () => {
  const cap = descriptor("read", {risk:undefined}); assert.equal(cap.risk, "unknown");
  const inv = inventory([{capability:cap}]);
  assert.equal(inv.entries[0].available, null); assert.equal(inv.entries[0].permission, "unknown");
  const result = capabilityEligibility(input({inventory:inv}));
  assert.deepEqual(result.unresolvedIds, [cap.id]);
  assert.ok(result.exclusions[0].reasons.includes("availability_unknown"));
  assert.ok(!result.exclusions[0].reasons.includes("unavailable"));
  assert.ok(result.exclusions[0].reasons.includes("risk_unknown"));
});

test("requirements and prompt permission never become implicit execution grants", () => {
  const cap = descriptor("read", {requirements:["local-workspace"], requiredPermissions:["files.read"]});
  const initial = input({inventory:inventory([entry(cap, {permission:"prompt"})])});
  assert.deepEqual(capabilityEligibility(initial).eligibleIds, []);
  const allowed = input({inventory:inventory([entry(cap, {permission:"prompt", requirementsSatisfied:true})]), policy:{allowPromptExposure:true}});
  assert.deepEqual(capabilityEligibility(allowed).eligibleIds, [cap.id]);
  assert.equal(proposalFor(allowed).actuallyExposed, false);
  assert.throws(() => exposurePolicy({grantPermissions:true}));
  assert.throws(() => exposurePolicy({allowedRiskLevels:["unknown"]}));
});

test("proposal binds snapshot/policy/task, retains no schemas, never applies effects", () => {
  const value = input(), proposal = proposalFor(value);
  assert.equal(proposal.id, proposalFor(value).id); assert.equal(proposal.application, "not_applied");
  assert.equal(proposal.actuallyExposed, false); assert.equal(proposal.invocation.session_id, "session-one");
  assert.deepEqual(validateExposureProposal(proposal, value), proposal);
  assert.throws(() => validateExposureProposal({...proposal, actuallyExposed:true}, value));
  assert.throws(() => validateExposureProposal(proposal, input({policy:{allowedRiskLevels:[]}})));
  assert.throws(() => exposureProposal({input:value, invocation:capabilityInvocation("capability/test-v1"), proposedIds:["invented"]}));
  assert.throws(() => exposureProposal({input:value, invocation:capabilityInvocation("capability/test-v1"), semanticCandidateIds:[descriptor().id]}));
});

test("unknown telemetry preserves null counts instead of invented zero availability", () => {
  const value = input({inventory:inventory(null, {state:"unknown"})}), proposal = proposalFor(value);
  const event = capabilityTelemetry(value, proposal);
  assert.equal(proposal.outcome, "no_decision"); assert.equal(event.inventory_count, null);
  assert.equal(event.eligible_count, null); assert.equal(event.proposed_exposed_count, null);
  assert.equal(event.schema_size_proxy.before, null);
  const empty = input({inventory:inventory([])});
  assert.equal(capabilityTelemetry(empty, proposalFor(empty)).inventory_count, 0);
});

test("telemetry projects IDs/counts/schema-size proxies without descriptor or provider payload", () => {
  const cap = descriptor("read", {name:"RAW_SECRET_NAME", description:"RAW_SECRET_DESCRIPTION", source:{namespace:"fixture", nativeId:"read", provider:"RAW_SECRET_PROVIDER"}});
  const value = input({inventory:inventory([entry(cap)])}), event = capabilityTelemetry(value, proposalFor(value));
  assert.equal(event.schema_size_proxy.before, 100); assert.equal(event.schema_size_proxy.after, 100);
  assert.equal(event.schema_size_proxy.unit, "UTF-16 characters");
  assert.equal(event.invocation_id, "invocation-one"); assert.ok(!JSON.stringify(event).includes("RAW_SECRET"));
  for (const key of ["raw", "probabilities", "model", "usage", "description", "schemas"]) assert.ok(!(key in event));
  assert.equal(schemaSizeProxy(inventory([entry(descriptor("no-size", {schemaChars:null}))]), [descriptor("no-size").id]), null);
});

test("runtime-neutral tool-like kinds work without importing M5 or runtime implementations", () => {
  for (const kind of ["tool", "mcp_tool", "plugin_tool", "cli"]) {
    const cap = descriptor("operation", {kind});
    assert.deepEqual(capabilityEligibility(input({inventory:inventory([entry(cap)])})).eligibleIds, [cap.id]);
  }
  const task = {id:"task", text:"Read a file", explicitSkills:["M5-only"], recentContext:[{text:"not capability policy"}]};
  assert.deepEqual(input({task}).task, {id:task.id, text:task.text});
});
