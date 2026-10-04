import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const fail=(code,details={})=>Object.assign(Error(code),{code,details});
function run(file,args,options={}){const result=spawnSync(file,args,{encoding:null,maxBuffer:128*1024*1024,...options});if(result.error||result.status!==0)throw fail('GENERATION_MATERIALIZATION_COMMAND_FAILED',{file,args,status:result.status,stderr:result.stderr?.toString('utf8').slice(-4000),cause:result.error?.message});return result;}
function gitText(repo,args){return run('git',['-C',repo,...args],{encoding:'utf8'}).stdout.trim();}

export function verifyGenerationRef(repo,commit){
  if(!/^[a-f0-9]{40}$/.test(commit))throw fail('GENERATION_COMMIT_INVALID',{commit});
  const resolved=gitText(repo,['rev-parse',`${commit}^{commit}`]);if(resolved!==commit)throw fail('GENERATION_COMMIT_MISMATCH',{commit,resolved});return resolved;
}

export function materializeGeneration(repo,profile){
  verifyGenerationRef(repo,profile.commit);
  if(profile.id==='v2'&&gitText(repo,['rev-parse','HEAD'])===profile.commit)return{root:repo,commit:profile.commit,temporary:false,cleanup(){}};
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),`jar-generation-${profile.id}-`)),root=path.join(parent,'source'),archive=path.join(parent,'source.tar');fs.mkdirSync(root);
  const archived=run('git',['-C',repo,'archive','--format=tar',profile.commit]);fs.writeFileSync(archive,archived.stdout,{flag:'wx'});run('tar',['-xf',archive,'-C',root]);fs.rmSync(archive,{force:true});
  const packageFile=path.join(root,'package.json');if(!fs.existsSync(packageFile)||JSON.parse(fs.readFileSync(packageFile,'utf8')).name!=='jev-agentic-router'){fs.rmSync(parent,{recursive:true,force:true});throw fail('GENERATION_ARCHIVE_INVALID',{commit:profile.commit});}
  return{root,commit:profile.commit,temporary:true,cleanup(){fs.rmSync(parent,{recursive:true,force:true});}};
}
