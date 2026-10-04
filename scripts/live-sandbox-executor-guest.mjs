import { readFile,writeFile,rename,readdir,mkdir,copyFile,rm,lstat,open } from 'node:fs/promises';
import { resolve,join,dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const mapped='C:/JAR',work='C:/JARWork',workspace=join(work,'workspace'),requests=join(mapped,'bridge/requests'),responses=join(mapped,'bridge/responses');
const hash=value=>createHash('sha256').update(Buffer.isBuffer(value)||typeof value==='string'?value:stable(value)).digest('hex');
const stable=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(stable).join(',')}]`:
  `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
const fail=code=>Object.assign(Error(code),{code});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const safePath=value=>{if(typeof value!=='string'||!value||value.length>240||value.includes('\\')||value.includes(':')
  ||value.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')||!/^[-a-zA-Z0-9_.]+$/.test(p)))throw fail('WORKSPACE_PATH_REJECTED');return value;};
const inside=(root,name)=>{safePath(name);const path=resolve(root,name);if(!path.startsWith(resolve(root)+'\\'))throw fail('WORKSPACE_PATH_REJECTED');return path;};
const inspectionKinds={git_inspect:'git',dependency_graph:'dependency',package_metadata:'package',schema_inspect:'schema',migration_inspect:'migration',coverage_read:'coverage',test_history:'test-history',benchmark_metadata:'benchmark',localization_inspect:'localization',asset_inspect:'asset',frontend_snapshot:'snapshot',release_metadata:'release',configuration_inspect:'config',api_contract_inspect:'api',test_inventory:'test',source_outline:'source'};
const inspectionPaths=(kind)=>plan.manifest.include.filter(path=>{const x=path.toLowerCase(),rules={git:/git|changelog/,dependency:/package|lock|import|depend/,package:/package\.json$/,schema:/schema|contract|receipt/,migration:/migration/,coverage:/coverage/,['test-history']:/history/,benchmark:/benchmark|ground-truth/,localization:/locale|i18n|translation/,asset:/asset/,snapshot:/snapshot|frontend/,release:/release|changelog/,config:/config|settings|defaults/,api:/api|contract|exports?|receipt/,test:/test|spec/,source:/^src\//};return rules[kind]?.test(x)??false;}).slice(0,100);
const boundedJson=async path=>{const bytes=await readFile(path);if(bytes.length>65536)throw fail('RPC_PAYLOAD_OVERSIZED');try{return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{throw fail('RPC_JSON_MALFORMED');}};
async function atomic(directory,name,value){const text=JSON.stringify(value)+'\n';if(Buffer.byteLength(text)>65536)throw fail('RPC_RESPONSE_OVERSIZED');
  const temp=join(directory,`.${name}.tmp`);await writeFile(temp,text,{flag:'wx'});await rename(temp,join(directory,name));}
async function treeCopy(from,to){await mkdir(to,{recursive:true});for(const e of await readdir(from,{withFileTypes:true})){
  if(e.isSymbolicLink())throw fail('WORKSPACE_LINK_REJECTED');const a=join(from,e.name),b=join(to,e.name);e.isDirectory()?await treeCopy(a,b):await copyFile(a,b);}}
const plan=await boundedJson(join(mapped,'input/plan.json'));
if(plan.schemaVersion!=='jar.sandbox-executor-plan.v1'||plan.runId.length!==64||!Array.isArray(plan.tools))throw fail('EXECUTOR_PLAN_INVALID');
await treeCopy(join(mapped,'input/workspace'),workspace);await mkdir(requests,{recursive:true});await mkdir(responses,{recursive:true});
await atomic(join(mapped,'bridge'),'ready.json',{schemaVersion:'jar.sandbox-executor-ready.v1',runId:plan.runId,toolExecutionNetwork:'disabled_by_windows_sandbox'});
let expected=1;const seen=new Set();
async function execute(request){
  const started=Date.now(),row=plan.tools.find(t=>t.capabilityId===request.capabilityId&&t.toolName===request.toolName);
  if(!row)throw fail('UNKNOWN_CAPABILITY');const args=request.arguments;
  if(!args||typeof args!=='object'||Array.isArray(args))throw fail('TOOL_ARGUMENTS_INVALID');
  if(request.toolName==='workspace_list'){if(!exact(args,[]))throw fail('TOOL_ARGUMENTS_INVALID');return {paths:[...plan.manifest.include],truncated:false};}
  if(request.toolName==='workspace_read'){if(!exact(args,['path'])||!plan.manifest.include.includes(safePath(args.path)))throw fail('UNREVIEWED_FILE');const bytes=await readFile(inside(workspace,args.path));if(bytes.length>plan.manifest.limits.maxFileBytes||bytes.includes(0))throw fail('WORKSPACE_SIZE_LIMIT');const text=bytes.toString('utf8');return {path:args.path,text:text.slice(0,12000),truncated:text.length>12000,hash:hash(text)};}
  if(request.toolName==='workspace_search'){if(!exact(args,['query'])||typeof args.query!=='string'||!args.query||args.query.length>128)throw fail('SEARCH_LIMIT');const matches=[];
    for(const path of plan.manifest.include){const lines=(await readFile(inside(workspace,path),'utf8')).split(/\r?\n/),found=[];for(let i=0;i<lines.length&&found.length<5;i++)if(lines[i].includes(args.query))found.push({line:i+1,text:lines[i].slice(0,160)});if(found.length)matches.push({path,matches:found});if(matches.length===10)break;}return {matches,truncated:false};}
  if(request.toolName==='workspace_write'){if(!exact(args,['path','content'])||!plan.manifest.include.includes(safePath(args.path)))throw fail('UNREVIEWED_FILE');if(plan.manifest.immutable.includes(args.path))throw fail('IMMUTABLE_FILE');
    if(typeof args.content!=='string'||args.content.includes('\0')||Buffer.byteLength(args.content)>plan.manifest.limits.maxFileBytes)throw fail('WRITE_LIMIT');
    let total=0;for(const path of plan.manifest.include)total+=(await lstat(inside(workspace,path))).size;if(total-(await lstat(inside(workspace,args.path))).size+Buffer.byteLength(args.content)>plan.manifest.limits.maxTotalBytes)throw fail('WRITE_LIMIT');
    await writeFile(inside(workspace,args.path),args.content);return {path:args.path,hash:hash(args.content)};}
  if(request.toolName==='workspace_run'){if(!exact(args,['commandId']))throw fail('TOOL_ARGUMENTS_INVALID');const command=plan.manifest.commands[args.commandId];if(!command)throw fail('UNKNOWN_COMMAND');
    const entry=inside(workspace,command.argv[1]);if(hash(await readFile(entry))!==plan.immutableHashes[command.argv[1]])throw fail('COMMAND_CHANGED');
    const child=spawn(process.execPath,[entry],{cwd:workspace,shell:false,windowsHide:true,env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:join(work,'tmp'),TMP:join(work,'tmp')},stdio:['ignore','pipe','pipe']});
    let out=Buffer.alloc(0),err=Buffer.alloc(0),truncated=false;for(const [stream,key] of [[child.stdout,'out'],[child.stderr,'err']])stream.on('data',chunk=>{const old=key==='out'?out:err,left=command.maxOutputBytes-old.length;if(chunk.length>left)truncated=true;const next=Buffer.concat([old,Buffer.from(chunk).subarray(0,Math.max(0,left))]);if(key==='out')out=next;else err=next;});
    const closed=new Promise(resolve=>{child.once('error',()=>resolve(127));child.once('close',c=>resolve(c??127));});let timer;let exitCode=await Promise.race([closed,new Promise(r=>timer=setTimeout(()=>r(null),command.timeoutMs))]);clearTimeout(timer);
    let timedOut=false;if(exitCode===null){timedOut=true;spawn('C:/Windows/System32/taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});exitCode=await closed;}
    return {exitCode,timedOut,settled:true,truncated,stdoutBytes:out.length,stderrBytes:err.length,stdoutHash:hash(out),stderrHash:hash(err),durationMs:Date.now()-started};}
  if(Object.hasOwn(inspectionKinds,request.toolName)){if(!exact(args,[]))throw fail('TOOL_ARGUMENTS_INVALID');const kind=inspectionKinds[request.toolName],paths=inspectionPaths(kind);return {kind,paths,truncated:paths.length===100,summary:`${paths.length} reviewed ${kind} path(s)`};}
  throw fail('UNKNOWN_TOOL');
}
while(true){
  try{const stop=await boundedJson(join(mapped,'bridge/stop.json'));if(stop.runId===plan.runId&&stop.stopHash===hash({schemaVersion:'jar.sandbox-executor-stop.v1',runId:plan.runId}))break;}catch{}
  for(const name of (await readdir(requests)).filter(n=>/^\d{8}\.json$/.test(n)).sort()){
    if(seen.has(name))continue;let request;try{request=await boundedJson(join(requests,name));const {requestHash,...body}=request;
      if(!exact(request,['schemaVersion','runId','sequence','toolCallId','capabilityId','toolName','arguments','requestHash'])
        ||request.schemaVersion!=='jar.sandbox-tool-request.v1'||request.runId!==plan.runId||request.sequence!==expected||requestHash!==hash(body))throw fail('RPC_REQUEST_REJECTED');
      const result=await execute(request),responseBody={schemaVersion:'jar.sandbox-tool-response.v1',runId:request.runId,sequence:request.sequence,toolCallId:request.toolCallId,requestHash,status:'success',result,errorCode:null,timing:{durationMs:0}};
      await atomic(responses,name,{...responseBody,responseHash:hash(responseBody)});
    }catch(error){if(request){const responseBody={schemaVersion:'jar.sandbox-tool-response.v1',runId:request.runId,sequence:request.sequence,toolCallId:request.toolCallId,requestHash:request.requestHash,status:'error',result:null,errorCode:/^[A-Z_]+$/.test(error.code??'')?error.code:'TOOL_FAILED',timing:{durationMs:0}};await atomic(responses,name,{...responseBody,responseHash:hash(responseBody)});}}
    seen.add(name);expected++;
  }
  await new Promise(r=>setTimeout(r,50));
}
await treeCopy(workspace,join(mapped,'output/workspace'));await rm(work,{recursive:true,force:true});
await atomic(join(mapped,'output'),'disposal.json',{schemaVersion:'jar.sandbox-executor-disposal.v1',runId:plan.runId,workspaceExported:true,guestStateGone:!await lstat(work).then(()=>true,()=>false),ownedProcessesRemaining:0,bridgeSettled:true,toolExecutionNetwork:'disabled_by_windows_sandbox'});
spawn('C:/Windows/System32/shutdown.exe',['/s','/t','30','/f'],{stdio:'ignore',windowsHide:true});
