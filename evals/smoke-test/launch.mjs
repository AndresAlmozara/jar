// Minimal bootstrap: still emits a report if a dependency fails before run.mjs starts.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
try {
  const {main}=await import('./run.mjs');
  process.exitCode=await main(process.argv.slice(2),{root});
} catch (error) {
  const stamp=new Date().toISOString(),repo=path.resolve(root,'../..'),latest=path.join(repo,'.jar/benchmarks/smoke-test/LATEST');
  const result={schemaVersion:'jar.smoke-benchmark.bootstrap.v1',status:'BOOTSTRAP_FAILED',startedAt:stamp,
    error:{code:error?.code??error?.name??'BOOTSTRAP_FAILED',message:String(error?.message??error)},runs:[],mainModelTurns:0};
  try {
    fs.rmSync(latest,{recursive:true,force:true});fs.mkdirSync(latest,{recursive:true});
    fs.writeFileSync(path.join(latest,'SUMMARY.json'),JSON.stringify(result,null,2)+'\n');
    fs.writeFileSync(path.join(latest,'run.log'),'['+stamp+'] BOOTSTRAP_FAILED — no model started.\n');
    const safe=JSON.stringify(result,null,2).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    fs.writeFileSync(path.join(latest,'RESULT.html'),'<!doctype html><meta charset="utf-8"><h1>JAR Integrated Smoke Benchmark</h1><pre>'+safe+'</pre>');
  } catch {}
  console.error('BOOTSTRAP_FAILED. No model was started. '+result.error.code);
  process.exitCode=2;
}
