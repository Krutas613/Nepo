# ADR-003: Commands in, events out; player and AI use the same commands

**Status:** Accepted (Milestone 0)

## Context

Rule 3: state changes only through typed commands processed in the tick loop; systems emit typed
events. The AI must not cheat through private APIs, the UI must not mutate state, and tests must be
able to replay exactly what happened. Command ordering must not depend on map iteration or issuer.

## Decision

- `Command` is a flat discriminated union in schema: `{ type, seq, tick, issuer: CompanyId, payload }`.
  `submit()` validates shape with zod immediately (invalid -> returned error, nothing queued), stamps a
  global monotonic `seq` and the processing `tick`, and appends to `WorldState.pendingCommands`.
- The `ingest` phase drains the queue in ascending `seq` only. Each command type has exactly one
  handling system (declared in `System.handles`, duplicates rejected at `createWorld`). Semantic
  failures in `apply` become `command.rejected` events; nothing is thrown for user mistakes.
- A command is applied fully or rejected fully.
- The AI system submits commands only through `ctx.submit` in the `decide` phase; they queue for the
  next tick exactly like the player's. There is no AI-only mutation path.
- Events are a flat union `{ type, tick, seq, source, payload }`, appended per tick, returned by
  `step`; they are observations, not a state channel (see ADR-007).

## Consequences

- Replays and tests are a list of `(tick, command)`; `pendingCommands` being in state makes snapshots
  self-contained.
- A command issued during tick t takes effect at the start of tick t+1; the UI should present this as
  "orders are executed next day".
- Systems never call each other's command handlers; they call service APIs or issue nothing.
