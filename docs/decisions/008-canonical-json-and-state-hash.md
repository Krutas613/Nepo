# ADR-008: Canonical JSON serialization and a dual-lane FNV-1a 32 state hash

**Status:** Accepted (Milestone 0)

## Context
Determinism is proven by comparing state fingerprints across runs and after snapshot/restore. The
fingerprint must be identical across JS engines and browsers, dependency-free, fast enough to run every
tick in sweeps, and stable forever because it becomes part of regression snapshots. `JSON.stringify`
is unsuitable: key order follows insertion order.

## Decision
- `canonicalJson(value)`: recursive; object keys sorted by UTF-16 code-unit order; arrays in order;
  strings via `JSON.stringify`; numbers via `String(n)` (ECMAScript fully specifies `Number::toString`);
  `-0` written as `0`; throws `InvariantError('canon.unsupported')` for `undefined`, functions, symbols,
  `bigint`, `Map`, `Set`, `Date`, non-plain objects and non-finite numbers.
- `hashState(state)`: two independent FNV-1a 32 lanes over the UTF-16 code units of the canonical
  string (low byte then high byte per unit), offset bases `0x811c9dc5` (A) and `0xcbf29ce4` (B), prime
  `0x01000193` via `Math.imul`; output is 16 lowercase hex characters `A||B`. Chosen over FNV-1a 64
  (needs `bigint` or manual carries, several times slower) and over xxHash/Murmur (more code, no
  benefit for equality checks). It is a regression fingerprint, not a cryptographic hash.
- The algorithm is frozen after Milestone 0; changing it requires a new ADR and regenerating
  regression snapshots.

## Consequences
- Any state the canonicaliser rejects is also a determinism hazard, so `snapshot()` using
  `JSON.parse(canonicalJson(state))` doubles as a serializability test.
- Hashing is O(state size); `step()` never hashes unless asked, and long sweeps may hash at period
  ends only (qa's call) while short determinism tests hash every tick.
