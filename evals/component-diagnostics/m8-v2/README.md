# M8 permanent diagnostics V2

Executable, versioned repair of the M8 paired-evaluation identity. It supersedes
the causal-invalid M8 v1 evaluator without changing the
`v1+m8-operational-r1` treatment. One canonical operational inventory, complete
exposure input, gate input, and starter identity are shared by both arms; the
first permitted divergence is strategy selection.

The corrected campaign rejected operational M8-r1 as a product candidate. This
evaluator remains permanent regression infrastructure; its campaign result is
summarized in [docs/RESEARCH.md](../../../docs/RESEARCH.md) and is not tracked
beside the executable contract.

Commands:

```text
node evals/component-diagnostics/m8-v2/cli.mjs identity
node evals/component-diagnostics/m8-v2/cli.mjs pair-preflight
node evals/component-diagnostics/m8-v2/cli.mjs preflight
node evals/component-diagnostics/m8-v2/cli.mjs campaign --dry-run
node evals/component-diagnostics/m8-v2/cli.mjs resume --execute
node evals/component-diagnostics/m8-v2/cli.mjs report
```

Live execution is impossible until all 12 pairs pass the persisted global
preflight. Evidence is written to
`.jar/evaluation/component-diagnostics/m8-permanent-v2/` in the canonical
checkout and is not preserved by Git.
