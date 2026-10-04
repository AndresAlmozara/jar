# Current Status

Last reconciled: 2026-10-03. JAR is in **daily-use / maintenance mode**.
Scientific evidence and treatment dispositions are in
[RESEARCH.md](RESEARCH.md).

## Canonical baseline

| Component | Canonical state |
| --- | --- |
| M5 | `skill/ecc-native-v1` |
| M6 | `context/deterministic-v1` |
| M7 | exact-pass-through Shadow |
| M8 | `capability/jev-hierarchical-cover-v1` |

JAR V1 is the sole default and the Codex daily driver is operational. Named
experimental treatments require explicit selection.

## Local telemetry state

The canonical metadata-only always-on profile is enabled in the installed
daily driver. Its central store is the ignored `.jar/telemetry/` tree in this
repository; cross-repository ingress uses `~/.jar/telemetry-spool/`. The
user-level `JAR Telemetry Maintenance` task is registered for logon and
30-minute triggers and has completed successfully. Health is `HEALTHY`, with no
known drops at the canonicalization checkpoint.

Synthetic installation validation covered two unrelated Git repositories and
one non-Git directory through the installed runtime into the same sink. These
events are labelled `validation` and did not start the study. The first genuine
ordinary-use routing event set T0 to `2026-10-03T18:42:02.089Z`; the protected
study is `ACTIVE` through `2026-10-17T18:42:02.089Z`. Reinstallation preserves
that study identity, evidence, and T0 while recording runtime transitions in
study provenance. Collection continues afterward unless explicitly disabled.

Native usage currently covers explicit validated adapter fields only. Local
transcript parsing, Codex cloud, separate remote/WSL/container homes, and other
machines are explicitly not covered. See [TELEMETRY.md](TELEMETRY.md).

## Research state

The component research program is complete and paused. No component campaign,
automatic architecture experiment, M6-r3, adaptive gate, M8 revival, V2
redesign, M5 redesign, or M7 causal-filtering program is active.

M6-r1 is validated as a specialist: its semantic mechanism worked on the final
current-JEV holdout and product correctness remained 8/8, but end-to-end value
was strongly regime-dependent. Selection pressure favored r1; indirect
relation/import and the larger non-exhaustive repository path favored V1.
That is insufficient for always-on promotion, so V1 remains canonical.

M6-r2 and deterministic D are negative results. Operational M8-r1 is a rejected
product candidate retained only where permanent evaluator reproducibility or
regression protection needs it. M8 remains closed.

## Evaluation infrastructure

The frozen generational evaluator, SOFT/HARD benchmark harnesses, smoke harness,
component diagnostics, M6 evidence-efficiency fixtures/oracles, and repaired
M8-v2 pair-identity regressions are present and executable. The M6 scorer also
rejects wrong-source and metadata-only evidence matches.

Generated results and campaign state belong beneath ignored `.jar/` paths.
Canonical source control contains no tracked `.jar` run evidence.

## Operational limitations

- M8 enforcement requires a complete identity-bound inventory; unknown or
  incomplete inventories remain observational.
- M7 is non-causal and always passes original bytes.
- M6 V1 candidate recall is limited on the frozen evaluator.
- M5 remains the older ECC-native design.
- packed and scalar semantic requests are not assumed equivalent.
- missing provider usage or economic data remains `null`.
- different evaluation eras are historical context, not strict pooled deltas.

## Next work

Use JAR normally and collect passive observational evidence for at least 14
days from T0. During that window make no routing, threshold, treatment, schema,
or architecture changes unless a collection defect must be repaired to
preserve the study; record any such repair in provenance. Observation is not an
experiment and cannot establish a counterfactual product improvement. Research
reopens only through an explicit new treatment and evaluation identity.

## Validation baseline

The consolidated source inherited a 674-test, zero-failure baseline with three
explicit skips plus a 25/25 benchmark/shared-harness selection check. The final
freeze must preserve ordinary tests, focused treatment tests, component
diagnostics, M8-v2 regressions, benchmark/shared harness checks, the frozen
generational self-test, clean diff whitespace, and `v1` as the sole default.
