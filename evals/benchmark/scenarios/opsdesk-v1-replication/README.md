# OpsDesk Soft (`opsdesk-soft-v1`)

This is a byte-faithful recovery of the benchmark definition from Git commit
`5f0591d31f5833eb2e45b2db2219b616a8af4b3a`, formerly located at
`evals/product-trial/`. It is intentionally broader and less specified than
the HARD V2.4 benchmark. Its stored registry role remains
`LEGACY_DIAGNOSTIC` for artifact compatibility; its current product role is the
primary routing-sensitive development diagnostic. Provenance is
`HISTORICAL_BENCHMARK_PROVENANCE_PARTIAL`: the committed definition is exactly
recovered, but the original numerical run artifact is unavailable.

The task, starter, placeholder public tests, hidden acceptance runner, and
known-good implementation retain their historical semantics. Modern code only
adapts execution, naming, telemetry, compatibility, and result storage.

Run offline preflight:

```powershell
node evals/benchmark/scenario-run.mjs --benchmark opsdesk-soft-v1 --preflight-only
```

SOFT uses the `DIAGNOSTIC_REFERENCE` baseline policy. A completed CONTROL with
complete build, evaluator, telemetry, routing, and runtime evidence can be
frozen even when its product is incorrect. Its exact acceptance result remains
visible and is never converted into a pass.

The unchanged `node evals/benchmark/run.mjs --jar` command remains the HARD
V2.4 specification-heavy regression/integration benchmark. It is not an
untouched holdout. The scenario-aware entrypoint uses the stable ID
`opsdesk-hard-v2.4` when selecting it explicitly.
