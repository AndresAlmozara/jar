import {DiagnosticError} from './common.mjs';
export function schedule(tasks) {return tasks.flatMap(t=>(t.order==='CONTROL_FIRST'?['CONTROL','JAR']:['JAR','CONTROL']).map(condition=>({task:t.task_id,condition})));}
export async function executeConditions(plan,{run,before=async()=>{},after=async()=>{},onResult=async()=>{},cancelled=()=>false}) {
  const results=[];
  for(const item of plan){
    if(cancelled())throw new DiagnosticError('USER_INTERRUPTED');
    await before(item);
    let row;
    try{row=await run(item);}catch(e){row={task_id:item.task,condition:item.condition,outcome:'INFRA_FAIL',error:{code:e.code??'UNCAUGHT_RUN_ERROR',message:e.message}};}
    results.push(row);await onResult(row);
    if(row.outcome==='INFRA_FAIL')throw new DiagnosticError('INFRA_FAIL_STOP',{task:item.task,condition:item.condition,error:row.error});
    if(!['PASS','FAIL'].includes(row.outcome))throw new DiagnosticError('UNKNOWN_CONDITION_OUTCOME',{row});
    await after(item,row);
  }
  return results;
}
