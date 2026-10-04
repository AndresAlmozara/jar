import path from 'node:path';import {fileURLToPath} from 'node:url';import {purgeLegacyGeneratedResults} from '../lib/purge.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const result=purgeLegacyGeneratedResults(repo);
console.log(JSON.stringify({status:'PURGED_GENERATED_HISTORY',removed:result.removed.map(file=>path.relative(repo,file).replaceAll('\\','/')),preserved:result.preserved.map(file=>path.relative(repo,file).replaceAll('\\','/'))},null,2));
