import { stableStringify } from "../../core/src/hash.js";

/** Config observations only. Source order/scope never implies native precedence.
 * Even agreement is limited to these explicitly supplied, partial sources.
 */
export function reconcileConfigObservations(captures, sources) {
  const signatures = captures.map(capture => stableStringify(capture.observations.map(({evidence, ...item}) => item)
    .sort((a, b) => a.capability.id.localeCompare(b.capability.id))));
  const incomplete = sources.some(source => source.outcome !== "success" || source.parserState !== "parsed");
  const different = new Set(signatures).size > 1;
  const layerState = !sources.length || sources.every(source => source.outcome === "not_attempted") ? "unknown" : sources.length === 1 ? "single_source"
    : incomplete ? "partial" : different ? "unresolved" : "compatible";
  const uncertain = sources.length > 1 && (incomplete || different);
  const observations = new Map(), bindings = new Map();
  for (const capture of captures) {
    for (const item of capture.observations) {
      const previous = observations.get(item.capability.id);
      observations.set(item.capability.id, {...item,
        configuredEnabled:uncertain ? null : item.configuredEnabled,
        configuredPermission:uncertain ? "unknown" : item.configuredPermission,
        parentIds:[...new Set([...(previous?.parentIds ?? []), ...item.parentIds])].sort(),
        evidence:[...(previous?.evidence ?? []), ...item.evidence]});
    }
    for (const [id, binding] of capture.bindings) bindings.set(id, binding);
  }
  return {observations:[...observations.values()], bindings, layerState,
    issues:[...new Set([...captures.flatMap(capture => capture.issues),
      ...(uncertain ? ["layer_precedence_unresolved", "configured_intent_conflicted_or_incomplete"] : []),
      ...(sources.length ? ["effective_config_unverified"] : [])])]};
}
