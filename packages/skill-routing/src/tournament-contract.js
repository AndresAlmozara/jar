import { SKILL_OUTCOMES } from "./common.js";

/**
 * SkillShadowTournament.run({task,catalog,runtime?,session?,strategies}) accepts
 * plain snapshot data and an ordered array of {id, route(input)} objects.
 * It captures the logical input once, then passes an independent clone per arm.
 * input.decisionContext.invocation_id is allocated before route; strategies use
 * withSkillInvocation to retain that identity in provider events and proposals.
 *
 * Result: {version, tournament_run_id, task_id, session_id, catalog_hash,
 * execution:"sequential", shadow:true, results:SkillShadowArm[]}.
 * SkillShadowArm: {strategy_id, strategy_version, invocation_id, configuration, latency_ms,
 * proposal:RouteProposal}. Version is the declared strategy.version or the vN
 * suffix of its ID, otherwise null. Array order is configuration order.
 * proposal.decision retains existing outcome/reason/error, canonical selections,
 * confidence and provenance verbatim. Confidence is strategy-specific, not a
 * comparable score. No ranking or EffectiveRoute is produced.
 *
 * Invalid shared inputs/configuration reject before any arm runs. A rejected arm
 * or malformed proposal becomes an error proposal; provider failures returned by
 * a strategy retain their original classification. Missing call counts on an
 * uncaught arm error are unknown (null), never invented zeroes.
 * Optional onTelemetry emits one skill_shadow_run and one skill_shadow_result
 * per arm after routing settles. Provider events join through invocation_id;
 * recording.status is disabled/complete/incomplete for tournament writes only.
 * Recorder errors do not rewrite routing outcomes or stop other event writes.
 */
export const TOURNAMENT_VERSION="skill.shadow.v1";

export function assertSkillShadowProposal(proposal,{task,catalog},strategyId,invocationId) {
  const decision=proposal?.decision;
  const selected=decision?.selectedSkillIds;
  const ids=new Set(catalog.skills.map((skill)=>skill.id));
  if (proposal?.taskId!==task.id || proposal?.strategy!==strategyId || proposal?.component!=="skills"
      || proposal?.provider?.kind!=="shadow" || !Object.values(SKILL_OUTCOMES).includes(decision?.outcome)
      || !Array.isArray(selected) || selected.some((id)=>typeof id!=="string" || !ids.has(id))
      || new Set(selected).size!==selected.length
      || (decision.outcome==="selected" ? selected.length===0 : selected.length!==0)
      || decision.noSkill!==(decision.outcome==="no_skill")
      || decision.provenance?.invocation?.invocation_id!==invocationId
      || decision.provenance?.invocation?.caller!==strategyId) {
    throw new TypeError("Invalid skill shadow proposal");
  }
  return proposal;
}
