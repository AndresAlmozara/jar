# OpsDesk

## Setup

Install the frozen dependencies, run `pnpm test`, and run `pnpm build`.

## Architecture and design

`domain.ts` owns immutable lifecycle, activity ordering, and creation-based SLA rules. `storage.ts` validates the complete version 2 graph and performs deterministic migration of legacy version 1 incidents. `io.ts` reuses that validation before committing a merged import, making invalid imports atomic. React remains an accessible local-first view over those modules.

Activity sequence numbers and IDs are derived from the incident and prior sequence. Reopen appends history and returns to `OPEN`; it never changes `createdAt`, so SLA does not reset. Export metadata is outside semantic incident state.
