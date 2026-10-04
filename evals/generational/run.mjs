import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadFrozenSpec,datasetSummary,REPO_ROOT} from './lib/spec.mjs';
import {validateExecutableGold} from './lib/oracles.mjs';
import {gradeObservation} from './lib/metrics.mjs';
import {loadGeneration} from './lib/generation-adapter.mjs';
import {evaluateGeneration} from './lib/execute.mjs';

const isEntrypoint=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
const fail=(code,details={})=>Object.assign(Error(code),{code,details});

export function parseArgs(argv){
  const args={mode:null,generation:'all',splits:null,output:null};for(let index=0;index<argv.length;index++){const item=argv[index];if(['--identity','--self-test','--live'].includes(item)){if(args.mode)throw fail('GENERATIONAL_MODE_CONFLICT');args.mode=item.slice(2);}else if(item==='--generation')args.generation=argv[++index];else if(item==='--split'){const value=argv[++index];args.splits=value==='all'?null:value.split(',');}else if(item==='--output')args.output=argv[++index];else throw fail('GENERATIONAL_ARGUMENT_INVALID',{argument:item});}
  if(!args.mode)throw fail('GENERATIONAL_MODE_REQUIRED');if(!['all','h0','allIn','v2'].includes(args.generation))throw fail('GENERATIONAL_GENERATION_INVALID');if(args.mode==='live'&&!args.output)throw fail('GENERATIONAL_OUTPUT_REQUIRED');return args;
}

function selfTestGrades(spec){
  const byId=new Map(spec.fixtures.rows.map(row=>[row.id,row])),gold=new Map(spec.gold.labels.map(row=>[row.id,row])),checks=[];
  const check=(id,good,bad)=>{checks.push({id:`${id}:known-good`,status:gradeObservation({id,...good},byId.get(id),gold.get(id)).status});checks.push({id:`${id}:known-bad`,status:gradeObservation({id,...bad},byId.get(id),gold.get(id)).status});};
  check('m5-primary-with-support',{module:'M5',primarySkill:'database-migrations',supportingSkills:['testing'],explicitSkills:[],abstained:false,candidateSkills:['database-migrations','testing']},{module:'M5',primarySkill:'documentation',supportingSkills:['security-review'],explicitSkills:[],abstained:false,candidateSkills:['documentation']});
  check('m6-behavior-paraphrase',{module:'M6',candidatePaths:['src/retry.js'],selectedPaths:['src/retry.js'],materializedPaths:['src/retry.js'],maximumSemanticDuplicates:0},{module:'M6',candidatePaths:['docs/marketing.md'],selectedPaths:[],materializedPaths:[],maximumSemanticDuplicates:0});
  check('m7-byte-exact',{module:'M7',properties:['BYTE_EXACT','ORDER_PRESERVED','NO_CAUSAL_MUTATION']},{module:'M7',properties:['ORDER_PRESERVED']});
  check('m8-alternative-sets',{module:'M8',exposedCapabilityIds:['patch'],semanticObligations:['workspace.modify'],policyViolations:[],prerequisiteViolations:[],scopeErrors:[]},{module:'M8',exposedCapabilityIds:['read'],semanticObligations:['workspace.modify'],policyViolations:[],prerequisiteViolations:[],scopeErrors:[]});
  if(checks.some(item=>item.id.endsWith('known-good')?item.status!=='PASS':item.status!=='FAIL'))throw fail('GENERATIONAL_TOY_DISCRIMINATION_FAILED',{checks});return checks;
}

export async function runSelfTest(spec){
  const goldById=new Map(spec.gold.labels.map(label=>[label.id,label])),oracleChecks=spec.fixtures.rows.filter(row=>row.module==='M8').map(row=>({id:row.id,...validateExecutableGold(row,goldById.get(row.id))}));
  if(oracleChecks.some(check=>!check.valid))throw fail('GENERATIONAL_ORACLE_GOLD_INVALID',{oracleChecks});
  const adapters=[];for(const generation of ['h0','allIn','v2']){const loaded=await loadGeneration(REPO_ROOT,generation);try{adapters.push({generation,commit:loaded.profile.commit,modules:['skills','context','output','capabilities','jev'].every(name=>Boolean(loaded.modules[name]))});}finally{loaded.cleanup();}}
  if(adapters.some(item=>!item.modules))throw fail('GENERATIONAL_ADAPTER_IMPORT_FAILED',{adapters});return{status:'PASS',schema:true,oracleChecks,toyChecks:selfTestGrades(spec),adapters};
}

function safeOutput(file){const absolute=path.resolve(REPO_ROOT,file),root=path.resolve(REPO_ROOT,'.jar','evaluation','jar-v2');if(!(absolute===root||absolute.startsWith(root+path.sep)))throw fail('GENERATIONAL_OUTPUT_PATH_REJECTED',{file});return absolute;}
export async function main(argv=process.argv.slice(2)){
  const args=parseArgs(argv),spec=loadFrozenSpec({verifyFreeze:true});if(args.mode==='identity'){console.log(JSON.stringify({status:'GENERATIONAL_EVAL_SPEC_FROZEN',identity:spec.identity,summary:datasetSummary(spec)},null,2));return 0;}
  if(args.mode==='self-test'){console.log(JSON.stringify(await runSelfTest(spec),null,2));return 0;}
  const generations=args.generation==='all'?['h0','allIn','v2']:[args.generation],results=[];for(const generation of generations){const evaluated=await evaluateGeneration({repo:REPO_ROOT,spec,generation,live:true,splits:args.splits});results.push(evaluated);const accounting=results.reduce((sum,item)=>({httpAttempts:sum.httpAttempts+item.accounting.httpAttempts,inputTokens:sum.inputTokens+item.accounting.inputTokens}),{httpAttempts:0,inputTokens:0});if(accounting.httpAttempts>spec.manifest.liveBudget.maximumHttpAttempts||accounting.inputTokens>spec.manifest.liveBudget.maximumInputTokens)throw fail('GENERATIONAL_LIVE_BUDGET_EXCEEDED',{accounting});if(evaluated.rows.some(row=>row.grade.status==='INFRA_FAILURE'))break;}
  const report={schemaVersion:'jar.generational-mechanism-results.v1',specIdentity:spec.identity,generatedAt:new Date().toISOString(),mainModelTurns:0,results};const output=safeOutput(args.output);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:'GENERATIONAL_EVALUATION_COMPLETE',output:path.relative(REPO_ROOT,output).replaceAll('\\','/'),generations:results.map(item=>item.generation)},null,2));return results.some(item=>item.rows.some(row=>row.grade.status==='INFRA_FAILURE'))?2:0;
}

if(isEntrypoint)main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(JSON.stringify({status:'ERROR',code:error.code??'UNEXPECTED',details:error.details??null,message:error.message},null,2));process.exitCode=2;});
