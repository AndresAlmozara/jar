import { stableStringify } from "../../core/src/hash.js";
import { freeze } from "../../capability-exposure/src/contracts.js";
import { runtimeEffectResult } from "./contracts.js";

/** Identifier-only join seam for existing JsonlTelemetryStore; no automatic writes.
 * Callers explicitly decide whether/where to persist. No native config or names.
 */
export function runtimeReceiptTelemetry(plan, result = runtimeEffectResult({plan})) {
  const normalized = runtimeEffectResult({plan, status:result.status, attemptId:result.attemptId,
    observed:result.observed, restoration:result.restoration});
  if (stableStringify(normalized) !== stableStringify(result)) throw new TypeError("Receipt correlation/content mismatch");
  return freeze({event_type:"runtime_exposure_receipt", component:"runtime_adapter", task_id:result.taskId,
    proposal_id:result.proposalId, inventory_id:result.inventoryId, invocation_id:result.invocationId, session_id:result.sessionId,
    runtime_id:result.runtimeId, runtime_plan_id:result.planId, translation_hash:plan.translationHash,
    discovery_id:result.discoveryId, exposure_observation_id:result.exposureObservationId,
    actual_observation_id:result.observed.id, restore_observation_id:result.restoration.observed.id,
    attempt_id:result.attemptId, effect_status:result.status, actual_exposure_state:result.observed.state,
    actual_exposed_count:result.observed.visibleIds?.length ?? null, restore_plan_id:result.restoration.planId,
    restore_status:result.restoration.status});
}
