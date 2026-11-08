# @nepo/sim-tests

Headless sweeps, the invariant suite, property tests and regression snapshots for the Nepo sim.
Owned by the `qa` agent. Node-only: it may use `performance.now`, `node:fs` etc.

## Running the sweep

```
pnpm sweep -- --seeds 5 --years 5
```

| Flag                  | Meaning                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `--seeds N` / `a,b,c` | `N` seeds `1..N`, or an explicit comma list. Default `5`.                                        |
| `--years N`           | Simulated years (360 ticks each). Default `5`.                                                   |
| `--scenario`          | `smoke` (default) or `empty`. Systems are always `[accountingSystem]` at M0.                     |
| `--hash-every N`      | Hash state every N ticks (default `1`; `0` = final hash only).                                   |
| `--check-ownership`   | Enable the engine's slice-ownership check on every step (slower).                                |
| `--no-repeat`         | Skip the second run per seed (the repeat-run hash comparison is on by default).                  |
| `--json <path>`       | Write the full result as JSON.                                                                   |
| `--update-snapshots`  | Rewrite `src/regression/hashes.json` (only for `--scenario smoke --years 5`, and only if clean). |

Per seed the sweep: (1) runs the world with every active invariant checked after init and after every
tick, hashing as configured; (2) runs it again and compares the hash sequences (and final hash);
(3) snapshots at the midpoint through JSON text, restores, and compares hashes tick by tick.
Exit code is 1 on any violation or hash mismatch, and the last line is `PASS` or `FAIL`.
Cost is about 20 s per seed for 5 years with per-tick hashing.

Output: one table row per seed (`seed ticks final-hash cash entries reports ms violations`), the list of
SKIPPED invariants, one `VIOLATION seed= tick= <invariant> entity=: detail` line per violation (first 20
per seed), then PASS/FAIL.

## Invariants (ARCHITECTURE.md section 13)

| Id                     | Check                                                                                                                    | Status                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `1-ledger`             | Per-entity Σ balance === 0; every entry balanced (`checkLedgerInvariants`)                                               | active                              |
| `2-balance-sheet`      | A = L + E (balance-sheet helper and raw balances); `netChange === closing - opening` and report identity on every report | active                              |
| `3-non-negative`       | No negative quantities; no negative cash without credit                                                                  | stubbed, until M1 (reports SKIPPED) |
| `4-goods-conservation` | Goods conserved across production, transit, sales                                                                        | stubbed, until M1/M2                |
| `5-finite`             | `findNonFinite(state)` is empty                                                                                          | active                              |
| `6-hash-stability`     | Identical hash sequence across repeat runs; snapshot/restore equivalence                                                 | active (sweep + tests)              |
| `7-economic-sanity`    | Bounded volatility, no collapse, no runaway inflation                                                                    | stubbed, until M2                   |

Stubs are reported as SKIPPED, never green. Invariants must never be weakened or deleted to make a
run pass: a failure is routed to the owner of the offending slice (the `owner` field of the
invariant; `1`/`2` are `packages/sim/src/accounting`, `5` is whichever system owns the path in the detail).

## `--json` output shape (for qa-triage)

```
{ scenario, years, hashEvery, pass,
  results: [{ seed, ticks, finalHash, hashes: string[], durationMs,
              metrics: { ticks, totalCash, journalEntries, reports, companies },
              skipped: [{ invariant, reason }],
              violations: [{ invariant, seed, tick, entity?, detail }] }] }
```

To reproduce a violation: `pnpm sweep -- --seeds <seed> --years <ceil(tick/360)> --scenario <scenario>`.

## Tests

`pnpm --filter @nepo/sim-tests test` (about 100 s): exit criteria (5 seeds x 5 years, smoke and empty),
snapshot equivalence (400 then 1800 ticks), slice ownership (1 seed x 1 year), corruption tests proving
every active invariant can fail, a fast-check determinism property, and the regression snapshot.

## Regression hashes

`src/regression/hashes.json` holds the final state hash per seed (1..5, 5 years, `SMOKE_SCENARIO`,
`[accountingSystem]`). A changed hash means observable sim behaviour changed. That is sometimes
intended (new state, new entries) but must be a deliberate, reviewed update: explain the cause in the
PR, then run `pnpm sweep -- --seeds 5 --years 5 --update-snapshots` (or `UPDATE_SNAPSHOTS=1 pnpm --filter
@nepo/sim-tests test regression`). Never update it to silence an unexplained change.

## Caveat: snapshot schema and test systems

The v1 snapshot schema is strict and rejects unknown slices. A test system registered under a real
`SystemId` other than `accounting` adds a slice that makes `snapshot`/`restore` fail. For
snapshot-equivalence tests use accounting-only worlds (or no systems). `restore` also needs
`{ scenario }` (REQ-001) because snapshots do not carry the scenario.
