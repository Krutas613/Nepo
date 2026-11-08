# Engine design notes (Milestone 0)

Companion to ARCHITECTURE.md sections 3, 5, 6, 9, 10, 11. Owner of the code: `engine`. This file
pins the algorithms whose exact outputs become part of regression snapshots.

## 1. RNG: xoshiro128** and seeding

State `s = [s0, s1, s2, s3]`, each a u32 (`>>> 0`). `rotl(x, k) = ((x << k) | (x >>> (32 - k))) >>> 0`.

```
nextU32():
  result = imul(rotl(imul(s1, 5) >>> 0, 7), 9) >>> 0
  t  = (s1 << 9) >>> 0
  s2 ^= s0;  s3 ^= s1;  s1 ^= s2;  s0 ^= s3      (all >>> 0)
  s2 ^= t
  s3 = rotl(s3, 11)
  return result
```

Seeding a stream `name` from world `seed` (non-negative safe integer):

```
lo = seed >>> 0;  hi = Math.floor(seed / 2^32) >>> 0
h  = fnv1a32(name)                       // over UTF-16 code units, low byte then high byte
x  = (lo ^ h) >>> 0;  x = (x ^ rotl(hi, 13)) >>> 0
sm = splitmix32(x);  s = [sm(), sm(), sm(), sm()]
if all four are 0: s[0] = 1
```

`splitmix32(a)` returns a function that each call does: `a = (a + 0x9e3779b9) | 0; t = a ^ (a >>> 16);
t = imul(t, 0x21f0aaad); t = t ^ (t >>> 15); t = imul(t, 0x735a2d97); return (t ^ (t >>> 15)) >>> 0`.

Derived operations (all must use only `nextU32`):

- `nextFloat()`: `hi = nextU32(); lo = nextU32(); return ((hi >>> 5) * 67108864 + (lo >>> 6)) * 2^-53`.
- `int(min, max)`: both integers, `min <= max` (else InvariantError). `range = max - min + 1`;
  if `range === 1` return `min` without drawing; `limit = 2^32 - (2^32 % range)`; loop `u = nextU32()`
  until `u < limit`; return `min + (u % range)`.
- `pick(items)`: `items[int(0, items.length - 1)]`; empty -> `InvariantError('rng.pick_empty')`.
- `shuffle(items)`: `for i = n-1 down to 1: j = int(0, i); swap(i, j)`; returns the same array.
- `chance(p)`: `nextFloat() < p` (p outside [0,1] clamps; `p <= 0` still consumes a draw for stability).

Known-answer test: the engine test fixes `s = [1, 2, 3, 4]` and asserts the first four `nextU32`
outputs against values computed from the reference C implementation (compute once with a scratch script
and hard-code them). A second KAT pins `seedStream(42, 'accounting')`.

The `Rng` object handed to systems is a thin wrapper that reads and writes `state.rng[name].s` in
place, so no state lives outside `WorldState`.

## 2. Registry

`state.registry.counters[kind]` is incremented and formatted `${prefix}_${padStart(6,'0')}`. IDs
are never reused; deleting an entity leaves a gap.

## 3. Step algorithm

```
step(world, opts):
  invariant(!world.inStep)
  tick = state.tick; date = calendarFromTick(tick, state.epochYear); events = []
  // ingest
  batch = state.pendingCommands; state.pendingCommands = []      // already ascending seq
  inbox: Record<SystemId, Command[]> = {}
  for cmd of batch:
    if !(cmd.issuer in state.companies): emit command.rejected(unknown_issuer); continue
    sys = routing[cmd.type]; if !sys: emit command.rejected(no_handler); continue
    inbox[sys].push(cmd)
  // phases 1..8
  for phase of PHASE_ORDER[1..8]:
    for system of systems (SYSTEM_ORDER):
      fn = system.phases[phase]; if !fn continue
      if opts.checkSliceOwnership: before = hash of every slice except system.id (+ core fields)
      fn(makeTickContext(system, phase, inbox[system.id] ?? [], events))
      if opts.checkSliceOwnership: compare -> InvariantError('slice.foreign_write', {system, phase, slice})
  // finalize
  if opts.checkFinite: paths = findNonFinite(state); if paths.length: InvariantError('state.non_finite', {paths})
  state.tick += 1; world.lastEvents = events
  return { tick, date, events }
```

`ctx.submit` during a step stamps `tick: state.tick + 1` and appends to `state.pendingCommands`; it
throws `InvariantError('commands.submit_outside_decide')` unless `phase === 'decide'`. `ctx.reject`
emits `command.rejected` with `source = system.id`. Event `seq` is `events.length` at emission.

The `core` system (`id: 'core'`, slice is `state.companies`) is implemented inside the engine, is
always registered first, handles `company.rename` (reject `not_owner` if `issuer !== companyId`,
`invalid_name` if empty after trim), and in `init` creates companies from `scenario.companies` in
array order with `foundedTick: 0`, `parentId: null`.

## 4. Canonical JSON and hash

See ADR-008. Implementation notes: build output with an array of parts and `join('')` (string
concatenation in a loop is quadratic in some engines); recursion depth is bounded by state shape (no
cycles are possible in plain data, but detect them with a `WeakSet` and throw `canon.cycle`).
`hashState(state) = fnvDual(canonicalJson(state))`. Publish `hashString(s: string): string` as well
so qa can fingerprint arbitrary strings (and the KAT can pin `hashString('nepo')`).

## 5. Snapshot and restore

`snapshot(world)`: `state = JSON.parse(canonicalJson(world.state))`; return
`{ format: 'nepo/snapshot', schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, hash: hashState(state), state }`.

`restore(snap, systems)`: `SnapshotSchema.parse` (throw `SnapshotError('invalid')` on failure);
`if snap.schemaVersion > SCHEMA_VERSION` -> `SnapshotError('too_new')`; run migrations from
`snap.schemaVersion` to `SCHEMA_VERSION` (each step is `(state: unknown) => unknown`; missing step ->
`SnapshotError('no_migration')`); if no migration ran and `hashState(state) !== snap.hash` ->
`SnapshotError('hash_mismatch')`; build `World` with the given systems **without calling `init`**
(slices come from the snapshot), create services, `lastEvents = []`.

## 6. Test matrix (engine)

| Test | Assertion |
|---|---|
| rng KAT | first 4 outputs for fixed state and for `seedStream(42,'accounting')` |
| rng independence | drawing from `economy` does not change the next value of `accounting` |
| int unbiased-ish | fast-check: outputs within `[min,max]`; `range===1` draws nothing |
| calendar | ticks 0, 29, 30, 89, 90, 359, 360, 719 map to expected dates and flags |
| canonical JSON | key order, `-0`, nested arrays, rejection of Map/undefined/NaN |
| hash KAT | `hashString('')` and `hashString('nepo')` pinned |
| determinism | 2 fresh worlds (SMOKE_SCENARIO, no systems), 200 ticks, equal hash each tick |
| snapshot equivalence | snapshot at 73, restore, run to 200, hash equals uninterrupted run |
| commands | ordering by seq across issuers; unknown_issuer; no_handler; shape error from submit |
| phases | recording test system sees phases 1..8 in order, systems in SYSTEM_ORDER |
| ownership | test system writing a foreign slice under `checkSliceOwnership` throws |
