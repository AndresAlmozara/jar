# Frozen M7 evaluation definition

Config and 16 case labels were written before the first evaluation execution.
Block truth labels compile into original part/range spans independently of the
strategy segment boundaries. `must` means every code unit (or empty channel)
must remain; `safe` licenses removal, not a requirement to remove it. No model
labels or post-hoc threshold tuning. All content is synthetic and approved for
the explicitly bounded live sample; the sensitive-looking case is never live.

Required offline correctness: every must span retained, zero false-drop chars,
every reduction exactly recoverable, failures keep original, shared-observation
three-arm Shadow comparison, metadata-only artifacts and deterministic replay.
Primary metrics: must-retain span recall and false-drop characters. Also report
safe-removal character precision, retained/reduction ratio, exact recovery,
calls/latency and separate failure stages. Empty denominators are null.

The mock judges ONLY complete blocks made exclusively of numeric progress lines
as removable. It receives no truth labels. It is NOT a model-quality estimator.
One provider-failure case injects an exception on the second mock call.

Live case IDs are preselected in config: concise, progress, warning. At most
20 calls total, one execution, no retries/tuning. A missing environment key yields
LIVE_EVAL_PENDING, not a failed offline closure. Live evidence cannot establish
production readiness or coding-outcome improvement.

The eval-harness skill guided predeclared code grading. Its unrelated candidate
execution/containment utilities are not used; this is JAR's existing local Node
test/harness pattern, not an OS isolation or promotion claim.
