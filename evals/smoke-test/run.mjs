import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {json,sha,treeHash,atomic,command,parseJson,iso,redactor,errorInfo,DiagnosticError,fail,immutableSnapshot,acquireLock,filesUnder} from './lib/common.mjs';
import {makePairs,publish,renderReport} from './lib/report.mjs';
import {executeConditions,schedule} from './lib/orchestrator.mjs';
import {loadJar,readiness,checkLifecycleContract,idleGate,verifyFixture,preflightFixture,runCondition} from './lib/bridge.mjs';
import {prepareModelAccess} from './lib/model-access.mjs';
import {createRunIdentity} from '../_shared/run-identity.mjs';
export const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const benchmarkResultsRoot=repo=>path.join(repo,'.jar','benchmarks','smoke-test');
export function locateRepo(root,explicit=null) {
  const candidates=explicit?[explicit]:[process.env.JAR_REPO,process.cwd(),path.resolve(root,'../..')];
  for(const raw of candidates){if(!raw)continue;const p=path.resolve(raw.replace(/^"|"$/g,''));try{
    if(json(path.join(p,'package.json')).name==='jev-agentic-router'&&fs.existsSync(path.join(p,'bin/jar.js')))return p;
  }catch{}}
  fail('JAR_REPO_NOT_FOUND',{solution:'Run from the repository root or pass --repo.'});
}
export async function hydrateKey(scrub) {
  if(process.env.TYPESAFE_API_KEY?.trim()){process.env.TYPESAFE_API_KEY=process.env.TYPESAFE_API_KEY.trim();scrub.add(process.env.TYPESAFE_API_KEY);return 'process_environment';}
  if(process.platform==='win32'){
    const ps=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    // Read only the named key. No environment dump or plaintext credential file.
    const script="$v=[Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY','User');if([String]::IsNullOrWhiteSpace($v)){$v=[Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY','Machine')};if($v){[Console]::Out.Write($v)}";
    const r=await command([ps,'-NoLogo','-NoProfile','-NonInteractive','-Command',script],{timeoutMs:10000});
    if(r.returncode===0&&r.stdout.trim()){process.env.TYPESAFE_API_KEY=r.stdout.trim();scrub.add(process.env.TYPESAFE_API_KEY);return 'windows_named_environment_variable';}
  }
  fail('TYPESAFE_API_KEY_MISSING',{solution:'Set the existing TypeSafe API key in your Windows User environment variables. No key should be pasted into this report.'});
}
export async function calibrate(root,tasks) {
  const results=[];
  for(const task of tasks){
    const base=path.join(root,'tasks',task.task_id),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'jar-smoke-cal-')),ws=path.join(tmp,'workspace');
    try{
      fs.cpSync(path.join(base,'workspace'),ws,{recursive:true});
      const v=path.join(base,'verifier/verify.mjs');
      const run=async()=>{const r=await command([process.execPath,v,ws],{cwd:tmp,timeoutMs:12000});return {...r,verdict:parseJson(r.stdout)};};
      const baseline=await run();fs.cpSync(path.join(base,'canonical'),ws,{recursive:true});const canonical=await run();
      const result={task:task.task_id,baselineFails:baseline.returncode===1&&baseline.verdict?.pass===false&&baseline.verdict?.kind==='functional',
        canonicalPasses:canonical.returncode===0&&canonical.verdict?.pass===true,baseline,canonical};
      results.push(result);
      if(!result.baselineFails||!result.canonicalPasses)fail('FIXTURE_CALIBRATION_FAILED',{result});
    }finally{fs.rmSync(tmp,{recursive:true,force:true});}
  }return results;
}
export function parseArgs(argv){
  const out={repo:null,one:null,preflightOnly:false,stepwise:false,model:null,name:null};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--repo'&&argv[i+1])out.repo=argv[++i];
    else if(argv[i]==='--one'&&argv[i+1]&&argv[i+2])out.one={task:argv[++i],condition:argv[++i]};
    else if(argv[i]==='--model'&&argv[i+1])out.model=argv[++i];
    else if(argv[i]==='--name'&&argv[i+1])out.name=argv[++i];
    else if(argv[i]==='--stepwise')out.stepwise=true;
    else if(argv[i]==='--preflight-only')out.preflightOnly=true;
    else fail('ARGUMENT_INVALID',{argument:argv[i]});
  }return out;
}
export async function main(argv=process.argv.slice(2),{root=ROOT}={}) {
  const args=parseArgs(argv),repo=locateRepo(root,args.repo),results=benchmarkResultsRoot(repo),identity=createRunIdentity({suite:'integrated-smoke',suiteLabel:'Integrated Smoke',task:args.one?.task,condition:args.one?.condition,name:args.name}),runDir=path.join(results,identity.runId);
  fs.mkdirSync(runDir,{recursive:true});const logfile=path.join(runDir,'run.log');fs.writeFileSync(logfile,'');
  const scrub=redactor();scrub.add(process.env.TYPESAFE_API_KEY);scrub.add(process.env.JAR_ACCESS_TOKEN);
  let cancelled=false,releaseBenchmark=null,config=null,waitingAbort=null;
  const s={schemaVersion:'jar.smoke-benchmark.result.v1',...identity,status:'STARTING',startedAt:identity.timestamp,executionMode:'automatic',targetConditions:10,
    runs:[],pairs:[],preflight:[],error:null,resultDirectory:runDir,validation:{windowsLiveRunPerformedByPackageAuthor:false}};
  const log=text=>{const line=`[${iso()}] ${scrub.text(text)}`;fs.appendFileSync(logfile,line+'\n');console.log(line);};
  const save=()=>publish(runDir,results,scrub.clean(s));
  const interrupt=()=>{cancelled=true;waitingAbort?.abort();log('Cancellation requested; finishing owned-process cleanup.');};
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  let heartbeat=null;
  try{
    releaseBenchmark=acquireLock(path.join(results,'benchmark.lock'));save();
    config=json(path.join(root,'config/diagnostic.json'));if(args.model)config.model=args.model;s.model=config.model;
    s.executionMode=args.one?'manual_single':args.preflightOnly?'preflight_only':args.stepwise?'manual_stepwise':'automatic';s.targetConditions=args.one?1:args.preflightOnly?0:10;
    const tasks=config.tasks;s.pairs=makePairs(tasks,[]);save();
    if(args.one&&(!tasks.some(t=>t.task_id===args.one.task)||!['CONTROL','JAR'].includes(args.one.condition)))fail('MANUAL_CONDITION_INVALID');
    if(Number(process.versions.node.split('.')[0])<20)fail('NODE_20_OR_NEWER_REQUIRED');
    s.benchmarkSourceHash=treeHash(root);log('Benchmark source loaded. No model has been started.');
    if(process.platform!=='win32')fail('WINDOWS_REQUIRED',{detected:process.platform});
    s.repo=repo;
    s.git={head:await command(['git','rev-parse','HEAD'],{cwd:repo}),status:await command(['git','status','--porcelain'],{cwd:repo})};
    const source=immutableSnapshot(repo);s.repoHash=source.hash;atomic(path.join(runDir,'repo-source-fingerprint.json'),source);
    log('Using local JAR: '+repo+' (local uncommitted fixes are preserved).');
    s.keySource=await hydrateKey(scrub);
    const d=await loadJar(repo);
    await checkLifecycleContract(d);log('Sandbox session classification contract verified without launching a VM.');
    s.fixtureCalibration=await calibrate(root,tasks);log('All 5 fixtures: broken baseline fails; canonical solution passes.');
    for(const t of tasks)verifyFixture(root,t.task_id,d);
    const access=await prepareModelAccess(d,{repo,root,config,runDir,repoHash:s.repoHash,scrub,log});
    config=access.config;s.model=config.model;s.effort=config.effort;s.modelSelection=access.selection;s.readiness=access.ready;save();
    await idleGate(d,()=>{});
    const prepTasks=args.one?tasks.filter(t=>t.task_id===args.one.task):tasks;
    for(const task of prepTasks){
      if(cancelled)fail('USER_INTERRUPTED');
      log('Live JEV preflight: '+task.task_id+' (no main-model turn).');
      const ready=await preflightFixture(d,{repo,root,task:task.task_id,dir:path.join(runDir,'preflight',task.task_id),scrub});
      s.preflight.push(ready);save();
    }
    // Optional offline M7 diagnostic. Its failure is visible but never masquerades as live output filtering.
    const m7=await command([process.execPath,path.join(root,'lib/output-shadow-eval.mjs'),
      path.join(root,'tasks/04-output-shadow/output-corpus.txt'),path.join(root,'tasks/04-output-shadow/output-ground-truth.json')],{cwd:root,timeoutMs:30000,scrub});
    s.m7={status:m7.returncode===0?'OFFLINE_SHADOW_ONLY':'OFFLINE_SHADOW_UNAVAILABLE',result:parseJson(m7.stdout),stderr:m7.stderr};
    if(args.preflightOnly){s.status='PREFLIGHT_PASSED_NO_MAIN_MODEL_RUNS';return 0;}
    const plan=args.one?[args.one]:schedule(tasks);s.status='RUNNING';save();
    let active='starting';heartbeat=setInterval(()=>{if(!active.startsWith('waiting'))log('Active phase: '+active);},15000);
    await executeConditions(plan,{
      cancelled:()=>cancelled,
      before:async item=>{
        if(args.stepwise){
          active='waiting for your Enter';
          if(!process.stdin.isTTY)fail('STEPWISE_REQUIRES_INTERACTIVE_TERMINAL');
          const rl=createInterface({input:process.stdin,output:process.stdout});waitingAbort=new AbortController();
          rl.on('SIGINT',interrupt);rl.on('close',()=>waitingAbort?.abort());
          try{const answer=await rl.question('\n['+(s.runs.length+1)+'/'+s.targetConditions+'] '+item.task+' / '+item.condition+' — ENTER to run, Q to stop: ',{signal:waitingAbort.signal});
            if(answer.trim().toLowerCase()==='q'){cancelled=true;fail('USER_INTERRUPTED');}}
          catch(e){if(waitingAbort?.signal.aborted){cancelled=true;fail('USER_INTERRUPTED');}throw e;}
          finally{waitingAbort=null;rl.close();}
          if(cancelled)fail('USER_INTERRUPTED');
        }
        if(immutableSnapshot(repo).hash!==s.repoHash)fail('REPO_CHANGED_DURING_BENCHMARK');
        if(treeHash(root)!==s.benchmarkSourceHash)fail('BENCHMARK_CHANGED_DURING_RUN');
        active=item.task+' / '+item.condition;log('START '+active);
      },
      run:async item=>{
        const dir=path.join(runDir,item.task,item.condition.toLowerCase());
        const row=await runCondition(d,{repo,root,task:item.task,condition:item.condition,dir,scrub,config,isCancelled:()=>cancelled,
          onStage:stage=>{active=item.task+' / '+item.condition+' / '+stage;log(active);}});
        row.evidencePath=path.relative(results,dir);return row;
      },
      onResult:async row=>{s.runs.push(row);s.pairs=makePairs(tasks,s.runs);log('RESULT '+row.task_id+' '+row.condition+' -> '+row.outcome);save();},
      after:async()=>{
        if(immutableSnapshot(repo).hash!==s.repoHash)fail('REPO_CHANGED_DURING_BENCHMARK');
        if(treeHash(root)!==s.benchmarkSourceHash)fail('BENCHMARK_CHANGED_DURING_RUN');
        if(s.pairs.some(p=>['PAIR_IDENTITY_MISMATCH','EFFORT_MISMATCH'].includes(p.functional)))fail('PAIR_IDENTITY_MISMATCH');
      }
    });
    s.status=args.one?'MANUAL_CONDITION_RECORDED':'COMPLETE';
    log(s.status+' — '+s.runs.length+'/'+s.targetConditions+' conditions; '+s.runs.filter(r=>r.outcome==='PASS').length+' functional PASS.');return 0;
  }catch(e){
    s.error=errorInfo(e,scrub);s.status=cancelled?'INTERRUPTED':s.runs.length?'STOPPED_INFRASTRUCTURE':'BLOCKED_BEFORE_MAIN_RUNS';
    log('STOP '+JSON.stringify(s.error));return cancelled?4:s.runs.length?3:2;
  }finally{
    if(heartbeat)clearInterval(heartbeat);s.finishedAt=iso();
    try{save();}catch(e){console.error('REPORT_WRITE_FAILED: '+scrub.text(e.message));}
    releaseBenchmark?.();process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
    console.log('\nReport: '+path.join(results,'LATEST/RESULT.html'));
    console.log('Full evidence: '+runDir);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(e);process.exitCode=2;});
}
