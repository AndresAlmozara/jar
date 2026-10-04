import { open } from 'node:fs/promises';
import { sha256, stableStringify } from '../../../core/src/hash.js';
import { capabilityDescriptor, capabilityInventory } from '../../../capability-exposure/src/contracts.js';
import { exposureRequest } from '../../src/contracts.js';
import { ownedState, reviewedPath, checkedFile, readBounded, workspaceSnapshot, workspaceError } from './owned-workspace.js';

const definitions=[
  ['workspace_list','List reviewed files in the owned workspace.','low',{},[]],
  ['workspace_search','Search literal text in reviewed owned source files.','low',{query:{type:'string',minLength:1,maxLength:128}},['query']],
  ['workspace_read','Read a reviewed owned source file.','low',{path:{type:'string'}},['path']],
  ['workspace_write','Write a mutable reviewed owned source file.','medium',{path:{type:'string'},content:{type:'string'}},['path','content']],
  ['workspace_run','Run a reviewed immutable verification command by ID, never a shell string.','medium',{commandId:{type:'string'}},['commandId']],
];
const smokeInspectionDefinitions=[
  ['git_inspect','Inspect reviewed version-control metadata files; never invoke git.','low','git'],
  ['dependency_graph','Inspect imports and dependency declarations in reviewed files.','low','dependency'],
  ['package_metadata','Inspect reviewed package metadata.','low','package'],
  ['schema_inspect','Inspect reviewed schema and contract files.','low','schema'],
  ['migration_inspect','Inspect reviewed migration files.','low','migration'],
  ['coverage_read','Inspect reviewed coverage summary files.','low','coverage'],
  ['test_history','Inspect reviewed test-history records.','low','test-history'],
  ['benchmark_metadata','Inspect reviewed benchmark metadata.','low','benchmark'],
  ['localization_inspect','Inspect reviewed localization resources.','low','localization'],
  ['asset_inspect','Inspect reviewed asset manifests.','low','asset'],
  ['frontend_snapshot','Inspect reviewed frontend snapshot files.','low','snapshot'],
  ['release_metadata','Inspect reviewed release metadata.','low','release'],
  ['configuration_inspect','Inspect reviewed configuration files.','low','config'],
  ['api_contract_inspect','Inspect reviewed public API contracts and exports.','low','api'],
  ['test_inventory','List reviewed tests and immutable test entrypoints.','low','test'],
  ['source_outline','List reviewed source modules without reading their contents.','low','source'],
];
const allDefinitions=manifest=>manifest.capabilityProfile==='smoke-expanded'
  ?[...definitions,...smokeInspectionDefinitions.map(([name,description,risk])=>[name,description,risk,{},[]])]:definitions;
const coverageByName={
  workspace_list:['workspace.discovery','repository.structure'], workspace_search:['workspace.discovery','workspace.search'],
  workspace_read:['workspace.read'], workspace_write:['workspace.write'], workspace_run:['workspace.execute','verification.tests'],
  git_inspect:['version_control.inspect'], dependency_graph:['repository.dependencies','repository.structure'],
  package_metadata:['repository.dependencies'], schema_inspect:['repository.schema','repository.api'],
  migration_inspect:['lifecycle.migration','repository.schema'], coverage_read:['verification.coverage'],
  test_history:['verification.tests'], benchmark_metadata:['verification.benchmark'], localization_inspect:['assets.inspect'],
  asset_inspect:['assets.inspect'], frontend_snapshot:['frontend.inspect'], release_metadata:['lifecycle.release'],
  configuration_inspect:['repository.configuration'], api_contract_inspect:['repository.api','repository.schema'],
  test_inventory:['verification.tests','repository.structure'], source_outline:['repository.structure','workspace.discovery']
};
const inspectionKind=name=>smokeInspectionDefinitions.find(row=>row[0]===name)?.[3]??null;
const matchingPaths=(paths,kind)=>paths.filter(p=>{
  const x=p.toLowerCase();
  const rules={git:/git|changelog/,dependency:/package|lock|import|depend/,package:/package\.json$/,schema:/schema|contract|receipt/,migration:/migration/,coverage:/coverage/,['test-history']:/history/,benchmark:/benchmark|ground-truth/,localization:/locale|i18n|translation/,asset:/asset/,snapshot:/snapshot|frontend/,release:/release|changelog/,config:/config|settings|defaults/,api:/api|contract|exports?|receipt/,test:/test|spec/,source:/^src\//};
  return rules[kind]?.test(x)??false;
});
export function ownedToolMapping(handle){
  const s=ownedState(handle);
  return allDefinitions(s.manifest).filter(([name])=>name!=='workspace_run'||Object.keys(s.manifest.commands).length).map(([name,description,risk,properties,required])=>{
    const inputSchema={type:'object',properties:{...properties},required,additionalProperties:false};
    if(name==='workspace_run')inputSchema.properties.commandId={type:'string',enum:Object.keys(s.manifest.commands).sort()};
    const schemaChars=JSON.stringify({name,description,inputSchema}).length;
    const capability=capabilityDescriptor({kind:'tool',name,description,risk,source:{namespace:'codex:owned-workspace:v1',nativeId:name},
      requiredPermissions:['owned-workspace'],coverageAtoms:coverageByName[name]??[],schemaChars});
    return {capability,native:{type:'function',name,description,inputSchema,deferLoading:false}};
  });
}
export function ownedToolInventory(handle,runtime){return capabilityInventory({runtime,source:'reviewed-owned-workspace',state:'known',
  entries:ownedToolMapping(handle).map(({capability})=>({capability,available:true,supported:true,enabled:true,permission:'allowed',requirementsSatisfied:true}))});}

export function createOwnedToolExecutor(handle,{input,proposal,request,runCommand=null,telemetry=null,clock=()=>performance.now()}){
  if(stableStringify(exposureRequest({input,proposal}))!==stableStringify(request)||!Array.isArray(request.exposedIds))throw workspaceError('TOOL_POLICY_BINDING_FAILED');
  const mapping=ownedToolMapping(handle),available=mapping.map(x=>x.capability.id).sort();
  if(stableStringify(input.inventory.entries.map(e=>e.capability.id).sort())!==stableStringify(available)
    ||request.exposedIds.some(id=>!available.includes(id)))throw workspaceError('TOOL_MAPPING_FAILED');
  const s=ownedState(handle),events=[],used=new Set(),started=clock();let busy=false;
  const emit=event=>{events.push(event);try{telemetry?.append(event);}catch{/* Recording cannot strand owned state. */}};
  return {mapping:mapping.filter(m=>request.exposedIds.includes(m.capability.id)),events,usedIds:()=>[...used].sort(),
    async execute(name,args={}){
      if(busy)throw workspaceError('TOOL_BUSY');busy=true;let row,success=false,code='OK',value=null,edit=null;
      const atMs=clock()-started;
      try{
        ownedState(handle);row=mapping.find(m=>m.native.name===name);
        if(!row||!request.exposedIds.includes(row.capability.id))throw workspaceError('TOOL_NOT_EXPOSED');
        const schema=row.native.inputSchema;
        if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(schema.properties,k))
          ||schema.required.some(k=>typeof args[k]!=='string'))throw workspaceError('TOOL_ARGUMENTS_INVALID');
        used.add(row.capability.id);
        if(name==='workspace_list'){
          const files=await workspaceSnapshot(handle),paths=files.map(f=>f.path).filter(p=>p.split('/').length<=8).slice(0,100);
          value={paths,truncated:paths.length!==files.length};
        }else if(name==='workspace_search'){
          if(!args.query||args.query.length>128)throw workspaceError('SEARCH_LIMIT');
          const matches=[];let truncated=false;
          for(const path of s.manifest.include){const {text}=await readBounded(s.workspaceRoot,path,s.manifest.limits.maxFileBytes);
            const lines=text.split(/\r?\n/),found=[];
            for(let i=0;i<lines.length;i++)if(lines[i].includes(args.query)){if(found.length===5){truncated=true;break;}found.push({line:i+1,text:lines[i].slice(0,160)});}
            if(found.length){if(matches.length===10){truncated=true;break;}matches.push({path,matches:found});}}
          value={matches,truncated};
        }else if(name==='workspace_read'||name==='workspace_write'){
          reviewedPath(args.path);if(!s.manifest.include.includes(args.path))throw workspaceError('UNREVIEWED_FILE');
          const before=await readBounded(s.workspaceRoot,args.path,s.manifest.limits.maxFileBytes);
          if(name==='workspace_read')value={path:args.path,text:before.text.slice(0,12000),truncated:before.text.length>12000,hash:before.hash};
          else{
            if(s.manifest.immutable.includes(args.path))throw workspaceError('IMMUTABLE_FILE');
            if(args.content.includes('\0')||Buffer.byteLength(args.content)>s.manifest.limits.maxFileBytes)throw workspaceError('WRITE_LIMIT');
            const files=await workspaceSnapshot(handle);
            if(files.reduce((n,f)=>n+f.bytes,0)-before.bytes+Buffer.byteLength(args.content)>s.manifest.limits.maxTotalBytes)throw workspaceError('WRITE_LIMIT');
            const target=await checkedFile(s.workspaceRoot,args.path),file=await open(target,'r+');
            try{await file.truncate(0);await file.writeFile(args.content);}finally{await file.close();}
            const after=await readBounded(s.workspaceRoot,args.path,s.manifest.limits.maxFileBytes);
            edit={path:args.path,beforeHash:before.hash,afterHash:after.hash,atMs:clock()-started};value={path:args.path,hash:after.hash};
          }
        }else if(name==='workspace_run'){
          const command=Object.hasOwn(s.manifest.commands,args.commandId)?s.manifest.commands[args.commandId]:null;
          if(!command)throw workspaceError('UNKNOWN_COMMAND');if(typeof runCommand!=='function')throw workspaceError('ISOLATED_COMMAND_RUNNER_REQUIRED');
          const file=await readBounded(s.workspaceRoot,command.argv[1],s.manifest.limits.maxFileBytes);
          if(file.hash!==handle.files.find(f=>f.path===command.argv[1]).hash)throw workspaceError('COMMAND_CHANGED');
          s.active++;
          value=await runCommand({...command,argv:[...command.argv]},s.workspaceRoot);
          if(value?.settled!==true)throw workspaceError('COMMAND_DISPOSAL_UNVERIFIED');
          s.active--;
          if(value.exitCode!==0||value.timedOut)throw workspaceError(value.timedOut?'COMMAND_TIMEOUT':'COMMAND_FAILED');
        }else{
          const kind=inspectionKind(name);if(!kind)throw workspaceError('UNKNOWN_TOOL');
          const paths=matchingPaths(s.manifest.include,kind).slice(0,100);
          value={kind,paths,truncated:paths.length===100,summary:`${paths.length} reviewed ${kind} path(s)`};
        }
        if(Buffer.byteLength(JSON.stringify(value))>16384)throw workspaceError('TOOL_OUTPUT_LIMIT');success=true;
      }catch(error){code=/^[A-Z_]+$/.test(error.code??'')?error.code:'TOOL_FAILED';value=null;}
      finally{busy=false;emit({event_type:'owned_tool_result',task_id:input.task.id,run_id:handle.id,capability_id:row?.capability.id??null,
        tool:allDefinitions(s.manifest).some(d=>d[0]===name)?name:'unknown',success,code,atMs,durationMs:clock()-started-atMs,...(edit?{edit}:{})});}
      return {success,code,value};
    }};
}
