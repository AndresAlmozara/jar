import path from 'node:path';
import {fileURLToPath} from 'node:url';

const benchmarkRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export const DEFAULT_BENCHMARK_ID='opsdesk-hard-v2.4';
export const BENCHMARKS=Object.freeze({
  'opsdesk-hard-v2.4':Object.freeze({
    benchmarkId:'opsdesk-hard-v2.4',
    title:'OpsDesk Hard',
    role:'CANONICAL_DEVELOPMENT',
    protocolVersion:'jar.canonical-product-benchmark.v2.4',
    canonical:true,
    developmentEval:true,
    historicalReplication:false,
    definitionRoot:benchmarkRoot,
    resultRoot:'.jar/benchmarks/canonical',
    entrypoint:'evals/benchmark/run.mjs',
    baselineAcceptancePolicy:'CORRECT_PRODUCT'
  }),
  'opsdesk-soft-v1':Object.freeze({
    benchmarkId:'opsdesk-soft-v1',
    title:'OpsDesk Soft',
    role:'LEGACY_DIAGNOSTIC',
    protocolVersion:'jar.opsdesk-v1-replication.v1',
    canonical:false,
    developmentEval:false,
    historicalReplication:true,
    definitionRoot:path.join(benchmarkRoot,'scenarios','opsdesk-v1-replication'),
    resultRoot:'.jar/benchmarks/replication/opsdesk-v1',
    entrypoint:'evals/benchmark/scenario-run.mjs',
    baselineAcceptancePolicy:'DIAGNOSTIC_REFERENCE'
  })
});

const ALIASES=Object.freeze({'opsdesk-v2.4':'opsdesk-hard-v2.4','opsdesk-v1-replication':'opsdesk-soft-v1'});

export function benchmarkById(id=DEFAULT_BENCHMARK_ID){
  const benchmark=BENCHMARKS[ALIASES[id]??id];
  if(!benchmark)throw Object.assign(Error('BENCHMARK_UNKNOWN'),{code:'BENCHMARK_UNKNOWN',benchmarkId:id});
  return benchmark;
}
