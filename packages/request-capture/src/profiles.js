import { sha256 } from "../../core/src/hash.js";
import { freeze } from "../../capability-exposure/src/contracts.js";

export const CAPTURE_MODE = "FIXTURE_ONLY";
export const RUNTIME_CAPTURE_AUTHORIZED = false;
export const COMPLETENESS = Object.freeze(["COMPLETE", "PARTIAL", "UNKNOWN"]);
export const TOOL_STATES = Object.freeze(["PRESENT", "ABSENT", "UNKNOWN"]);

// Closed registry: callers cannot upgrade Codex by editing a profile object.
function profile(body) { return freeze({id:`tool_context_profile_${sha256(body)}`, ...body}); }
const representations = ["tools", "input.additional_tools", "input.tool_search_output"];
export const CODEX_PROFILE = profile({
  name:"codex-responses-known-containers-v1", runtimeFamily:"codex", versions:["0.158.0-alpha.2.1"],
  providerProtocol:"openai-responses-http", requestScope:"initial-request-static-context",
  completeness:"PARTIAL", representations, requiredContainers:["tools"],
  excludedRepresentations:["websocket-deltas", "resumed-history", "responses-lite-completeness"],
  unresolvedRepresentations:["description.code-mode-typescript", "contributor-generated-context"],
  dynamicContributors:["host-skills", "system-skills", "extensions", "mcp", "deferred-tools"],
  credentialBodyFields:[],
});
// COMPLETE only for this deliberately tiny synthetic grammar, never for a runtime.
export const SYNTHETIC_PROFILE = profile({
  name:"synthetic-static-tools-v1", runtimeFamily:"fixture", versions:["1"],
  providerProtocol:"synthetic-responses-shaped-json", requestScope:"initial-request-static-context",
  completeness:"COMPLETE", representations, requiredContainers:["tools"],
  excludedRepresentations:["messages", "description-text", "deferred-tools", "code-mode", "runtime-context"],
  unresolvedRepresentations:[], dynamicContributors:[], credentialBodyFields:[],
});
export function getProtocolProfile(id) {
  const found = [CODEX_PROFILE, SYNTHETIC_PROFILE].find(p => p.id === id);
  if (!found) throw new TypeError("Unknown protocol profile");
  return found;
}
