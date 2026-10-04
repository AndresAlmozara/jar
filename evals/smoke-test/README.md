# JAR integration smoke benchmark

This directory contains the tracked definition of JAR's paired integration
smoke. It is not the primary product-effectiveness benchmark; that role belongs
to `evals/benchmark/` and its frozen-CONTROL protocol. `run.mjs` remains the canonical smoke orchestrator: it
calibrates every fixture, checks runtime and condition contracts, runs the
counterbalanced pairs, stops on infrastructure failure, and publishes evidence.

Run the deliberate live batch from the repository root with:

```powershell
npm run eval:smoke
```

Useful bounded modes are:

```powershell
npm run eval:smoke:preflight
node evals/smoke-test/run.mjs --one 03-capability-exposure JAR
node evals/smoke-test/run.mjs --stepwise
```

The tracked benchmark source stays in this directory. Generated reports and
runtime evidence are written only to `.jar/benchmarks/smoke-test/`, with the
latest report under `LATEST/` and full evidence under timestamped `RUN_*`
directories. The five tasks stress skill routing, repository context,
capability exposure, output filtering in non-causal shadow mode, and the
integrated M5+M6+M8 path.

The full live command performs ten real main-model turns and may launch an
executor and fresh verifier Sandbox for each condition. It is intentionally not
part of ordinary tests. Harness tests and fixture calibration are offline:

```powershell
node --test evals/smoke-test/tests/*.test.mjs
```
