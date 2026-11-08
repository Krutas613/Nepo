# ADR-007: Cross-system effects go through service APIs; events are ephemeral observations

**Status:** Accepted (Milestone 0)

## Context
Systems must not mutate each other's slices, yet manufacturing must post costs, retail must query
demand, finance must read consolidated statements. Two designs were considered: (a) systems emit
events that other systems consume next phase/tick; (b) systems expose a narrow synchronous API that
mutates only their own slice. Event-driven coupling makes money movement asynchronous (an inventory
change in one phase, the posting a phase later), bloats state if the log is persisted, and makes
ordering subtle.

## Decision
- A system may expose a **service**: an object created once per world by `System.createService(handle)`
  and registered under a branded `ServiceKey<T>` (e.g. `ACCOUNTING_SERVICE: ServiceKey<AccountingApi>`).
  Callers obtain it via `ctx.services.get(key)`. Service methods run synchronously inside the caller's
  phase and mutate only the owning system's slice. The engine knows nothing about specific services, so
  dependency direction stays schema <- engine <- accounting <- domains.
- Events are an append-only per-tick log returned from `step` and readable within the same tick via
  `ctx.events`. They are **not** stored in `WorldState`, not hashed, and never the channel through which
  one system's state reaches another across ticks. Anything needed later must be in a slice.
- Reads of other systems happen through `ctx.state` (`DeepReadonly`) or the owner's service.

## Consequences
- Money movement is atomic with the business event that caused it (post inside the same phase).
- Service call order is deterministic because callers run in fixed phase/system order.
- Services hold no state outside their slice (snapshot/restore equivalence enforces this).
- The AI reads `ctx.events` in `decide` for same-tick signals; the UI keeps its own event buffer.
