import { sha256 } from "../../core/src/hash.js";
import { newId } from "../../core/src/ids.js";

export const OUTPUT_VERSION = "output.contracts.v1";
export const OUTPUT_REASONS = Object.freeze([
  "control", "no_filtering_required", "reduced", "unsupported_content", "small_output",
  "unsafe_output", "uncertain", "filter_failure", "provider_failure", "invalid_semantic_decision",
  "archive_failure", "recovery_unavailable", "segmentation_limit",
]);
const textId = value => typeof value === "string" && value.length > 0;
const digest = (prefix, value) => `${prefix}_${sha256(value)}`;
export const lineCount = text => text === "" ? 0 : (text.match(/\r\n|\r|\n/g)?.length ?? 0) + Number(!/[\r\n]$/.test(text));

function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError("Invalid output contract fields");
}

/** Fresh adapter capture, never a conversation/message snapshot. Parts are ordered
 * events, not a map: a channel can occur multiple times. Text is JS UTF-16 with
 * original delimiters; bytes/encoding before adapter decoding are out of scope.
 * Opaque payloads are held by reference ONLY for pass-through, never serialized.
 * IDs supplied by adapters must be identifiers, not prompts or credentials.
 */
export function freshOutput(input) {
  keys(input, ["toolInvocationId", "capabilityId", "taskId", "sessionId", "sequence", "parts", "source"]);
  if (![input.toolInvocationId, input.capabilityId].every(textId)
      || !Array.isArray(input.parts) || input.parts.length === 0) throw new TypeError("Fresh output identity and parts required");
  for (const key of ["taskId", "sessionId"]) if (input[key] != null && !textId(input[key])) throw new TypeError("Invalid correlation identity");
  const sequence = input.sequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("Invalid output sequence");
  const source = input.source ?? {};
  keys(source, ["runtimeId", "sourceId", "outputClass", "failed", "truncated", "sensitive", "completeRequested", "recoveryRead"]);
  for (const key of ["runtimeId", "sourceId"]) if (source[key] != null && !textId(source[key])) throw new TypeError("Invalid source identity");
  if (source.outputClass !== undefined && !["log", "progress", "reference", "structured", "search", "listing", "unknown"].includes(source.outputClass)) throw new TypeError("Invalid output class");
  for (const key of ["failed", "truncated", "sensitive", "completeRequested", "recoveryRead"]) {
    if (source[key] !== undefined && typeof source[key] !== "boolean") throw new TypeError("Invalid source flag");
  }
  const parts = input.parts.map(part => {
    keys(part, ["channel", "contentType", "text", "opaque"]);
    if (!textId(part.channel) || !["text", "binary", "image", "audio", "opaque"].includes(part.contentType)) throw new TypeError("Invalid output part");
    if (part.contentType === "text") {
      if (typeof part.text !== "string" || "opaque" in part) throw new TypeError("Text part required");
      return Object.freeze({channel:part.channel, contentType:"text", text:part.text});
    }
    if ("text" in part) throw new TypeError("Do not stringify opaque content");
    return Object.freeze({channel:part.channel, contentType:part.contentType, opaque:part.opaque});
  });
  const supported = parts.every(part => part.contentType === "text");
  const identity = {version:OUTPUT_VERSION, toolInvocationId:input.toolInvocationId, capabilityId:input.capabilityId,
    taskId:input.taskId ?? null, sessionId:input.sessionId ?? null, sequence, source:{...source},
    parts:parts.map(({channel, contentType, text}) => ({channel, contentType, ...(contentType === "text" ? {text} : {})}))};
  return Object.freeze({...identity, id:digest("output", identity), supported,
    contentHash:supported ? sha256(parts) : null,
    chars:supported ? parts.reduce((sum, part) => sum + part.text.length, 0) : null,
    lines:supported ? parts.reduce((sum, part) => sum + lineCount(part.text), 0) : null,
    source:Object.freeze({...source}), parts:Object.freeze(parts)});
}

export function assertFreshOutput(observation) {
  keys(observation, ["version", "toolInvocationId", "capabilityId", "taskId", "sessionId", "sequence", "source", "parts", "id", "supported", "contentHash", "chars", "lines"]);
  if (observation?.version !== OUTPUT_VERSION) throw new TypeError("Invalid fresh output version");
  const rebuilt = freshOutput(Object.fromEntries(["toolInvocationId", "capabilityId", "taskId", "sessionId", "sequence", "parts", "source"].map(key => [key, observation[key]])));
  for (const key of ["id", "supported", "contentHash", "chars", "lines"]) {
    if (rebuilt[key] !== observation[key]) throw new TypeError("Fresh output identity mismatch");
  }
  return observation;
}

export function outputInvocation(strategy, observation, invocationId = newId("invocation")) {
  if (!/^output\/[a-z][a-z0-9-]*-v\d+$/.test(strategy) || !textId(invocationId)) throw new TypeError("Invalid output invocation");
  return Object.freeze({invocation_id:invocationId, caller:strategy, component:"output_filtering", session_id:observation.sessionId});
}

/** The only task descriptor admitted by future strategies: no recentContext,
 * messages, history or runtime object can cross this boundary. */
export function currentOutputTask(task) {
  keys(task, ["id", "text"]);
  if (!textId(task.id) || !textId(task.text)) throw new TypeError("Current task required");
  return Object.freeze({id:task.id, text:task.text});
}

export function filterProposal({observation, invocation, outcome = "passthrough", method = "none",
  reason = "no_filtering_required", retainedSegmentIds = [], recoveryRef = null, configuration = {}}) {
  const proposal = {version:OUTPUT_VERSION, observationId:observation.id, strategy:invocation.caller,
    invocation:{...invocation}, outcome, method, reason, retainedSegmentIds:[...retainedSegmentIds], recoveryRef,
    configuration:{...configuration}};
  proposal.id = digest("filter", proposal);
  validateFilterProposal(proposal, observation);
  return Object.freeze({...proposal, invocation:Object.freeze(proposal.invocation),
    retainedSegmentIds:Object.freeze(proposal.retainedSegmentIds), configuration:Object.freeze(proposal.configuration)});
}

export function validateFilterProposal(p, observation) {
  keys(p, ["version", "observationId", "strategy", "invocation", "outcome", "method", "reason", "retainedSegmentIds", "recoveryRef", "configuration", "id"]);
  const invocation = p?.invocation;
  if (!p || p.version !== OUTPUT_VERSION || p.observationId !== observation.id
      || !/^output\/[a-z][a-z0-9-]*-v\d+$/.test(p.strategy)
      || !textId(invocation?.invocation_id) || invocation.caller !== p.strategy
      || invocation.component !== "output_filtering" || invocation.session_id !== observation.sessionId
      || !["passthrough", "reduced", "unsupported", "error"].includes(p.outcome)
      || !["none", "deterministic", "semantic"].includes(p.method) || !OUTPUT_REASONS.includes(p.reason)
      || (p.outcome === "reduced" ? p.method === "none" || p.reason !== "reduced" : p.method !== "none")
      || (p.outcome === "unsupported" && p.reason !== "unsupported_content")
      || (p.outcome === "error" && !["uncertain", "filter_failure", "provider_failure", "invalid_semantic_decision", "archive_failure", "recovery_unavailable", "segmentation_limit"].includes(p.reason))
      || (p.outcome === "passthrough" && !["control", "no_filtering_required", "small_output", "unsafe_output", "uncertain"].includes(p.reason))
      || !Array.isArray(p.retainedSegmentIds) || !p.retainedSegmentIds.every(textId)
      || new Set(p.retainedSegmentIds).size !== p.retainedSegmentIds.length
      || (p.recoveryRef !== null && !/^recovery_[a-f0-9]{64}$/.test(p.recoveryRef))
      || !p.configuration || typeof p.configuration !== "object" || Array.isArray(p.configuration)
      || Object.values(p.configuration).some(value => typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value) && value >= 0))) {
    throw new TypeError("Invalid filter proposal");
  }
  const {id, ...body} = p;
  if (id !== digest("filter", body)) throw new TypeError("Filter proposal identity mismatch");
  return p;
}

/** Stable reference binds the complete ordered textual observation, not a path. */
export function outputRecoveryRef(observation) {
  assertFreshOutput(observation);
  if (!observation.supported) throw new TypeError("Opaque output cannot be archived by text V1");
  return digest("recovery", {observationId:observation.id, contentHash:observation.contentHash});
}
