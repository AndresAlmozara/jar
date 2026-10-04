# JAR product benchmark matrix

## Owned Codex runtime

Live benchmark execution resolves only the explicitly pinned, content-addressed Codex binary under `.jar/runtimes/codex/`. Installed Codex updates are discovery candidates only and never replace the active campaign runtime.

The upgrade sequence is deliberately split:

```powershell
npm run runtime:discover
node scripts/live-native-baseline-observation.mjs --runtime C:\path\to\codex.exe --revalidate-current
node scripts/codex-runtime-store.mjs admit --source C:\path\to\codex.exe --proof .jar\live-readiness\native-baseline-proof.json
node scripts/codex-runtime-store.mjs pin --version <version> --sha256 <sha256>
npm run runtime:status
```

`admit` runs the local runtime-contract suite before copying, verifies the copied SHA-256, and creates an immutable manifest. `pin` is a separate explicit operation; there is no automatic upgrade path. The generated `.jar/runtimes/` state is ignored by Git.

## Benchmark scenarios

The default remains `opsdesk-hard-v2.4` for CLI and compatibility stability.
It is the specification-heavy correctness, regression, and integration guard.
Its original runner and result paths remain unchanged:

```powershell
node evals/benchmark/run.mjs --jar
```

The scenario-aware entrypoint can select HARD explicitly or run SOFT, the
primary routing-sensitive development diagnostic:

```powershell
node evals/benchmark/scenario-run.mjs --benchmark opsdesk-hard-v2.4 --jar
node evals/benchmark/scenario-run.mjs --benchmark opsdesk-soft-v1 --preflight-only
node evals/benchmark/scenario-run.mjs --benchmark opsdesk-soft-v1 --establish-control
node evals/benchmark/scenario-run.mjs --benchmark opsdesk-soft-v1 --jar --name "Current JAR soft diagnostic"
```

The SOFT baseline, iterations, history, and `LATEST` live below
`.jar/benchmarks/replication/opsdesk-v1/`; they can never satisfy the V2.4
compatibility envelope. SOFT intentionally retains its weak historical public
tests. Its frozen CONTROL is a diagnostic reference: complete infrastructure
and telemetry are mandatory, but product correctness is preserved as observed
rather than required for activation.

The stable scenario matrix is `opsdesk-soft-v1` and `opsdesk-hard-v2.4`.
Registry role strings remain `LEGACY_DIAGNOSTIC` and `CANONICAL_DEVELOPMENT`
for artifact compatibility; current product interpretation is SOFT as the
routing-sensitive screen and HARD as the regression/integration guard. Future
candidate evaluation runs one JAR turn per scenario and uses compatible frozen
CONTROL artifacts. The legacy
aliases `opsdesk-v1-replication` and `opsdesk-v2.4` resolve to those stable IDs.

`run.mjs` remains byte-stable because it is part of the frozen hard V2.4
compatibility envelope. Explicit scenario selection therefore uses the shared
dispatcher `scenario-run.mjs`; changing the frozen hard entrypoint merely for
CLI spelling would invalidate its accepted CONTROL.

OpsDesk — Resilient Incident Lifecycle is the specification-heavy HARD
benchmark (`jar.canonical-product-benchmark.v2.4`). It integrates
durable activity, legal lifecycle transitions, creation-based SLA behavior,
V1→V2 migration, transactional import, semantic roundtrip, persistence, and an
accessible local-first React interface. Correctness is primary; trajectory and
routing evidence are descriptive and there is no composite winner score.

HARD is a repeatedly used **development eval**, not an untouched holdout. A
separate private release holdout is methodologically reserved for possible
future use and is not implemented here. See `REQUIREMENTS.md` for
prompt/public/hidden/mutation traceability, neutrality, and clean replay rules.

The current product hypothesis is that JAR may create more net value on SOFT,
where orientation and routing uncertainty are high, than on HARD, where the
specification already supplies much of the orientation. This is a hypothesis,
not a universal law; SOFT and HARD differ in more than prompt specificity.

`run.mjs` is the canonical orchestration entrypoint. It never selects a live
mode implicitly:

```powershell
npm run eval:benchmark:identity
npm run eval:benchmark:preflight
node evals/benchmark/run.mjs --establish-control
node evals/benchmark/run.mjs --jar
```

`--name "note"` is optional annotation and does not affect technical identity.
CONTROL runs only under `--establish-control`. A normal `--jar` iteration loads
the immutable active CONTROL baseline, validates its complete compatibility
envelope, and stops before model execution when the baseline is absent or stale.

Generated evidence lives below `.jar/benchmarks/canonical/`:

- `baseline/`: immutable CONTROL artifacts plus `ACTIVE.json`;
- `iterations/`: one directory per JAR iteration;
- `history.jsonl`: append-only run index;
- `LATEST/`: a small copy/reference for the latest JAR iteration.

The bounded host product workspace exposes only reviewed read/write/test/build
tools and no shell or network tool. The benchmark records that boundary
explicitly; it does not claim Windows Sandbox isolation. The existing smoke
suite retains the Windows Sandbox integration path.

Offline preflight applies the known-good source overlay to a pristine starter,
uses a manifest/lockfile-matched frozen dependency tree, and evaluates only a
disposable copy. It requires starter failure, gold success, repeated deterministic
gold success, four fixed property seeds, and rejection of every registered
calibration mutant. Preflight never starts a main-model turn.

Protocol compatibility binds the task and traceability document, complete
starter fixture and public tests, hidden verifier, mutation calibration, fixed
seeds, evaluator/harness, frozen dependency seed, clean replay contract, model,
reasoning effort, runtime, native baseline, and isolation boundary. A V1 CONTROL
is therefore incompatible with V2.4. CONTROL is created only by the explicit
`--establish-control` command and is never rerun implicitly.

V2.1 was a protocol erratum over the frozen OpsDesk V2 product task. The first
live V2 CONTROL attempt exposed an over-specified CREATED-event assertion and
was never activated as a baseline. Its failed run evidence remains historical
V2 evidence. V2.1 binds the corrected implementation-neutral verifier; it does
not move or redefine the historical V2 protocol identity.

V2.2 corrects a second verifier-fixture defect exposed by the first live V2.1
CONTROL attempt. The JSON whitespace/property-order check supplied the invalid
metadata value `exportedAt: "ignored"` while expecting import success. V2.2 uses
a valid canonical metadata timestamp, so the check isolates the specified JSON
formatting invariance without weakening timestamp validation. The failed V2.1
run remains immutable historical evidence.

V2.3 repairs the CONTROL/JAR compatibility envelope exposed by the first V2.2
JAR admission attempt. Arrays are compared structurally, and the frozen runtime
identity now contains stable runtime and native-boundary semantics rather than
per-observation timestamps, proof-instance IDs, or absolute evidence paths.
The failed JAR attempt started zero main-model turns, and the successful V2.2
CONTROL remains immutable but is incompatible with V2.3.

V2.4 shortens the filesystem run slug after the first V2.3 JAR attempt proved
that the descriptive slug could exceed the Windows SQLite state-runtime path
budget. Full strategy identity remains in the structured identity and run
label. The failed V2.3 JAR attempt exited during app-server initialization and
started zero main-model turns; the active V2.3 CONTROL remains immutable but is
incompatible with V2.4.
