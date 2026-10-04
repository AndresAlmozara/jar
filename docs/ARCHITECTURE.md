# JAR V1 Architecture

This document describes what runs as product. Research evidence belongs in
[RESEARCH.md](RESEARCH.md), current operating state in [STATUS.md](STATUS.md),
and durable choices in [DECISIONS.md](DECISIONS.md).

## Canonical identity

JAR V1 is the lean product treatment historically named ALL-IN. Detailed
development checkpoints, experimental lineages, and named component-treatment
archives remain in the private development repository; they are research
artifacts, not default architecture or part of this public Git history.

## Responsibility split

```text
task + catalog/runtime observations
              |
              v
deterministic identity, facts, eligibility, and candidates
              |
              v
bounded TypeSafe/JEV semantic proposals where configured
              |
              v
independent policy gate and deterministic completion
              |
              v
runtime materialization -> main coding model -> verifier
              |
              v
receipts, telemetry, and evaluation
```

JEV does not own inventory truth, permissions, risk, policy, execution, or
verification.

## Canonical V1 profile

### M5 — skill routing

V1 uses `skill/ecc-native-v1`. ECC supplies canonical identities and bounded
metadata. Explicit canonical requests remain facts; semantic selection cannot
grant execution authority.

### M6 — repository context

V1 uses `context/deterministic-v1`: bounded deterministic candidate generation
and retrieval with source provenance. Retrieval miss, repository failure,
semantic rejection, and provider failure remain distinct.

M6-r1 and M6-r2 are inactive explicit research treatments. They do not alter
the product architecture or normal invocation path.

### M7 — fresh output

M7 remains Shadow and exact pass-through. The main model receives the original
bytes. No causal pruning is authorized.

### M8 — capability exposure

V1 uses `capability/jev-hierarchical-cover-v1`. Deterministic eligibility is
applied before semantic routing; independent policy rechecks authority.
Mandatory, explicit, unknown, ambiguous, and operationally required coverage
is preserved within the V1 contract.

Operational M8-r1 remains only as an inactive explicit treatment needed by
permanent evaluator regressions. It is not a product candidate.

### Provider and request topology

The provider supports scalar primitives and batched Noul questions. Each batch
has stable request and question identities; partial or malformed responses fail
explicitly. Packing is not presumed transport-neutral, so the lean V1 request
topology remains unchanged.

## Treatment boundary

`packages/core/src/treatments.js` is the explicit registry. Its default is
always `v1`; no research treatment can be selected implicitly.

| Treatment | Scope | Disposition |
| --- | --- | --- |
| `v1` | canonical M6 + M8 | sole default product |
| `v1+m6-recall-r1` | M6 only | validated specialist, not promoted |
| `v1+m6-evidence-r2` | M6 only | negative result / evaluator control |
| `v1+m8-operational-r1` | M8 only | rejected product candidate / regression control |

## Repository map

| Area | Location | Responsibility |
| --- | --- | --- |
| CLI | `bin/` | command parsing and operator summaries |
| Core | `packages/core/` | contracts, identities, treatment registry |
| JEV provider | `packages/decision-providers/jev/` | transport, validation, usage telemetry |
| ECC catalog | `packages/catalog-adapters/ecc/` | skill identity and provenance |
| M5 | `packages/skill-routing/` | skill strategies and Shadow comparison |
| M6 | `packages/repository-context/` | candidates, retrieval, materialization |
| M7 | `packages/output-filtering/` | observation and exact recovery support |
| M8 | `packages/capability-exposure/` | eligibility, cover, policy gate |
| Runtime adapters | `packages/runtime-adapters/` | neutral contracts and translation |
| Telemetry | `packages/telemetry/` | bounded metadata ingress, maintenance, derivation and deterministic reports |
| Evaluation | `evals/` | frozen, product, smoke, and component evaluators |
| Research ledger | `docs/RESEARCH.md` | public findings and treatment dispositions |

## Runtime boundary

The neutral adapter contract separates observation, plan translation,
application, and restoration. Configured intent is not evidence of actual
model-visible exposure. Complete exposure claims require complete scoped
observation.

The Codex hook-native integration uses a content-addressed runtime outside
target repositories. Hook fidelity is full for canonical M5/M6,
observational-only for M7, and conditional for M8. Unknown tools remain unknown;
Codex permission policy remains authoritative.

### Cross-cutting observability

Always-on telemetry is a passive layer around, not inside, the routing and
authorization path:

```text
host/adapter events
        ↓
JAR V1 routing → existing product behavior
        ↓
passive metadata emission
        ↓
user-level local spool
        ↓
deterministic maintenance and aggregation
        ↓
configured local telemetry store
```

Correlation IDs connect session, turn, route, tool, adapter, and runtime
observations. Codex is the primary full lifecycle source; the OpenCode observer
emits only the compatible events it actually sees. Adapter provenance remains
explicit so evidence can be segmented by host and coverage.

Each event is atomically written to the bounded user-level spool. Maintenance
deduplicates it, writes checksum-verified chunks to the central store, and
rebuilds derived tables and reports. Sink, spool, scheduler, aggregation, or
optional usage-metadata failure is non-authoritative and must not change an
otherwise valid route. Existing integrity, permission, and policy failures keep
their original semantics.

Events contain allowlisted metadata, hashes, sizes, categorical outcomes, and
explicit missingness—not prompts, responses, source bodies, tool bodies,
transcripts, diffs, or credentials. Necessary local path locators are separated
from sanitized exports. Model/token usage is present only when a supported
adapter supplies validated native fields; it is otherwise unavailable, never
estimated from text. Raw evidence remains local under the configured ignored
`.jar/telemetry/` boundary and is not an automatic upload pipeline.

## Non-negotiable invariants

- JEV proposes; deterministic code and policy authorize.
- unknown never silently becomes safe, absent, or zero.
- proposal, configuration, execution, and verification are distinct evidence.
- stable identities bind content and provenance, not transient paths.
- missing usage or cost remains `null`.
- infrastructure-invalid runs cannot support product claims.
- component treatments are explicit and evaluated independently.
- generated evaluation output belongs under ignored `.jar/`.

## Permanent evaluation infrastructure

- `evals/generational/`: frozen common L0/L1/L2 evaluator.
- `evals/benchmark/`: SOFT/HARD product harnesses.
- `evals/smoke-test/`: smoke and integration harness.
- `evals/component-diagnostics/`: reusable M6/M8 mechanism contracts,
  fixtures, gold, isolation controls, and telemetry.
- `evals/component-diagnostics/m8-v2/`: shared pre-treatment pair identity and
  regressions rejecting treatment-dependent inputs.

The corrected M6 scorer requires source-path identity plus model-visible source
text and reports unexecuted oracle lanes honestly. Evaluation infrastructure
survives completed campaigns; campaign diaries and raw outputs do not.

Detailed raw provenance and the unlicensed frozen vendor-documentation corpus
remain in the private development archive and are intentionally not
distributed.
