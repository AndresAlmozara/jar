# OpsDesk — Resilient Incident Lifecycle

Evolve the existing local-first OpsDesk application into a durable incident lifecycle tool. Preserve the existing dashboard, search, filters, sorting, deletion, responsive behavior, and local-only architecture while integrating the requirements below as one coherent product change.

## Lifecycle and durable activity

Each incident has a stable ID, title, description, severity (`P0`–`P3`), optional assignee, status, timestamps, and durable activity. Supported statuses are `OPEN`, `ACKNOWLEDGED`, and `RESOLVED`. The legal lifecycle is:

- a new incident starts `OPEN`;
- `OPEN` can be acknowledged;
- `ACKNOWLEDGED` can be resolved;
- `RESOLVED` can be reopened to `OPEN`.

Reject other status transitions. Reopening starts another response cycle without deleting or rewriting earlier history.

Record exactly these meaningful activity kinds: `CREATED`, `ACKNOWLEDGED`, `SEVERITY_CHANGED`, `ASSIGNEE_CHANGED`, `RESOLVED`, and `REOPENED`. Title and description edits do not create activity. A no-op severity or assignee edit must not create duplicate activity. Activity records need stable deterministic IDs and ordering, incident linkage, timestamps, and before/after values where a change has them. Activity must survive storage and export/import.

Keep domain behavior immutable and testable without React. Existing exported domain helpers may be extended; preserve their useful V1 roles.

## SLA semantics

Response SLA limits remain P0 1 hour, P1 4 hours, P2 24 hours, and P3 72 hours. The deadline is derived from the incident's original creation timestamp and current severity; it never derives from reload time, acknowledgement time, resolution time, or reopen time. At the exact deadline the incident is within SLA; after it, any unresolved incident is overdue. A resolved incident reports `RESOLVED`. Reopening uses the original creation timestamp, so it cannot reset an overdue clock.

All time-sensitive domain operations accept a supplied time (with a normal default) so tests do not depend on the wall clock. Reject activity that predates incident creation or moves backward relative to existing activity.

## Versioned persistence and migration

The current storage schema is version 2. Continue to load the V1 payload already represented by the starter types: `{ version: 1, incidents: V1Incident[] }` with `INVESTIGATING` as its acknowledged state and no activity or assignee.

Migrate V1 deterministically, preserving incident data and timestamps. Map `INVESTIGATING` to `ACKNOWLEDGED`; synthesize the minimum lifecycle activity required to represent the legacy state. Generated activity IDs and ordering must be deterministic. Migration must be idempotent under the current schema: migrating an already-current valid payload again yields the same semantic payload and no duplicate activity.

Current storage is explicit `{ version: 2, incidents: Incident[] }`. Validate the complete payload, including unique incident and activity identifiers, activity linkage/order, supported enum values, and temporal relationships. Corrupt, unsupported, or invalid stored data must fail safely to an empty usable state. Saving and reloading valid state must preserve its meaning.

## Transactional versioned import and export

Export a version 2 JSON document containing all meaningful incident and activity state. Import supports valid V1 and V2 documents. It must parse, validate the complete document, migrate when needed, and only then merge by stable incident ID. Imported collisions replace the existing incident and never duplicate it.

If any record, activity, identifier, version, or temporal relationship is invalid, throw a useful error and leave the existing state and its nested activity unchanged. No partial import is allowed.

Semantic export/import roundtrip equality means equality of every incident field and every activity field, independent of JSON whitespace, object property order, and export metadata such as `exportedAt`.

## Integrated accessible UI

Keep a responsive, keyboard-usable incident dashboard with create, search, severity/status filters, edit, acknowledge, resolve, reopen, and delete behavior. Show assignee, SLA state, and a meaningful Activity region for the selected incident in deterministic chronological/sequence order. Activity labels must communicate the action and show before/after values for severity and assignee changes.

Use semantic headings, forms, labels, buttons, status feedback, visible keyboard focus, and an accessible name for the activity region. Announce import errors without destroying the current view. Visual polish is welcome but correctness and accessibility matter more than aesthetic novelty.

## Quality and delivery

- No backend, authentication, network service, database, or new dependency.
- Preserve immutability and avoid unnecessary global state.
- Add useful public tests without encoding every edge case.
- Document setup, architecture, migration, lifecycle, and import decisions concisely.
- Run the tests and production build and fix failures before finishing.

Finish the implementation; do not stop after planning or scaffolding.
