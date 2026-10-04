# JAR Research Ledger

This is the canonical scientific memory for completed JAR component research.
Product truth remains in [ARCHITECTURE.md](ARCHITECTURE.md), operational state
in [STATUS.md](STATUS.md), and durable decisions in
[DECISIONS.md](DECISIONS.md).

**Research status: PAUSED. Active JAR research programs: none.**

Post-freeze always-on telemetry is observational dogfood infrastructure, not a
research treatment. Any hypothesis derived from it needs a new explicit
treatment and evaluation identity before it can support a product conclusion.

## Final treatment matrix

| Treatment | Mechanism | Product evidence | Final disposition |
| --- | --- | --- | --- |
| V1 M6 | baseline | stable canonical | `CANONICAL` |
| M6-r1 | validated | correct but regime-dependent | `VALIDATED_SPECIALIST_NOT_PROMOTED` |
| M6-r2 | weaker; sufficient-set/materialization failures | no product case | `NEGATIVE_RESULT` |
| M6-D | deterministic recall-first weaker | no product case | `NEGATIVE_RESULT` |
| M8 operational-r1 | mechanism gain | no stable product regime | `REJECTED_PRODUCT_CANDIDATE` |
| M8 gate v1 | not applicable | poor predictor | `NEGATIVE_RESULT` |

No combined treatment is registered. No treatment is an active roadmap item.

## Final M6 current-JEV campaign

### Identity and calibration

The campaign selected `jev-latest`; every valid provider response resolved to
`jev-1.13.0`, with no observed model-identity drift. Calibration retained
`packed-question-local-v1` at threshold `0.60`. Scalar request topology did
not repair a critical semantic deficit sufficient to justify its cost.

### Protected semantic holdout

M6-r1 passed all 6/6 actual-JEV holdout cases:

| Metric | Result |
| --- | ---: |
| file recall | 1.0 |
| span recall | 1.0 |
| sufficient evidence coverage | 1.0 |
| critical misses | 0 |
| materialization drift | 0 |

This resolves the earlier uncertainty that r1 might work only under a contract
oracle. Its semantic mechanism worked with the validated JEV identity used by
the final campaign.

### Targeted product matrix

The final matrix contained four M6-sensitive families, two treatments, and two
repetitions: 16 valid episodes. V1 was correct in 8/8 arms and M6-r1 was correct
in 8/8 arms. No observed correctness regression was attributable to r1.

| Regime | r1 wall-time result | Disposition |
| --- | ---: | --- |
| low lexical overlap | about 1% faster | no material general advantage established |
| indirect relation/import | about 7.5% slower | V1 favored |
| selection pressure | about 28.8% faster; repetitions about -36% and -20% | strong r1 specialist regime |
| >32 unique files / non-exhaustive path | about 19.5% slower; one near-neutral, one about +44% | V1 favored; r1 instability observed |

Across all targeted runs r1 was about 4% faster in total wall time. That number
is not a general improvement: it hides opposing regime effects and is heavily
influenced by selection pressure. Always-on promotion requires cross-regime
robustness, which was not established.

### Main-model token accounting

| Treatment | Uncached input | Cached input | Output | Measured total |
| --- | ---: | ---: | ---: | ---: |
| V1 | 91,969 | 714,112 | 14,604 | 820,685 |
| M6-r1 | 99,200 | 767,104 | 13,640 | 879,944 |

M6-r1 consumed about 7% more measured total main-model tokens. Sol and JEV token
counts are not economically combined.

### Tool trajectory and routing

| Measure | V1 | M6-r1 |
| --- | ---: | ---: |
| all tools | 48 | 50 |
| searches | 10 | 11 |
| reads | 15 | 16 |
| aggregate routing | about 90 ms | about 2,730 ms |
| JEV semantic routing within aggregate | n/a | about 2,631 ms |

There is no general evidence that r1 reduces tool trajectory across all task
regimes. Its trajectory benefit was strongest under selection pressure. The JEV
routing cost is real even though it does not alone explain every product result.

## Corrected M6-C mechanism result

The corrected M6-C v2 evaluator froze 24 cases across 12 independent families,
with development/calibration/evaluation partitions of 12/6/6. It distinguishes
candidate-file recall, candidate-span recall, selected-file recall, delivered
sufficient coverage, precision, duplication, redundancy, and materialization
drift.

| Treatment | Corrected offline result | Interpretation |
| --- | --- | --- |
| V1 | 16/24; sufficient coverage 0.805556 | canonical baseline |
| M6-r1 | 24/24; sufficient coverage 1.0 | mechanism qualified |
| M6-r2 | 20/24; drift on 10/24 | rejected |
| M6-D | 20/24; mean 2,093.417 delivered bytes | rejected |
| E/J/S | no diagnosed opportunity after r1 decomposition | not admitted or implemented |

At that earlier checkpoint, exact `jev-1.13.0` was absent and substitution was
forbidden, so the evaluator correctly withheld actual-JEV qualification and
product work. The later current-JEV campaign resolved that identity limitation.
Metrics are not pooled across these evaluation eras.

The permanent scorer now requires an allowed source path plus matching
model-visible source text. Wrong-source keyword matches and metadata-only
payloads cannot satisfy an obligation, and unexecuted oracle lanes remain
explicitly unexecuted.

## Historical SOFT/HARD context

Across historical screening and confirmation, M6-r1 was faster than paired V1
in 6/6 SOFT/HARD comparisons. Approximate aggregate wall time was 13.6% lower
and main-model tokens 2.1% lower. Token behavior was not stable: one important
HARD confirmation repetition used about 43.5% more tokens while wall time
remained slightly favorable.

The durable interpretation is a repeated historical latency signal, not a
token-savings guarantee. These runs belong to an earlier harness and provider
era and are not recomputed into strict deltas with the final targeted matrix.

## Why V1 remains canonical

M6-r1 is the strongest unpromoted M6 treatment:

- mechanism: validated;
- actual-JEV semantic qualification: validated;
- targeted product correctness: validated in the observed matrix;
- general always-on improvement: not established;
- strongest observed regime: selection pressure;
- unfavorable or unstable regimes: indirect relation/import and the larger
  non-exhaustive repository path;
- token economics: mixed historically and modestly worse in the final matrix;
- product disposition: not promoted;
- research disposition: frozen and paused.

A future conditional or adaptive M6 program would require explicit reopening,
a new treatment identity, and a new evaluation identity. No gate is implemented
or planned by this freeze.

## M8 closure

Operational M8-r1 improved local mechanism sufficiency but did not demonstrate
stable product value. The first permanent product matrix was causal-invalid
because treatment-dependent inputs crossed the comparison boundary. M8-v2
repaired pair identity and retained regressions that reject that defect.

The repaired campaign completed 12 valid pairs and 24 product runs. V1 achieved
12/12 correctness versus 11/12 for operational M8, won paired frozen utility
8 to 3 with one ambiguous pair, used fewer aggregate main-model tokens, and
required far fewer JEV requests. The activation gate was a poor predictor.

Operational M8-r1 is therefore a rejected general product candidate; the
activation gate is a negative result. Permanent diagnostics and pair-identity
regressions remain. M8 is closed and is not an active roadmap.

## Permanent evaluator inventory

| Area | Classification and retained value |
| --- | --- |
| `evals/_shared/` | permanent control: run identity and telemetry |
| `evals/generational/` | permanent control: frozen common L0/L1/L2 fixtures, gold, and self-test |
| `evals/benchmark/` | active product harness: SOFT/HARD preflights and shared runner |
| `evals/smoke-test/` | active product harness: integration fixtures and verifiers |
| `evals/component-diagnostics/` | permanent diagnostic: M6/M8 fixtures, oracles, isolation, and regression tests |
| `evals/component-diagnostics/m8-v2/` | permanent diagnostic: repaired pair identity and causal regressions |
| `evals/capability-exposure/` | permanent control: M8 synthetic cases and golden offline snapshot |
| `evals/output-filtering/` | permanent control: M7 safety cases and golden offline snapshot |
| `evals/repository-context/` | permanent control: M6 fixtures and golden offline report |
| `evals/optimization/` | permanent diagnostic: promotion policy and decision/oracle regressions |

Tracked files named `offline-results.json` or `offline-report.json` in those
controls are test-loaded golden snapshots, not disposable campaign output.
Generated live results remain ignored beneath `.jar/`.

## Private archive boundary

The exact historical branches, checkpoint commits, copied vendor corpus, raw
telemetry, campaign outputs, review bundles, generated pair reports,
schedulers, and one-shot state machines are retained in the private canonical
development repository. They are intentionally not part of this clean public
distribution and are not required to interpret the findings above.

This ledger is the public scientific record: it preserves final numbers,
methodology caveats, negative results, and treatment dispositions without
pretending that private archive identifiers are publicly resolvable.
