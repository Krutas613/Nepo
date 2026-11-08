# ADR-004: One plain-data WorldState with owned slices; no Maps, classes or functions in state

**Status:** Accepted (Milestone 0)

## Context
Save/load, hashing, determinism tests and the UI all need the whole simulation as data. Systems built
by separate agents need a clear boundary for what they may write. `Map`/`Set` iteration order is
insertion order, which is a hidden dependency on history; class instances and closures hide state
from serialization.

## Decision
- Exactly one `WorldState` object (schema `world.ts`): engine core fields (`seed`, `tick`,
  `epochYear`, `commandSeq`, `pendingCommands`, `registry`, `rng`, `companies`) plus one named slice
  per system (`accounting`, later `economy`, ...). Slice types are shared types and live in schema.
- Plain JSON data only: no classes, functions, `Map`, `Set`, `Date`, `bigint`, `undefined`.
  Keyed collections are `Record<Id, T>` iterated via `sortedKeys`; ordered collections are arrays with
  a documented order.
- A system writes only its own slice (`ctx.slice`); it reads others through `DeepReadonly` views.
  The engine's debug option `checkSliceOwnership` hashes foreign slices around each phase and throws on
  a change.
- Runtime containers (`World`, services, `Rng` wrappers) may be classes or closures but hold no state
  that is not derivable from `WorldState`; snapshot/restore equivalence tests enforce this.
- Events are not part of state (ADR-007).

## Consequences
- `snapshot()` is `JSON.parse(canonicalJson(state))`; no custom serializers.
- Adding a system means adding a required slice property (schema version bump + migration that
  initialises it).
- Large append-only logs (the journal) grow state and hashing cost; a retention policy is a
  Milestone 2 decision.
