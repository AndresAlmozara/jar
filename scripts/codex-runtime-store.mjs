import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {admitOwnedRuntime,discoverRuntimeIdentity,pinOwnedRuntime,resolvePinnedOwnedRuntime} from '../packages/runtime-adapters/codex/src/owned-runtime-store.js';
import {discoverCodexRuntimeCandidates} from '../packages/runtime-adapters/codex/src/runtime-locator.js';

const repo=fileURLToPath(new URL('..',import.meta.url));
function value(name){const index=process.argv.indexOf(name);if(index<0||!process.argv[index+1])throw Error(`ARGUMENT_REQUIRED:${name}`);return process.argv[index+1];}
const command=process.argv[2];
if(command==='discover')console.log(JSON.stringify(await discoverCodexRuntimeCandidates(),null,2));
else if(command==='admit'){
  const source=value('--source'),proof=value('--proof'),tests=['tests/runtime-locator.test.js','tests/owned-runtime-store.test.js','tests/live-v1.test.js'];
  const run=spawnSync(process.execPath,['--test',...tests],{cwd:repo,stdio:'inherit',windowsHide:true});if(run.status!==0)throw Error('RUNTIME_CONTRACT_TESTS_FAILED');
  const result=await admitOwnedRuntime({repo,sourcePath:source,proofPath:proof,contractTests:{status:'PASS',tests,completedAt:new Date().toISOString()}});console.log(JSON.stringify(result,null,2));
}else if(command==='pin')console.log(JSON.stringify(await pinOwnedRuntime({repo,version:value('--version'),sha256:value('--sha256')}),null,2));
else if(command==='status')console.log(JSON.stringify(await resolvePinnedOwnedRuntime(repo),null,2));
else if(command==='identify')console.log(JSON.stringify(await discoverRuntimeIdentity(value('--source')),null,2));
else throw Error('USAGE: codex-runtime-store.mjs discover|identify --source PATH|admit --source PATH --proof PATH|pin --version VERSION --sha256 SHA256|status');
