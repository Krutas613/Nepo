# ADR-001: Engine-owned seeded RNG (xoshiro128**) with named sub-streams

**Status:** Accepted (Milestone 0)

## Context

Rule 2 requires identical outcomes for identical seed and inputs. Systems are built by different
agents and added over several milestones; if they shared one random stream, adding a system (or
reordering draws inside one) would change every other system's behaviour and invalidate regression
snapshots. The generator must be exact in JavaScript without `bigint`, serializable, and cheap.

## Decision

- The engine owns all randomness. The generator is **xoshiro128\*\***: four 32-bit words, implemented
  with `Math.imul`, `>>>` and rotates only. It is small, fast and statistically strong; 128-bit state is
  ample for a game. PCG32 was rejected because its 64-bit multiply needs `bigint` or manual carry in JS.
- Streams are named. A stream's initial state is `splitmix32(mix(seed, fnv1a32(name)))`, so it depends
  only on `(seed, name)`. Default stream per system is `${systemId}`; sub-streams are `${systemId}/${sub}`
  and are created lazily on first use.
- Stream states live in `WorldState.rng` and are therefore snapshotted and hashed.
- `nextU32()` is the sole primitive; `nextFloat`, `int`, `pick`, `shuffle`, `chance` are specified in
  terms of it (docs/design/engine.md) so a reimplementation produces identical sequences.
- Banned: `Math.random`, `Date`, `performance.now`, `crypto.*`, timers (ESLint enforced).

## Consequences

- Adding, removing or reordering systems never perturbs another system's random sequence.
- Restoring a snapshot continues the exact sequence; lazily created streams are reproduced because
  seeding ignores run history.
- Systems must draw in a deterministic order (sorted keys) or they break determinism even with a
  perfect RNG; the slice-ownership and hash tests catch this indirectly.
