import { assertTaskSnapshot, assertCatalogSnapshot } from "../../core/src/contracts.js";
import { newId } from "../../core/src/ids.js";
import { canonicalSkills, makeSkillProposal, SKILL_OUTCOMES } from "./common.js";
import { createSkillInvocation } from "./invocation.js";
import { assertSkillShadowProposal, TOURNAMENT_VERSION } from "./tournament-contract.js";
import { strategyConfiguration, strategyEvent, tournamentEvent } from "./shadow-telemetry.js";

// Observations only: no runtime adapter, catalog loader or winner policy belongs here.
export class SkillShadowTournament {
  constructor({onTelemetry=null}={}) { this.onTelemetry=onTelemetry; }
  async run({task,catalog,runtime,session,strategies}) {
    assertTaskSnapshot(task);
    assertCatalogSnapshot(catalog);
    canonicalSkills(catalog);
    if (!Array.isArray(strategies) || !strategies.length
        || strategies.some((strategy)=>!strategy || typeof strategy.id!=="string" || !strategy.id || typeof strategy.route!=="function")) {
      throw new TypeError("An ordered nonempty array of skill strategies is required");
    }
    const arms=strategies.map((strategy)=>({id:strategy.id,version:strategy.version??strategy.id.match(/-(v\d+)$/)?.[1]??null,configuration:strategyConfiguration(strategy),route:strategy.route.bind(strategy)}));
    // Capture before the first await; caller edits and arm mutations cannot affect later arms.
    const snapshot=structuredClone({task,catalog,runtime,session});
    const result={version:TOURNAMENT_VERSION,tournament_run_id:newId("tournament"),task_id:snapshot.task.id,
      session_id:snapshot.session?.sessionId??snapshot.runtime?.sessionId??null,catalog_hash:snapshot.catalog.hash,
      execution:"sequential",shadow:true,results:[]};
    for (const arm of arms) {
      const invocation=createSkillInvocation(arm.id,snapshot);
      const input={...structuredClone(snapshot),decisionContext:invocation};
      const started=performance.now();
      let proposal; let returned=false;
      try {
        proposal=await arm.route(input);
        returned=true;
        assertSkillShadowProposal(proposal,snapshot,arm.id,invocation.invocation_id);
        proposal=structuredClone(proposal);
      } catch {
        // Never copy arbitrary exception messages/stacks or pretend to know lost call counts.
        proposal=makeSkillProposal({strategy:arm.id,...snapshot,outcome:SKILL_OUTCOMES.ERROR,
          reason:returned?"strategy_invalid_proposal":"strategy_execution_failure",
          error:{name:returned?"InvalidProposal":"StrategyExecutionError",code:null},
          provenance:{invocation,decisionCalls:null,jevCallCount:null,failureStage:returned?"normalization":"execution"},
          latencyMs:performance.now()-started});
      }
      result.results.push({strategy_id:arm.id,strategy_version:arm.version,invocation_id:invocation.invocation_id,configuration:arm.configuration,
        latency_ms:performance.now()-started,proposal});
    }
    result.recording={status:this.onTelemetry?"complete":"disabled",errors:[]};
    if (this.onTelemetry) {
      for (const event of [tournamentEvent(result,snapshot),...result.results.map(arm=>strategyEvent(result,arm))]) {
        try { await this.onTelemetry(event); }
        catch { result.recording.status="incomplete";result.recording.errors.push({event_type:event.event_type,strategy_invocation_id:event.strategy_invocation_id??null}); }
      }
    }
    return result;
  }
}
