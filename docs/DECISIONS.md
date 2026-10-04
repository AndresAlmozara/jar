# Decisions

This is the canonical durable decision log. Routine implementation history
belongs in Git; evidence history belongs in [EVOLUTION.md](EVOLUTION.md).

## Product baseline and experimentation

| ID | Decision | Status |
| --- | --- | --- |
| D031 | JAR V1, derived exactly from the historical ALL-IN treatment, is the canonical product and development baseline. | Accepted |
| D032 | The JAR V2 monolithic experiment is preserved but not promoted; it is evidence for component treatments, not current architecture. | Accepted |
| D033 | New optimization starts from V1 and tests one component treatment at a time. A component must improve its target mechanism without unacceptable product regression before combination. | Accepted |
| D034 | Do not port V2 M5 as implemented; retain V1 M5 until a newly designed replacement wins independently. | Accepted |
| D035 | Prioritize isolated M6 recall-first and minimal M8 operational-sufficiency treatments. | Superseded by D045–D048 after completed diagnostics |
| D036 | Preserve lean V1 batching; evaluate provider/accounting and request-planning corrections separately rather than importing the full V2 planner. | Accepted |
| D037 | M7 remains Shadow with exact pass-through. No causal activation is authorized. | Accepted |

## Evaluation interpretation

| ID | Decision | Status |
| --- | --- | --- |
| D038 | SOFT is the primary routing-sensitive development diagnostic. | Accepted |
| D039 | HARD is the specification-heavy correctness, regression, and integration guard; it is repeatedly used and is not an untouched holdout. | Accepted |
| D040 | Do not calculate strict deltas across incompatible historical harness eras. Historical H0/V1 E2E is context; V2 is compared strictly only with its fresh CONTROLs. | Accepted |
| D041 | Treat the orientation-uncertainty explanation as an evidence-supported product hypothesis, not a universal law. Test it later with predeclared matched tasks. | Accepted |
| D042 | Product usefulness does not require beating CONTROL on every strongly specified task; correctness gates and net routing value remain task-regime dependent. | Accepted |
| D043 | The Codex daily driver is a personal plugin plus lifecycle bridge, immutable local runtime, and file-backed external session state; no daemon or per-repository installation is used. | Accepted |
| D044 | Hook-native M8 enforcement requires a complete identity-bound tool profile. Unknown, partial, or version-mismatched inventories remain observational and cannot justify denial. | Accepted |
| D045 | M6-r1 is the only active component research candidate. It remains an explicit treatment and is not promoted. | Superseded by D054–D059 after final current-JEV closure |
| D046 | M6-r2 does not advance as a product candidate; retain it only as an explicit negative/evaluation control. | Accepted |
| D047 | Operational M8-r1 does not advance as a product candidate; retain its treatment and evaluator for reproducibility and regression protection. | Accepted |
| D048 | M8 activation gate v1 is rejected as the current predictor and must not be tuned on the same observations or advanced unchanged. | Accepted |
| D049 | Corrected M8-v2 evaluation supersedes the causal-invalid M8-v1 product observations by enforcing shared pre-treatment identity. | Accepted |
| D050 | Permanent component diagnostics remain evaluation infrastructure when their treatments lose. | Accepted |
| D051 | Raw/generated evaluation results and campaign state do not belong in canonical source control; ignored `.jar/` is the runtime evidence store. | Accepted |
| D052 | `docs/RESEARCH.md` is the single canonical owner of durable research conclusions and treatment dispositions. | Accepted |
| D053 | Git commits, branches, and tags are the archive for retired campaigns, raw outputs, and superseded research narratives. | Accepted |
| D054 | JAR V1 remains the canonical product after the completed component research program. | Accepted |
| D055 | M6-r1 is a validated specialist treatment, strongest under selection pressure, but is not promoted as general always-on M6. | Accepted |
| D056 | M6-r2 and deterministic D do not advance; retain only controls that serve permanent evaluation. | Accepted |
| D057 | No M6 or other component research program is active; JAR enters daily-use and maintenance mode. | Accepted |
| D058 | The final current-JEV targeted evidence governs the general promotion decision; earlier SOFT/HARD evidence remains valid historical context but is not pooled with it. | Accepted |
| D059 | Conditional or adaptive M6 work requires explicit reopening plus new treatment and evaluation identities. No gate is implemented by this decision. | Accepted |
| D060 | M8 remains closed. Operational M8-r1 and gate v1 do not advance as product candidates. | Accepted |
| D061 | Raw campaign outputs are not canonical documentation; durable conclusions belong in `docs/RESEARCH.md`. | Accepted |
| D062 | Permanent evaluators and regression controls survive their originating campaigns. | Accepted |
| D063 | Remote branches, commits, and tags own retired experimental detail; they are not merged wholesale into canonical main. | Accepted |
| D064 | Optional always-on telemetry is metadata-only, local, bounded, failure-isolated from routing, and begins its protected 14-day observation at the first real routed turn. It does not constitute a V1-vs-r1 experiment. | Accepted |
| D065 | Passive local telemetry is a canonical JAR V1 daily-driver capability and is enabled by default; this supersedes only the optional enablement posture in D064. | Accepted |
| D066 | Telemetry is observational and cannot alter routing decisions without a future explicit product and research decision. | Accepted |
| D067 | Telemetry failure is non-authoritative and cannot block otherwise valid routing; product safety, integrity, permission, and policy failures retain their existing semantics. | Accepted |
| D068 | Raw telemetry is local, Git-ignored, data-minimized, and never uploaded automatically. | Accepted |
| D069 | Model and token usage is recorded only from validated native sources; missing usage remains explicitly unavailable. | Accepted |
| D070 | Ordinary telemetry may suggest hypotheses or evaluation cases, but cannot by itself justify promotion or causal claims. | Accepted |
| D071 | JAR enters a minimum 14-day no-routing-change observation window from the first real routed turn before telemetry-informed iteration is considered. | Accepted |

## Architecture and safety

| ID | Decision | Status |
| --- | --- | --- |
| D001 | Keep an independent portable core; ECC, runtimes, and JEV are adapters/providers. | Accepted |
| D002 | Deterministic facts and policy are authoritative; JEV only proposes semantic relevance, ranking, or classification. | Accepted |
| D003 | Preserve `proposal -> gate -> effect -> receipt`; proposals and plans are not effects. | Accepted |
| D004 | Telemetry and replay precede promotion. | Accepted |
| D005 | New ideas enter as named treatments under common contracts and frozen evaluation identities. | Accepted |
| D006 | ECC is the reference skill catalog; taxonomy is evidence, not execution authority. | Accepted |
| D008 | Repository retrieval and fresh-output handling remain separate responsibilities. | Accepted |
| D009 | Capability routing controls model-visible exposure; it does not choose the model's next tool call. | Accepted |
| D011 | Unknown never collapses into false, empty, unavailable, denied, unsupported, or zero. | Accepted |
| D012 | Semantic uncertainty may widen only within the independently policy-eligible set. | Accepted |
| D013 | Exposure or absence requires complete scoped model-context evidence; config, docs, catalogs, and process presence are insufficient. | Accepted |
| D014 | Exact, lifetime-accessible recovery is required before actively hiding fresh output. | Accepted |
| D015 | Credentials, raw provider payloads, prompts, schemas, and native config stay out of ordinary comparative receipts. | Accepted |
| D016 | Missing usage, cost, calls, or exposure remains `null`; proxies are not measured tokens or cost. | Accepted |
| D017 | Infrastructure-invalid runs cannot select a winner or support quality, savings, or promotion claims. | Accepted |

## Runtime and authentication

| ID | Decision | Status |
| --- | --- | --- |
| D018 | Runtime admission identity is executable version plus SHA-256; path movement alone is not identity drift. | Accepted |
| D019 | CONTROL and JAR conditions share an observed native baseline, with native and dynamic capabilities separately attributed. | Accepted |
| D020 | Model-editable isolated execution uses a network-disabled guest and a separate verifier where that reviewed boundary applies. | Accepted |
| D021 | Use canonical capability and reviewed command IDs; never expose arbitrary shell strings or infer cross-runtime identity from names. | Accepted |
| D022 | JAR-owned ChatGPT OAuth remains separate from normal Codex auth and TypeSafe/JEV authorization. | Accepted |
| D023 | Authentication does not grant runtime, network, workspace, tool, or approval authority. | Accepted |

## Superseded experimental dispositions

- The prior decision to treat HSCE/V2-wide architecture as the intended
  promotion direction is superseded by D031–D036. V1's hierarchical-cover
  implementation remains current; V2 operational sufficiency is only a
  preserved research treatment under D047.
- D035's two-candidate program is complete. D045's sole-active-M6 direction is
  also complete and superseded by D054–D060. M8 remains closed.
- Active old-history pruning and JEV next-tool steering remain rejected.
- Effort, model/provider, and automatic agent routing are not active programs.

## Documentation governance

- `README.md` owns entry points and operator-facing usage.
- `docs/ARCHITECTURE.md` owns current V1 structure and invariants.
- `docs/STATUS.md` owns current evidence, limitations, delete-zone, and next work.
- `docs/DECISIONS.md` owns durable decisions.
- `docs/EVOLUTION.md` owns the concise evidence/evolution record.
- `docs/RESEARCH.md` owns durable scientific findings, invalid experiments,
  negative results, and treatment dispositions.
- `research/` is supporting evidence, not runtime canon.
- Git is the archive; superseded roadmaps are deleted rather than copied.
