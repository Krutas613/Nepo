# ADR-006: Schema has one owner; changes go through docs/schema-requests.md

**Status:** Accepted (Milestone 0)

## Context
Rule 6: shared types have one owner. Many agents work in parallel; if each adds fields to shared
types, the state shape forks and saves break. Slice types, command and event unions, and data-file
validators are all shared because the UI, sim-tests and the save format depend on them.

## Decision
- Only `schema` edits `packages/sim/src/schema`. It contains: brands and IDs, `Money`/`Quantity`,
  `Result`, errors, `SystemId`/`SYSTEM_ORDER`, `Company`, `Scenario`, `WorldState` and every slice
  type, `Command`/`Event` unions, zod validators, `Snapshot`, content types, fixtures.
- Not schema territory (owned by the module): chart-of-accounts template and `ACCOUNTS` constants,
  service APIs, `System` objects, engine runtime types (`Phase`, `TickContext`, `Rng`, `CalendarDate`).
- Requests are filed in `docs/schema-requests.md` (REQ-NNN, additive/breaking, proposal, consumers).
  Schema accepts, rejects with reasoning, or counter-proposes, and records the outcome in the changelog.
- Breaking changes bump `SCHEMA_VERSION` and come with migration notes; the engine agent implements
  the corresponding `migrations.ts` step before merge. Additive optional fields do not bump.
- Hand-written interfaces are the source of truth; zod schemas carry `satisfies z.ZodType<T>`.
- Milestone 0 fast path: the foundation agents implement against the shapes in ARCHITECTURE.md;
  discrepancies at merge resolve in favour of ARCHITECTURE.md.

## Consequences
- Domain agents experience a short delay for new fields; in exchange, saves and the UI never see
  surprise shapes.
- Schema must stay thin and fast to respond; it does not design systems, it records their contracts.
