import { resolve, relative, sep, isAbsolute } from 'node:path';
import { sha256 } from '../../../core/src/hash.js';
import { ownedState, readBounded, verifyWorkspacePolicy, regularRoot, workspaceError } from './owned-workspace.js';
import { runReviewedCommand } from './reviewed-command.js';

export function modelWorkspaceInput(handle){
  const {manifest}=ownedState(handle);
  return {task:manifest.task,files:[...manifest.include],commands:Object.keys(manifest.commands),surfaces:[...manifest.surfaces]};
}
// Called after the model has settled. No verifier path, contents, stdout or
// expected-answer information enters modelWorkspaceInput or the tool executor.
export async function verifyBlindWorkspace(handle,{verifierRoot,entrypoint='verify.mjs',lifecycle,
  publicTests=null,runVerifier=runReviewedCommand}){
  const state=ownedState(handle);
  if(state.active||lifecycle?.nativeTurnCompleted!==true||lifecycle?.runtimeSettled!==true)throw workspaceError('LIVE_COMPLETION_VALIDATION_REQUIRED');
  const root=await regularRoot(verifierRoot),rel=relative(state.workspaceRoot,root);
  if(!rel||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))throw workspaceError('VERIFIER_MODEL_BOUNDARY_FAILED');
  const verifier=await readBounded(root,entrypoint,65536),before=await verifyWorkspacePolicy(handle);
  let execution=null,verifierFailure=null;
  if(before.passed){
    state.active++;
    try{
      execution=await runVerifier({argv:['node',entrypoint],timeoutMs:10000,maxOutputBytes:4096},root,{readOnlyInputs:[resolve(state.workspaceRoot)]});
      if(execution?.settled!==true)throw workspaceError('VERIFIER_DISPOSAL_UNVERIFIED');
      state.active--;
    }catch(error){verifierFailure=(error.code==='SANDBOX_REQUIRED'||error.message==='SANDBOX_REQUIRED')?'VERIFIER_ISOLATION_REQUIRED':'VERIFIER_EXECUTION_UNVERIFIED';
      // No spawn was possible at the guest-only admission guard.
      if(error.code==='SANDBOX_REQUIRED'||error.message==='SANDBOX_REQUIRED')state.active--;
    }
  }
  const after=await verifyWorkspacePolicy(handle),verifierAfter=await readBounded(root,entrypoint,65536);
  const passed=before.passed&&after.passed&&before.finalStateHash===after.finalStateHash&&verifier.hash===verifierAfter.hash
    &&execution?.exitCode===0&&execution?.settled===true&&!execution?.timedOut&&!verifierFailure
    &&(Object.keys(state.manifest.commands).length===0||publicTests?.passed===true);
  const body={schemaVersion:'jar.blind-acceptance.v1',runId:handle.id,taskHash:handle.taskHash,startStateHash:handle.startStateHash,
    finalStateHash:after.finalStateHash,verifierHash:verifier.hash,status:passed?'passed':'failed',
    nativeTurnCompleted:lifecycle.nativeTurnCompleted,modelFinalAnswerObserved:lifecycle.modelFinalAnswerObserved??null,
    verifierCompleted:execution?.settled===true,runtimeSettled:lifecycle.runtimeSettled,
    workspacePolicy:after,publicTestsPassed:publicTests?.passed??null,
    verifierExitCode:execution?.exitCode??null,failureCode:verifierFailure,groundTruthModelVisible:false};
  return {id:`acceptance_${sha256(body)}`,...body};
}
