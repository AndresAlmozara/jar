export const BASELINE_POLICIES=Object.freeze({
  CORRECT_PRODUCT:'CORRECT_PRODUCT',
  DIAGNOSTIC_REFERENCE:'DIAGNOSTIC_REFERENCE'
});

const finite=value=>Number.isFinite(value);

export function assessBaseline(control,policy){
  if(policy===BASELINE_POLICIES.CORRECT_PRODUCT){
    const admitted=control?.status==='COMPLETED'&&control?.correctness?.correct===true;
    return{admitted,policy,reasons:admitted?[]:['CONTROL_MUST_BE_CORRECT']};
  }
  if(policy!==BASELINE_POLICIES.DIAGNOSTIC_REFERENCE)throw Object.assign(Error('BASELINE_POLICY_UNKNOWN'),{code:'BASELINE_POLICY_UNKNOWN',policy});
  const evaluation=control?.evaluation,acceptance=evaluation?.acceptance,usage=control?.telemetry?.mainModelUsage,timings=control?.telemetry?.timings;
  const checks={
    sessionCompleted:control?.status==='COMPLETED'&&control?.session?.status==='completed',
    exactlyOneTurn:control?.mainModelTurnsStarted===1,
    buildCompleted:typeof evaluation?.build?.pass==='boolean'&&finite(evaluation?.build?.exitCode),
    publicEvaluatorCompleted:typeof evaluation?.publicTests?.pass==='boolean'&&finite(evaluation?.publicTests?.exitCode),
    hiddenEvaluatorCompleted:Array.isArray(acceptance?.checks)&&acceptance.checks.length>0&&finite(acceptance?.passed)&&acceptance?.total===acceptance.checks.length,
    evaluatorPreservedProduct:evaluation?.evaluatorPreservedProduct===true,
    usageComplete:['totalTokens','inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens'].every(key=>finite(usage?.[key])),
    trajectoryComplete:finite(control?.telemetry?.wallTimeMs)&&finite(timings?.toolCalls)&&(finite(timings?.uniqueToolsUsed)||(Array.isArray(timings?.uniqueToolsUsed)&&timings.uniqueToolsUsed.length>0)),
    routingComplete:control?.routing&&typeof control.routing==='object',
    runtimeComplete:typeof control?.telemetry?.runtimeMetadata?.codexRuntimeHash==='string'&&typeof control?.telemetry?.runtimeMetadata?.baselineId==='string'
  };
  const reasons=Object.entries(checks).filter(([,pass])=>!pass).map(([name])=>name);
  return{admitted:reasons.length===0,policy,reasons,checks};
}
