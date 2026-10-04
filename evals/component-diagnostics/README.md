# JAR component diagnostics

Permanent executable owner for `m6-evidence-efficiency-v1`,
`m8-operational-closure-v1`, and `m8-inventory-headroom-v1`. These are
evaluation systems, not product promotion paths.

The frozen contracts are in `spec.json`, `campaign-plan.json`, and the suite
source. Mechanism fixtures contain 24 M6 and 24 shared M8 cases, grouped 12
development, 6 calibration, and 6 evaluation-only. Product workspaces exclude
gold, hidden checks, condition labels, and campaign results.

Current treatment dispositions are canonicalized in
[docs/RESEARCH.md](../../docs/RESEARCH.md):

- M6-r1 is a validated specialist, not promoted, with research paused.
- M6-r2 is a negative result retained as an evaluation control.
- operational M8-r1 is a rejected product candidate retained for reproducibility.

Supported zero-turn operations include:

```text
node evals/component-diagnostics/cli.mjs list
node evals/component-diagnostics/cli.mjs identity
node evals/component-diagnostics/cli.mjs preflight
node evals/component-diagnostics/cli.mjs mechanism --suite <id|all> --treatment <id|all> --partition <development|calibration|evaluation-only|all>
```

Historical live-controller commands remain explicit and guarded only for
evaluator reproducibility; they are not a current campaign or roadmap. Evidence is
written beneath ignored `.jar/evaluation/component-diagnostics/` and is not
canonical source truth.

The M8-v1 product matrix is causally invalid because pre-treatment identity was
treatment-dependent. Its repair and regression protection are versioned under
[m8-v2/](m8-v2/README.md). Durable campaign findings live in
[docs/RESEARCH.md](../../docs/RESEARCH.md), not beside the evaluator.

The M6 scorer requires both an allowed source path and matching model-visible
source text. Wrong-source keyword matches and metadata-only payloads cannot
satisfy evidence obligations. Unexecuted oracle lanes are reported as such,
never as constant successes.
