# Player flow and UI contract (Milestone 1)

Owner of the code: `ui` (`packages/ui`), plus the orchestrator for the sim root (`packages/sim/src/index.ts`).
Companion to ARCHITECTURE.md sections 1, 6.3, 7, 11 and ADR-003/010. The UI imports **only** from
`@nepo/sim` (root: schema + engine flattened, domain namespaces `accounting`, `economy`, ...). It
never imports deep paths, never mutates `world.state`, and the sim never learns about wall-clock time.

## 1. The M1 game loop (what a human does)

1. **Start.** Pick the scenario `vertical_slice` (one player company, starting cash, one city).
   World is created at tick 0; the dashboard shows cash = starting cash, an empty P&L, no assets.
2. **Build.** Order a factory (`facility.build`) and a store (`store.build`) in the city. Cash drops
   by capex immediately (PP&E on the balance sheet); both are "under construction" for
   `constructionTicks` days.
3. **Fund.** Ask the bank for a term loan (`loan.request`), guided by `FinanceApi.quoteLoan` /
   `availableCredit` previews. Cash rises, Loans Payable appears.
4. **Configure.** Set the factory recipe and production target (`facility.set_recipe`,
   `facility.set_production`), the store's restock policy pointing at the factory
   (`store.set_restock_policy`) and a price (`store.set_price`, or leave `null` to follow the market).
5. **Run.** Play at 1x/5x/30x days per second; watch raw purchases, production, restocks, sales,
   reference price vs own price, daily opex, month-end interest/payment/depreciation.
6. **Read the books.** Month-end statements (P&L, balance sheet, cash flow) appear in the reports
   list; a year-end closing entry zeros income accounts into retained earnings.
7. **Save/load** at any tick; a restored game continues identically (hash-equal).

Commands take effect at the start of the next tick (ADR-003); the UI labels them "executes tomorrow"
and shows `command.rejected` events with their `code`/`reason` in the event log and inline.

## 2. Loading content and the scenario (ADR-010)

```ts
import { assembleContentPack, ScenarioSchema, type Scenario, type ContentFiles } from '@nepo/sim';
// Vite JSON imports (or import.meta.glob) of data/products.json, recipes.json, facility_types.json,
// store_formats.json, regions.json, cities.json, markets.json, economy/{pricing,macro,commodities}.json,
// finance/banks.json, scenarios/vertical_slice.json
const files: ContentFiles = {
  products,
  recipes,
  facilityTypes,
  storeFormats,
  regions,
  cities,
  markets,
  pricing,
  macro,
  commodities,
  banks,
};
const content = assembleContentPack(files); // Result; show issues on failure
const scenario: Scenario = { ...ScenarioSchema.parse(scenarioFile), content: content.value };
```

The scenario file omits `content`; the UI (and tools/sim-tests) attach the pack. Seed: user-chosen
or a fixed default; display it (it is the replay key).

## 3. Read/dispatch interface

```ts
import {
  createWorld,
  step,
  submit,
  snapshot,
  restore,
  hashState,
  DEFAULT_SYSTEMS,
  type World,
  type Event,
} from '@nepo/sim';
const world = createWorld({ seed, scenario, systems: DEFAULT_SYSTEMS });
const result = step(world); // one day; result.events === world.lastEvents
const seq = submit(world, {
  type: 'store.set_price',
  issuer: playerId,
  payload: { storeId, productId, price },
});
```

- **Read:** `world.state` (typed slices: `economy`, `manufacturing`, `retail`, `finance`,
  `accounting`, `companies`), `world.scenario.content`, `world.lastEvents`. Read-only by convention; the
  UI copies nothing into its own model except an event buffer and chart series. Services are not
  reachable from outside the sim; previews use pure helpers exported by the domain barrels
  (`finance.assessLoan(...)`, `economy.expectedCaptureFor(state, content, ...)`, `accounting.balanceSheet(ledger)`).
- **Dispatch:** `submit` only. Shape errors come back synchronously (`Result`); semantic rejections
  arrive as `command.rejected` events after the next `step`.
- **Player company:** `Object.values(world.state.companies)` sorted by id, first with `controller === 'player'`
  (M1 has exactly one).

## 4. Time controls (UI owns the clock)

A `GameClock` in the UI holds `{ running: boolean; ticksPerSecond: 1 | 5 | 30; accumulator }` and
uses `requestAnimationFrame`: each frame it steps `floor(elapsed × ticksPerSecond)` times (capped at
60 per frame to stay responsive), appends `result.events` to a ring buffer (cap 10 000), and
re-renders. "Step" = one `step`. "Pause" stops the loop. Nothing in the sim depends on real time; a
background tab that stalls simply resumes. If `step` throws (`InvariantError`), the UI pauses,
shows `seed`, `tick` and `code`, offers "export snapshot" of the last good save, and disables
stepping (the world is poisoned).

## 5. Dashboard (minimum views)

| View                | Source                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header              | date (`calendarFromTick(state.tick, state.epochYear)` as `Y3 M07 D12`), cash (`ledger.accounts['1000'].balance`), speed controls, save/load                                                    |
| P&L (month to date) | `accounting.incomeStatement(ledger, ledger.monthOpening)`; prior months from `ledger.reports`                                                                                                  |
| Balance sheet       | `accounting.balanceSheet(ledger)` with `byAccount` rows named from `STANDARD_CHART`                                                                                                            |
| Cash flow           | latest `month`/`quarter`/`year` report `cashFlow`                                                                                                                                              |
| Factory             | `state.manufacturing.facilities[id]`: status, recipe, target vs started, WIP, input/output lots (quantity, value, derived unit cost), `starvedReason`; commands `set_recipe`, `set_production` |
| Store               | `state.retail.stores[id]`: status, shelf lines (stock, price or "market"), today's sold/revenue/stockout, restock policy; commands `set_price`, `set_restock_policy`                           |
| Market              | `state.economy.markets[m].products[p]`: reference price, level, demand today/remaining, yesterday's sold; chart series buffered by the UI per tick; commodity price                            |
| Bank                | `state.finance.loans` for the player, credit status; loan request form with live quote (pure helper); `loan.repay`                                                                             |
| Build               | facility types and store formats from `scenario.content` with cost, construction days, opex; city selector (M1: one)                                                                           |
| Event log           | buffered `Event`s with filters by `type` prefix; `command.rejected` highlighted                                                                                                                |

Money is formatted from minor units by the UI (`1234567 -> 12,345.67`); the sim never formats.

## 6. Save / load

`const text = JSON.stringify(snapshot(world))` to `localStorage` (`nepo/save/<slot>`) and as a file
download; load with `restore(JSON.parse(text), DEFAULT_SYSTEMS)` (handles `SnapshotError`
`invalid`/`too_new`/`no_migration`/`hash_mismatch`/`scenario_mismatch` with a message). The content
pack is inside the snapshot's `scenario`, so a save loads without the data files. After load the UI
shows `hashState(world.state)` so a player can compare two runs.

## 7. Sim root composition (orchestrator applies; `packages/sim/src/index.ts`)

```ts
export * from './schema/index.js';
export * from './engine/index.js';
export * as accounting from './accounting/index.js';
export * as economy from './economy/index.js';
export * as manufacturing from './manufacturing/index.js';
export * as retail from './retail/index.js';
export * as finance from './finance/index.js';
import { accountingSystem } from './accounting/index.js';
import { economySystem } from './economy/index.js';
import { manufacturingSystem } from './manufacturing/index.js';
import { retailSystem } from './retail/index.js';
import { financeSystem } from './finance/index.js';
/** Every shipped system, in SYSTEM_ORDER (the engine re-sorts anyway). */
export const DEFAULT_SYSTEMS: readonly AnySystem[] = [
  accountingSystem,
  economySystem,
  manufacturingSystem,
  retailSystem,
  financeSystem,
];
```

Each domain barrel exports `<domain>System`, `<DOMAIN>_SERVICE`, `<Domain>Api`, its
`check<Domain>Invariants`, and the pure helpers the UI previews with. sim-tests switches its default
`systems` to `DEFAULT_SYSTEMS` and adds `--scenario vertical_slice` (loaded from `data/` with `node:fs`).

## 8. Invariants qa will check

- UI package imports resolve only to `@nepo/sim` (lint rule `no-restricted-imports` for
  `@nepo/sim/src/*` and relative paths into `packages/sim`).
- A scripted "human run" in sim-tests (`exit-criteria.test.ts`): the command sequence of section 1
  over 360 ticks on 5 seeds produces: a factory and store operating, `store.sold` events, a loan with
  12 payments or fewer, 12 month reports with `revenue > 0` after the store opens, and every
  invariant green. This is the M1 exit criterion in executable form.
- `snapshot` → `restore` → continue equals the uninterrupted run (already in the sweep).

## 9. Tests the owner must ship

- `GameClock` unit test with a fake frame scheduler: N frames at 5x step exactly `floor(elapsed × 5)`
  times; pause stops; step advances one tick; a throwing `step` pauses and marks poisoned.
- Content loading: `assembleContentPack` on the checked-in `data/` succeeds; an injected bad file
  surfaces the issue list.
- Command forms produce the exact `CommandInput` shapes (snapshot tests against `CommandInputSchema`).
- Save/load round trip in a jsdom test: hash before === hash after restore.
