import { spawn } from 'node:child_process';
import { assertGuest } from '../../../../scripts/m12-codex-session.mjs';
import { workspaceError, regularRoot, checkedFile } from './owned-workspace.js';
import { sha256 } from '../../../core/src/hash.js';

/** Trusted runner only. Production is guest-only; no host command execution is
 * exposed by the CLI. Node --permission restricts files/process creation, not
 * networking in Node 24. The network-disabled guest is essential even for an
 * immutable entrypoint: it may import model-edited code. Injected process
 * operations are for offline contract tests, not a production host bypass. */
export async function runReviewedCommand(command,cwd,{assertBoundary=assertGuest,spawnProcess=spawn,terminateTree=null,readOnlyInputs=[]}={}){
  assertBoundary();await regularRoot(cwd);
  if(command.argv?.length!==2||command.argv[0]!=='node'||!command.argv[1].endsWith('.mjs')
    ||!Number.isSafeInteger(command.timeoutMs)||command.timeoutMs<1||command.timeoutMs>30000
    ||!Number.isSafeInteger(command.maxOutputBytes)||command.maxOutputBytes<1||command.maxOutputBytes>16384)throw workspaceError('COMMAND_INVALID');
  await checkedFile(cwd,command.argv[1]);
  if(!Array.isArray(readOnlyInputs)||readOnlyInputs.length>1)throw workspaceError('COMMAND_INVALID');
  for(const root of readOnlyInputs)await regularRoot(root);
  const child=spawnProcess(process.execPath,['--permission',`--allow-fs-read=${cwd}`,...readOnlyInputs.map(root=>`--allow-fs-read=${root}`),command.argv[1],...readOnlyInputs],{cwd,shell:false,windowsHide:true,
    env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:cwd,TMP:cwd},stdio:['ignore','pipe','pipe']});
  let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),truncated=false,timedOut=false;
  for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',chunk=>{
    const previous=key==='stdout'?stdout:stderr,bytes=Buffer.from(chunk),remaining=command.maxOutputBytes-previous.length;
    if(bytes.length>remaining)truncated=true;const next=Buffer.concat([previous,bytes.subarray(0,Math.max(0,remaining))]);
    if(key==='stdout')stdout=next;else stderr=next;
  });
  let deadline;
  const closed=new Promise(resolve=>{child.once('error',()=>resolve(127));child.once('close',code=>resolve(code??127));});
  let exitCode=await Promise.race([closed,new Promise(resolve=>{deadline=setTimeout(()=>resolve(null),command.timeoutMs);})]);clearTimeout(deadline);
  if(exitCode===null){
    timedOut=true;
    const terminate=terminateTree??(async process=>{
      assertGuest(); // PID belongs to the child just spawned inside this guest.
      const killer=spawn('C:/Windows/System32/taskkill.exe',['/PID',String(process.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      await new Promise((yes,no)=>{const timer=setTimeout(()=>{killer.kill();no(workspaceError('COMMAND_DISPOSAL_UNVERIFIED'));},5000);
        killer.once('error',()=>{clearTimeout(timer);no(workspaceError('COMMAND_DISPOSAL_UNVERIFIED'));});
        killer.once('exit',code=>{clearTimeout(timer);code===0?yes():no(workspaceError('COMMAND_DISPOSAL_UNVERIFIED'));});});
    });
    await terminate(child);
    let settlement;exitCode=await Promise.race([closed,new Promise(resolve=>{settlement=setTimeout(()=>resolve(null),5000);})]);clearTimeout(settlement);
    if(exitCode===null)throw workspaceError('COMMAND_DISPOSAL_UNVERIFIED');
  }
  return {exitCode,timedOut,settled:true,truncated,stdoutBytes:stdout.length,stderrBytes:stderr.length,
    stdoutHash:sha256(stdout.toString('base64')),stderrHash:sha256(stderr.toString('base64'))};
}
