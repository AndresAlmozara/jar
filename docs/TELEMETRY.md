# Always-on telemetry

Always-on telemetry is JAR V1's canonical local observability layer. The
installed daily-driver profile enables it by default. It records bounded
metadata about routing and downstream activity so ordinary use can be audited
without making telemetry an input to routing.

It does not change M5, M6, M7, M8, prompts, permissions, providers, or output
limits; add model or JEV requests; capture working content; establish a causal
comparison; or upload evidence. Routing is product logic. Telemetry observes
product logic.

## Architecture and coverage

The operational path is intentionally one-way:

```text
runtime adapter / hook
        → atomic local spool
        → deterministic maintenance
        → central local store
        → derived reports and review queues
```

This is a passive side channel. Routing does not wait for telemetry authority,
and telemetry cannot approve, deny, or revise a route.

Instrumented adapters emit `jar.telemetry.event.v1` envelopes to one
atomically renamed file per observation in `~/.jar/telemetry-spool/`.
Deterministic maintenance deduplicates events, validates the closed schema,
writes checksum-verified gzip chunks to the configured central store, and
rebuilds derived turn, session, tool, daily, and study views. Reports use
`jar.telemetry.metrics.v1`.

The store is user-level rather than repository-scoped: an instrumented JAR
adapter used in another repository still writes to the configured central JAR
store. Each event identifies its adapter and runtime. Codex is the primary
daily-driver source and covers the installed six-event lifecycle
(`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and
`SessionEnd`). The OpenCode observer emits compatible session, hook, and tool
observations only for events its bridge actually sees. Codex cloud, other
machines, and separate WSL/container homes are `NOT_COVERED` unless separately
installed and verified.

Session, native-thread, actor, turn, route, repository, and tool-invocation IDs
provide correlation with explicit `exact`, `partial`, or missing status. A
tool start and finish are phases of one logical invocation; replayed event IDs
are deduplicated during maintenance.

## Evidence semantics

- **Observed:** allowlisted adapter/runtime metadata, native IDs, categorical
  outcomes, sizes, counts, timings, hashes, delivery states, and validated
  native usage fields.
- **Derived:** deterministic turns, sessions, logical tools, aggregates,
  reports, health summaries, and review queues rebuilt from observed events.
- **Inferred:** no routing or product fact is inferred by telemetry. Human
  interpretation of correlations remains a hypothesis.
- **Unavailable:** unsupported coverage, host-confirmed model exposure,
  transcript-derived usage, absent native usage, and causal counterfactuals
  remain explicitly missing rather than becoming zero or false.

JAR-output inclusion is not proof of host/model exposure, a later file read is
not a relevance label, and `Stop` is not proof of task success. Observed V1
work is not a CONTROL-versus-treatment experiment.

## Storage, privacy, and capacity

The central root is configured in `~/.jar/config.json`; this installation uses
the repository's ignored `.jar/telemetry/` tree. Raw events, generated reports,
study manifests, local maps, and exports remain outside Git. There is no
automatic remote export.

Events do not persist prompt or assistant text, source or skill bodies, tool
arguments or outputs, diffs, shell transcripts, credentials, authentication
tokens, secrets, or raw exception messages. Low-entropy identifiers use a
machine-local keyed HMAC. Necessary repository/file locators are stored
separately in `private/locators.jsonl` under user-only filesystem permissions;
sanitized exports exclude locators and key material. Pseudonymization is not an
anonymity guarantee.

The default retention is 45 days for raw events and 180 days for summaries.
Unreviewed evidence inside the protected initial study is exempt from ordinary
raw retention. The profile warns at 1 GiB, applies a 2 GiB archive limit, and
uses a 256 MiB spool limit. Capacity loss is explicit in health; it never
changes routing.

## Usage accounting

Usage is recorded only when a supported adapter provides validated native
fields. Cached input remains a subset of input, cumulative counters are not
double-counted, and main-model and JEV quantities are kept separate. Character
counts are never converted into tokens. Transcript parsing is
`UNAVAILABLE_UNVALIDATED`; missing usage remains `null` or unavailable.

## Study and runtime continuity

The initial observation study begins only when maintenance sees the first
production `routing.observed` event. Installation and synthetic validation
events leave it at `INSTALLED_AWAITING_FIRST_REAL_EVENT`. That first genuine
event establishes T0 and the 14-day T1. At T1 the study becomes
`READY_FOR_REVIEW`, while collection continues because `continueAfterStudy` is
enabled.

Disable/re-enable and runtime reinstall preserve the active study ID, T0,
protected evidence, and accumulated events. Maintenance records observed and
installed runtime identities in `runtimeTransitions`, including source commit
and content hash when available, so cutovers do not create artificial study
boundaries.

## Maintenance and health

On Windows, `JAR Telemetry Maintenance` runs at user logon and every 30 minutes
using the installed `~/.jar/bin/jar.cmd telemetry maintain` launcher. It uses no
daemon, password, model, network collector, mutable checkout, or temporary
worktree. A lock prevents overlapping maintenance runs.

`HEALTHY` means configuration, storage, the last maintenance pass, capacity,
and known-loss accounting are usable; it is not a claim that every external
adapter is covered. `CAPACITY_LIMIT`, invalid spool items, known-loss reasons,
missing scheduler state, and explicit coverage fields explain degraded states.

Sink, spool, scheduler, aggregation, report, or malformed optional-usage
failure is fail-open for telemetry only: it must not corrupt or block an
otherwise valid JAR decision. Core runtime integrity, materialization,
permissions, policy, and safety keep their existing fail-closed or error
semantics. A sink failure leaves complete spool items for a later retry.

## Operator commands

Use the installed launcher; none of these commands performs live inference:

```powershell
jar telemetry status
jar telemetry doctor
jar telemetry maintain
jar telemetry report --study <study-id>
jar telemetry export --study <study-id> --sanitized
jar telemetry mark --turn <turn-id> --label useful|noisy|missing|unknown
jar telemetry disable
jar telemetry enable --root "<absolute-central-store>" --study-days 14
```

`status` reports configuration, study, and last health. `doctor` also checks
identity, root, spool, privacy posture, native-usage support, scheduler, current
runtime, capacity, and known loss. `maintain` performs deterministic drain and
rebuild. `report` reads or regenerates the deterministic study report. `export`
requires `--sanitized` and creates a local ZIP without private locators or the
HMAC key. `mark` records bounded human feedback.

`disable` is the emergency stop: it disables recording and the maintenance
task without deleting evidence. Re-enable with the same central root; the
latest study is reused instead of reset and the dual-trigger task is restored.
If the current runtime is faulty, disable telemetry if necessary and roll back
the installed JAR pointer to the retained prior immutable runtime; do not erase
the spool, central store, or study manifest.

During the protected 14-day window, use JAR normally and allow health checks,
maintenance, deterministic reports, and only collection-critical repairs.
Do not tune routing, activate a treatment, redesign the schema, or claim product
improvement from partial observational evidence. Record any necessary repair
in study provenance.
