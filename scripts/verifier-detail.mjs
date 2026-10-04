export function verifierDetail(stdout,runId,exitCode){
  let parsed=null;
  for(const line of String(stdout).trim().split(/\r?\n/).reverse()){
    try{parsed=JSON.parse(line);break;}catch{}
  }
  const valid=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&typeof parsed.pass==='boolean'
    &&['functional','infrastructure'].includes(parsed.kind);
  if(valid)return {detail:{...parsed,runId},receiptExitCode:exitCode};
  return {detail:{runId,pass:false,kind:'infrastructure',phase:'verifier_output',error:'VERIFIER_DETAIL_INVALID'},receiptExitCode:86};
}
