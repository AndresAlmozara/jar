Build OpsDesk, a polished local-first incident management application.

Users must be able to create, edit, inspect, resolve, reopen, and delete incidents.

Each incident must contain:

- stable id
- title
- description
- severity: P0 / P1 / P2 / P3
- status: OPEN / INVESTIGATING / RESOLVED
- created timestamp
- updated timestamp

The main interface must support:

- incident list/dashboard
- text search
- filtering by severity
- filtering by status
- deterministic sorting
- clear empty states
- responsive layout
- keyboard-usable controls
- sensible accessible labels and focus behavior

Implement SLA logic:

- P0: 1 hour
- P1: 4 hours
- P2: 24 hours
- P3: 72 hours

For unresolved incidents, show whether the incident is within SLA or overdue.

SLA calculations must remain correct across reloads and must derive from persisted timestamps rather than transient countdown state.

Persistence requirements:

- application state must survive a page reload
- storage must be versioned
- corrupted stored data must fail safely rather than destroying the usable application

Import/export requirements:

- export all incidents to versioned JSON
- import valid exported JSON
- invalid imports must produce a useful error and must not wipe existing state
- importing the same dataset repeatedly must not accidentally duplicate incidents with the same stable id

Quality requirements:

- preserve immutability where appropriate
- avoid unnecessary global state
- keep domain logic testable outside UI components
- no external backend
- no authentication
- no fake network service
- no external product API

Testing requirements:

- add meaningful tests for domain behavior and important regressions
- all tests must pass
- production build must succeed

Documentation:

- add a concise README describing setup
- explain the architecture
- explain important design decisions

Finish the product completely.

Do not stop after planning or scaffolding.

Run the available tests and build checks.

Fix problems you encounter before finishing.
