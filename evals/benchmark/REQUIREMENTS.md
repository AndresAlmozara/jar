# OpsDesk HARD V2.4 traceability and methodology

OpsDesk HARD V2.4 is the repeatedly used specification-heavy **regression and integration development eval**. It is not an untouched holdout. Adaptive overfitting is therefore expected and must be monitored. A separate private product/project may eventually serve as a rarely executed **FUTURE RELEASE HOLDOUT**; that holdout is intentionally not implemented here.

| Requirement | Task specification | Public signal | Hidden behavior | Calibration mutant |
|---|---|---|---|---|
| Durable linked activity and deterministic order | Lifecycle and durable activity | creation, reopen, edit/no-op | linkage, uniqueness, equal-time order, immutability, backdating | equal-time-nondeterminism; storage-drops-history |
| Legal lifecycle and preserved reopen history | lifecycle table | full happy path | illegal transitions and prior-history preservation | reopen-erases-history |
| Creation-based SLA across reopen | SLA semantics | overdue reopen | exact boundary, resolved behavior, four shifted seeds | reopen-resets-sla |
| V1→V2 deterministic migration | Versioned persistence | INVESTIGATING mapping | all legacy states, semantic preservation | migration-duplicates-current |
| Migration idempotence | Versioned persistence | once equals twice | twice and three times, no activity duplication | migration-duplicates-current |
| Complete graph validation and safe storage | Versioned persistence | corrupt/unsupported fallback | duplicate IDs, linkage, sequence, time | storage-drops-history |
| Transactional V1/V2 import | Import/export | invalid payload preserves existing | valid first/invalid last, unsupported version, nested immutability | import-partial-commit |
| Semantic export/import roundtrip | Import/export | repeat roundtrip | activity fields, whitespace/order, four-seed collection | export-drops-metadata |
| Integrated lifecycle/activity UI | Integrated accessible UI | SSR shell/activity | lifecycle actions, meaningful labels, integrated controls | activity-live-region-missing (partial) |
| Accessibility/responsiveness | Integrated accessible UI | labels and live feedback | named activity region, live status, focus, media query | activity-live-region-missing |
| V1 dashboard regressions | opening paragraph and UI | public domain/UI suite | search+severity+status, sort immutability, delete | starter and cross-cluster checks |
| Documentation | Quality and delivery | task asks for docs | setup, architecture, migration, lifecycle, import terms | starter calibration |

No material prompt requirement is intentionally untested. Visual polish is intentionally assessed only through basic responsive/semantic evidence: aesthetic snapshots would be brittle and would turn the task into a design contest.

## Difficulty and neutrality

The intended solution changes the existing domain, storage, I/O, React shell, styles, tests, and README without adding dependencies or repository noise. Difficulty comes from coordinating state invariants across those regions. The benchmark contains no router-specific filenames, answer hints, synthetic skills, or capability traps. It naturally gives skill selection, repository discovery, output observation, and selective capability exposure useful work while product correctness remains the only correctness gate.

## Replay contract

Evaluation projects the candidate source state onto a pristine starter copy, attaches only the frozen dependency tree whose package manifest and lockfile match, then runs build, public tests, and the hidden verifier in a disposable copy. Generated output, caches, local storage, and evaluator files are not accepted as candidate dependencies. The gold calibration uses this same boundary.
