import { readFile,writeFile,rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { verifierDetail } from './verifier-detail.mjs';
const root='C:/JAR',plan=JSON.parse(await readFile(join(root,'input/plan.json'),'utf8'));
let out=Buffer.alloc(0),err=Buffer.alloc(0),truncated=false;const child=spawn(process.execPath,[join(root,'input/verifier',plan.entrypoint),join(root,'input/workspace')],
  {cwd:join(root,'input/verifier'),shell:false,windowsHide:true,env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:'C:\\Windows\\Temp',TMP:'C:\\Windows\\Temp'},stdio:['ignore','pipe','pipe']});
for(const [stream,key] of [[child.stdout,'out'],[child.stderr,'err']])stream.on('data',chunk=>{const old=key==='out'?out:err,left=4096-old.length;if(chunk.length>left)truncated=true;const next=Buffer.concat([old,Buffer.from(chunk).subarray(0,Math.max(0,left))]);if(key==='out')out=next;else err=next;});
const closed=new Promise(resolve=>{child.once('error',()=>resolve(127));child.once('close',code=>resolve(code??127));});let timer;let exitCode=await Promise.race([closed,new Promise(r=>timer=setTimeout(()=>r(null),10000))]);clearTimeout(timer);
if(exitCode===null){spawn('C:/Windows/System32/taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});exitCode=await closed;}
const {detail,receiptExitCode}=verifierDetail(out.toString('utf8'),plan.runId,exitCode);
await writeFile(join(root,'output/diagnostic-details.json.tmp'),JSON.stringify(detail)+'\n',{flag:'wx'});
await rename(join(root,'output/diagnostic-details.json.tmp'),join(root,'output/diagnostic-details.json'));
const receipt={schemaVersion:'jar.sandbox-verifier-receipt.v1',runId:plan.runId,status:receiptExitCode===0?'passed':'failed',exitCode:receiptExitCode,
  diagnostics:{stdoutBytes:out.length,stderrBytes:err.length,truncated},ownedProcessesRemaining:0,toolExecutionNetwork:'disabled_by_windows_sandbox',modelHadVerifierAccess:false,guestTerminatedRequested:true};
// Publish only after the complete receipt is closed on the mapped filesystem.
await writeFile(join(root,'output/receipt.json.tmp'),JSON.stringify(receipt)+'\n',{flag:'wx'});
await rename(join(root,'output/receipt.json.tmp'),join(root,'output/receipt.json'));
spawn('C:/Windows/System32/shutdown.exe',['/s','/t','30','/f'],{stdio:'ignore',windowsHide:true});
