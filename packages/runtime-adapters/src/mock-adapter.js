import { runtimeIdentity, runtimeSupport, runtimeObservation, exposureRequest, runtimeExposurePlan,
  runtimeEffectResult, assertRuntimeAdapter } from "./contracts.js";

/** Fixture-only contract provider. No filesystem, processes, network or model API. */
export function createMockRuntimeAdapter({identity, facts = {}, observation = {}, mechanism = {}}) {
  const id = runtimeIdentity(identity), support = runtimeSupport({runtimeId:id.id, facts});
  const snapshot = runtimeObservation({identity:id, scope:"fixture", ...observation});
  const settings = structuredClone(mechanism);
  const plans = new Map();
  const disabled = plan => {
    if (plans.get(plan.id) !== plan) throw new TypeError("Plan not owned by this adapter");
    return runtimeEffectResult({plan});
  };
  return assertRuntimeAdapter(Object.freeze({
    async identify() { return id; },
    async capabilities() { return support; },
    async snapshot() { return snapshot; },
    async inspectExposure() { return snapshot.actualExposure; },
    async planExposure(request) {
      const plan = runtimeExposurePlan({...settings, runtimeId:id.id, request:exposureRequest(request),
        discoveryId:snapshot.id, exposureObservationId:snapshot.actualExposure.id});
      if (!plans.has(plan.id)) plans.set(plan.id, plan);
      return plans.get(plan.id);
    },
    async applyExposure(plan) { return disabled(plan); },
    async restoreExposure(plan) { return disabled(plan); },
  }));
}
