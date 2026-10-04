export function classifyCorrectness(evaluation){
  const required=['build','publicTests','acceptance','evaluatorPreservedProduct'];
  const missing=required.filter(key=>evaluation?.[key]===null||evaluation?.[key]===undefined);
  if(missing.length)return{status:'INFRA_FAILURE',correct:false,reason:'VERIFIER_DETAIL_MISSING',missing};
  if(evaluation.evaluatorPreservedProduct!==true)return{status:'INFRA_FAILURE',correct:false,reason:'EVALUATOR_INTEGRITY_FAILED'};
  if(!Number.isSafeInteger(evaluation.acceptance.passed)||!Number.isSafeInteger(evaluation.acceptance.total)||evaluation.acceptance.total<1)return{status:'INFRA_FAILURE',correct:false,reason:'ACCEPTANCE_RESULT_INVALID'};
  const correct=evaluation.build.pass===true&&evaluation.publicTests.pass===true&&evaluation.acceptance.passed===evaluation.acceptance.total;
  return{status:correct?'CORRECT':'INCORRECT',correct,reason:correct?'ALL_GATES_PASSED':'PRODUCT_GATE_FAILED'};
}

