import { newId } from "./ids.js";

export class DeterministicDecisionEngine {
  constructor({choice,noul,score,judge}={}) { this.handlers={choice,noul,score,judge}; }
  async choice(input) { return this.handlers.choice ? this.handlers.choice(input) : {choice:null,probabilities:{},confidence:0,source:"deterministic-none"}; }
  async noul(input) { return this.handlers.noul ? this.handlers.noul(input) : {probability_true:0.5,probability_false:0.5,source:"deterministic-none"}; }
  async score(input) { return this.handlers.score ? this.handlers.score(input) : {score:0,confidence:1,source:"deterministic-default"}; }
  async judge(input) { return this.handlers.judge ? this.handlers.judge(input) : {value:false,confidence:1,source:"deterministic-default"}; }
}

export class ShadowRoutingStrategy {
  constructor(id, proposeFn) { this.id=id; this.proposeFn=proposeFn; }
  async propose(input) {
    const decision=await this.proposeFn(input);
    return {id:newId("proposal"),taskId:input.task.id,component:decision.component ?? "unknown",strategy:this.id,candidates:decision.candidates ?? [],decision:decision.decision ?? decision,provider:decision.provider ?? {kind:"shadow"},createdAt:new Date().toISOString()};
  }
}
