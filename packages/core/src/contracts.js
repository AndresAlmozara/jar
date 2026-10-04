/**
 * Portable domain contracts. These are intentionally plain data contracts:
 * no ECC, OpenCode, Codex or Jev imports belong here.
 */

/** @typedef {{ id:string, text:string, createdAt:string, phase?:string|null, recentContext?:Array<object>, explicitSkills?:string[], project?:object, runtime?:object }} TaskSnapshot */
/** @typedef {{ type:string, root:string, git_commit:string|null, git_dirty:boolean|null }} CatalogSource */
/** @typedef {{ version:string, source:CatalogSource, hash:string, generatedAt:string, skills:Array<object>, agents:Array<object>, components:Array<object>, modules?:Array<object>, profiles:Record<string,object> }} CatalogSnapshot */
/** @typedef {{ runtime:string, sessionId?:string|null, visibleSkills?:string[]|null, activeTools?:string[], model?:string|null, effort?:string|null, metadata?:object }} RuntimeState */
// visibleSkills omitted/null means unknown. An array is an explicitly authoritative,
// exhaustive visibility set for this snapshot (including []); partial observations
// must not be supplied as that set. Visibility is not a runtime compatibility claim.
/** @typedef {{ id:string, taskId:string, component:string, strategy:string, candidates:Array<object>, decision:object, provider?:object, createdAt:string }} RouteProposal */
/** @typedef {{ id:string, proposalId:string, taskId:string, applied:object, policy:object, enforcement:object, createdAt:string }} EffectiveRoute */
/** @typedef {{ id:string, taskId:string, effectiveRouteId?:string|null, observations:object, verification?:object, outcome?:string|null, createdAt:string }} ExecutionReceipt */

/**
 * @typedef {object} DecisionEngine
 * Primitive input may include decisionContext for telemetry correlation only.
 * @see DecisionInvocationContext
 * @property {(input:object)=>Promise<object>} choice
 * @property {(input:object)=>Promise<object>} noul
 * @property {(input:object)=>Promise<object>} score
 * @property {((input:object)=>Promise<object>)=} judge Legacy deterministic boolean convenience.
 */

/** @typedef {{ invocation_id:string, caller:string, component:string, session_id?:string|null, operation:string, operation_id?:string|null, call_id:string }} DecisionInvocationContext */
// Identifiers only: do not place prompts, credentials, or raw state in decisionContext.

/**
 * @typedef {object} CatalogAdapter
 * @property {()=>Promise<CatalogSnapshot>} snapshot
 */

/**
 * @typedef {object} RuntimeAdapter
 * @property {()=>Promise<object>} capabilities
 * @property {()=>Promise<RuntimeState>} snapshot
 * @property {(route:EffectiveRoute)=>Promise<object>} apply
 */

/**
 * @typedef {object} RoutingStrategy
 * @property {string} id
 * @property {(input:{task:TaskSnapshot,catalog:CatalogSnapshot,runtime?:RuntimeState})=>Promise<RouteProposal>} propose
 */

export const CONTRACT_VERSION = "jar.contracts.v1";

export function assertTaskSnapshot(value) {
  if (!value || typeof value !== "object") throw new TypeError("TaskSnapshot must be an object");
  if (!value.id || typeof value.id !== "string") throw new TypeError("TaskSnapshot.id is required");
  if (!value.text || typeof value.text !== "string") throw new TypeError("TaskSnapshot.text is required");
  return value;
}

export function assertCatalogSnapshot(value) {
  if (!value || typeof value !== "object") throw new TypeError("CatalogSnapshot must be an object");
  if (!Array.isArray(value.skills)) throw new TypeError("CatalogSnapshot.skills must be an array");
  if (!value.hash) throw new TypeError("CatalogSnapshot.hash is required");
  return value;
}
