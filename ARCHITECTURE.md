# Nepo Architecture

Owner: `architect`. This document is the contract between the `schema`, `engine`, `accounting` and `qa`
agents (and every later domain agent). BUILD_INSTRUCTIONS.md section 3 is law; this document says
how the law is implemented. Where it says **must**, an implementation that differs is a bug. Where it
says **implementer's call**, the owning agent decides and documents the choice in its module README or
a code comment.

Decisions with rationale live in `docs/decisions/` (ADR-001 .. ADR-014). Deeper per-module detail lives
in `docs/design/` (`engine.md`, `accounting.md`; M1: `economy.md`, `manufacturing.md`, `retail.md`,
`finance.md`, `player-flow.md`, and the consolidated schema request `schema-m1.md`).

---

## 1. Module map and dependency direction

```
schema  <-  engine  <-  accounting  <-  {economy, manufacturing, logistics, retail, finance, hr}  <-  ai
                                                                                                      ^
packages/ui, packages/tools, packages/sim-tests  ---- import only from @nepo/sim public surface -----+
```

An arrow `A <- B` means B may import A. Nothing imports in the other direction. Concretely:

| Directory (`packages/sim/src/...`)                        | Owner                           | May import                                                                                                                                                                                                                                                                               | Exports (public surface via `index.ts`)                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema/`                                                 | schema                          | `zod` only                                                                                                                                                                                                                                                                               | Brands/IDs, `Money`, `Quantity`, `Result`, errors, `SystemId`, `Company`, `Scenario`, `WorldState` and all slice types, `Command`/`Event` unions, zod validators, fixtures                                                                                                                                                                                      |
| `engine/`                                                 | engine                          | schema                                                                                                                                                                                                                                                                                   | `createWorld`, `step`, `submit`, `snapshot`, `restore`, `hashState`, `canonicalJson`, `findNonFinite`, `calendarFromTick`, `Rng`, `System`, `TickContext`, `Phase`, `ServiceKey`, `sortedKeys`, `DeepReadonly`, `ENGINE_VERSION`, plus the helpers its `index.ts` lists (`coreSystem`, `hashString`, `migrateSnapshot`, RNG primitives, `isWorldPoisoned`, ...) |
| `accounting/`                                             | accounting                      | schema, engine                                                                                                                                                                                                                                                                           | `accountingSystem`, `ACCOUNTING_SERVICE`, `AccountingApi`, `ACCOUNTS`, `STANDARD_CHART`, rounding helpers, entry builders, `checkLedgerInvariants`, and the pure ledger/statement functions (for tests and tools; systems go through the service)                                                                                                               |
| `economy/ manufacturing/ logistics/ retail/ finance/ hr/` | each its agent                  | schema, engine, accounting, and the `index.ts` of systems **earlier in `SYSTEM_ORDER`** for their service key + API (M1: manufacturing and retail import `economy`; retail imports `manufacturing` for `withdraw`; finance imports `economy` for the policy rate). Never a later system. | its `System` object, its `ServiceKey` + API, its `check<Domain>Invariants`, pure helpers for previews                                                                                                                                                                                                                                                           |
| `ai/`                                                     | ai-competitors                  | schema, engine, and any system's public API                                                                                                                                                                                                                                              | `aiSystem`                                                                                                                                                                                                                                                                                                                                                      |
| `index.ts` (sim root)                                     | orchestrator (composition root) | everything above                                                                                                                                                                                                                                                                         | `export *` of **schema and engine only**; each domain module as a namespace (`export * as accounting from './accounting/index.js'`); `DEFAULT_SYSTEMS` (M1)                                                                                                                                                                                                     |

Rules:

- `packages/sim` never imports `packages/ui`, React, Vite, or `node:*`. ESLint enforces it.
- A system imports another system **only through its `index.ts`** (`@nepo/sim/accounting`, not
  `../accounting/ledger.js`). Relative imports inside the sim use `.js` extensions.
- **Public-surface policy.** The sim root flattens exactly two modules, schema and engine, because
  every consumer needs both and they form one vocabulary (`WorldState`, `createWorld`, `Money`, ...).
  Every domain module (accounting, economy, ...) is reachable in two ways only: its subpath
  (`@nepo/sim/accounting`, the primary route for sim-internal imports, sim-tests and tools) and the
  same-named namespace on the root (`import { accounting } from '@nepo/sim'; accounting.cashSale(...)`).
  Domain barrels are therefore free to export generic names (`payroll`, `depreciation`, `postEntry`)
  without cross-module clashes. Two naming rules still apply: (1) an identifier exported by schema or
  engine is unique between those two modules and is never re-exported by a domain module; (2) the
  three identifiers consumers compose with are prefixed with the module name regardless (`accountingSystem`,
  `ACCOUNTING_SERVICE`, `AccountingApi`; later `economySystem`, `ECONOMY_SERVICE`, `EconomyApi`).
  `DEFAULT_SYSTEMS` (root, M1) is the ordered array of every shipped `System` object.
- Shared types live only in `schema/`. A system's slice type (`AccountingState`, later `EconomyState`)
  is a shared type because the UI and sim-tests read it, so it lives in `schema/` too. Systems request
  changes via `docs/schema-requests.md` (section 14).
- `packages/sim-tests` composes the world explicitly (`createWorld({ seed, scenario, systems: [accountingSystem] })`)
  until `DEFAULT_SYSTEMS` exists in the sim root.

---

## 2. World state model

There is exactly one state object per simulation, `WorldState`, defined in `schema/world.ts`. It is
plain data: JSON-serializable, no classes, no functions, no `Map`/`Set`/`Date`/`bigint`/`undefined`
values (optional fields are omitted, never set to `undefined`; `null` is allowed).

```ts
// schema/world.ts
interface WorldState {
  seed: number; // non-negative safe integer; the world seed
  tick: number; // ticks completed = the tick `step` will execute next
  epochYear: number; // calendar year of tick 0 (from scenario)
  commandSeq: number; // last issued command sequence number (global, monotonic)
  pendingCommands: Command[]; // queued for the next tick's ingest phase, ascending seq
  registry: RegistryState; // ID counters (section 3)
  rng: Record<string, RngStreamState>; // stream name -> state (section 9)
  companies: Record<CompanyId, Company>; // core slice, owned by the engine's `core` system
  accounting: AccountingState; // owned by accounting (section 8)
  economy: EconomyState; // M1 (schema v2): markets, commodity sources, macro indices
  manufacturing: ManufacturingState; // M1: facilities, WIP, input/output lots
  retail: RetailState; // M1: stores, shelf lots, prices, restock policies
  finance: FinanceState; // M1: loans, credit status
  // M2: logistics; M3: ai; M4: hr. Each is added by the schema agent as a new required property
  // (a schema version bump + migration that installs the slice's EMPTY_ value).
}
```

Content (products, recipes, cities, tunables) is **not** state: it travels in `Scenario.content`
(ADR-010), is validated by `assembleContentPack`, and is read by systems through `ctx.scenario.content`.

Slice ownership: the system with `id: 'accounting'` is the only code that writes `state.accounting`;
likewise for every other slice. The engine owns the non-slice fields and `companies` (through its
built-in `core` system). Cross-system effects happen only through (a) a read-only view of other
slices, (b) calling the owning system's **service API** (section 6), or (c) **commands** (section 7).
Events do not carry state between systems (ADR-007).

Slice keys and typing (**must**). The slice key of a system is its `SystemId` (`core` -> `companies`);
`SystemId` is a closed union owned by schema, so the set of possible top-level keys of `WorldState` is
fixed. A slice is **typed** once schema has added it to the `WorldState` interface and
`WorldStateSchema` (today: `companies`, `accounting`). A typed slice is always present in state: if its
system is not registered, the engine fills it with the empty value schema exports for it (today
`{ entities: {}, journal: [] }` for accounting; schema will export these as `EMPTY_<SLICE>` constants
so the engine never hand-writes a slice shape). A slice whose type has **not** landed yet may still
appear in state under its `SystemId` key (a test system, or a domain agent's work in progress):
`WorldStateSchema` accepts it as `unknown` plain JSON, validates nothing inside it, and rejects any
top-level key that is not a `SystemId` or an engine core field (section 11 and 14 give the rules this
implies for saves and migrations). Contracts-first still holds for shipped code: a domain system does
not merge into `DEFAULT_SYSTEMS` until its slice is typed.

Collections rule (**must**):

- Keyed collections are `Record<Id, T>` objects. Iteration is always over `sortedKeys(record)`
  (engine utility: `Object.keys(r).sort()`, i.e. UTF-16 code-unit order). Never `for...in`
  (lint-banned), never `Object.values`/`Object.entries` without sorting.
- Ordered collections are arrays with a stable, documented order (append-only logs, ascending `seq`).
- Record keys are never integer-like strings (`/^\d+$/`): V8 stores them as sparse dictionary elements
  (enumeration ~15x slower, measured in M0) and JS enumerates them numerically. Account codes are
  therefore stored as `'a1000'` from schema v2 (`docs/design/schema-m1.md` section 10); docs write `1000`.
- `Map` and `Set` are forbidden in state. They may be used as transient locals inside one phase if
  the result does not depend on their iteration order.

Numbers in state: integers for money, quantities, counts, ticks, seqs, IDs; `number` floats only for
ratios/indices/probabilities (section 10). `NaN`, `Infinity`, `-Infinity` and `-0` are forbidden
anywhere in state; the engine's `findNonFinite(state)` returns the JSON paths of offenders and
sim-tests calls it every tick.

---

## 3. Identifiers

All IDs are branded strings. Schema exports the brand helper and one brand per entity kind:

```ts
// schema/ids.ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

type CompanyId      = Brand<string, 'CompanyId'>;      // runtime-issued: co_000017
type FacilityId     = Brand<string, 'FacilityId'>;     // fa_
type StoreId        = Brand<string, 'StoreId'>;        // st_
type WarehouseId    = Brand<string, 'WarehouseId'>;    // wh_
type LoanId         = Brand<string, 'LoanId'>;         // ln_
type ContractId     = Brand<string, 'ContractId'>;     // ct_
type ShipmentId     = Brand<string, 'ShipmentId'>;     // sh_
type JournalEntryId = Brand<string, 'JournalEntryId'>; // je_
type ProductId      = Brand<string, 'ProductId'>;      // authored in data/: ^[a-z][a-z0-9_]*$
type RecipeId, RegionId, CityId, MarketId, StoreFormatId = same, authored slugs
type AccountCode    = Brand<string, 'AccountCode'>;    // 4 digits, e.g. '1000' (section 8)

type EntityKind = 'company' | 'facility' | 'store' | 'warehouse' | 'loan' | 'contract' | 'shipment' | 'journalEntry';
const ID_PREFIX: Record<EntityKind, string> = { company: 'co', facility: 'fa', ... journalEntry: 'je' };
type IdOf<K extends EntityKind> = K extends 'company' ? CompanyId : ... ;
```

Runtime entity IDs are issued **only** by the engine registry, from a deterministic per-kind counter:
`${ID_PREFIX[kind]}_${String(n).padStart(6, '0')}` starting at `co_000001`. Beyond 999999 the number
simply grows (no truncation). `state.registry = { counters: Partial<Record<EntityKind, number>> }`
(missing = 0). Issuing is reached through `ctx.issueId(kind)` in a phase or `handle.issueId(kind)` in
a service. Never random, never derived from content, never reused.

Authored IDs (products, recipes, regions, cities, markets, store formats) come from `data/` files and
are validated by schema's zod validators. They are never issued by the registry.

---

## 4. Money and quantities

```ts
// schema/money.ts
type Money = Brand<number, 'Money'>; // integer minor units (cents); may be negative
type Quantity = Brand<number, 'Quantity'>; // integer count of units; never negative in state
function money(n: number): Money; // throws InvariantError('money.unsafe') unless Number.isSafeInteger(n)
function quantity(n: number): Quantity; // same check, plus n >= 0
const ZERO_MONEY: Money;
function addMoney(a: Money, b: Money): Money; // re-checks safe-integer range
function subMoney(a: Money, b: Money): Money;
```

- **Representation:** `number`, asserted `Number.isSafeInteger` (|x| <= 2^53 - 1 = about 90 trillion
  major units) at every construction and every ledger posting. Not `bigint`: it does not serialize to
  JSON, is slow, and mixes badly with ordinary arithmetic. Overflow policy: an unsafe result is an
  `InvariantError`, never silent wrap. Scenario validation rejects scenarios whose total starting cash
  exceeds 2^50 so the economy has three orders of magnitude of headroom (ADR-002).
- **Rounding policy is owned by accounting.** Any conversion from a ratio to money uses
  `scaleMoney(amount: Money, ratio: number): Money` from `@nepo/sim/accounting`, which rounds
  **half away from zero**, once, at the end of a computation. Proportional splits use
  `allocateMoney(total: Money, weights: readonly number[]): Money[]` (largest-remainder, ties to the
  lowest index) so the parts always sum to the total. No other module rounds money.
- Unit prices are `Money` per unit. Content must choose units so every price is at least 1 minor unit
  (price steel per tonne, not per gram). Prices are never floats.
- Inventory counts, share counts, headcounts are `Quantity` integers.

---

## 5. Time and calendar

1 tick = 1 day. The calendar is a fixed **360-day year: 12 months of 30 days, 4 quarters of 90 days**
(ADR-005). No weekends, no leap years; every day is a business day. Tick 0 is day 1 of month 1 of
`epochYear`.

```ts
// engine/calendar.ts
interface CalendarDate {
  tick: number;
  year: number; // epochYear + floor(tick / 360)
  month: number; // 1..12
  day: number; // 1..30
  quarter: number; // 1..4
  dayOfYear: number; // 1..360
  isMonthStart: boolean; // day === 1
  isMonthEnd: boolean; // day === 30
  isQuarterEnd: boolean; // isMonthEnd && month % 3 === 0
  isYearEnd: boolean; // isMonthEnd && month === 12
}
const DAYS_PER_MONTH = 30,
  MONTHS_PER_YEAR = 12,
  DAYS_PER_YEAR = 360;
function calendarFromTick(tick: number, epochYear: number): CalendarDate;
```

Period hooks: there are no engine-level monthly hooks; a system detects period boundaries from
`ctx.date` flags. **Period-end postings by domain systems** (depreciation, monthly rent, payroll runs,
tax provisions proposed by finance, ...) are made in that system's **own normal phase** on the tick
with `isMonthEnd` (ADR-009). The `close` phase is **reserved for accounting**: it computes statements
and posts the quarter/year closing work after every money movement of the day, so every entry posted
on a month-end tick lands in that month's report, and income accounts are exactly zero after the
year-end closing entry. Month-start work (e.g. resetting a monthly budget) runs on the tick with
`isMonthStart` in the system's normal phase. Daily accruals use `annualRate / 360` so a year of daily
accruals equals the annual rate exactly in expectation.

---

## 6. Tick loop, phases and the System interface

### 6.1 Phase order

Every call to `step(world)` executes the phases below in order. Within a phase, systems run in the
canonical order `SYSTEM_ORDER` (schema): `core, accounting, economy, manufacturing, logistics, retail,
finance, ai, hr`. The engine sorts registered systems by this order, so caller order is irrelevant.

| #   | Phase        | Who                                       | What                                                                                                                                                                                                                                                                   | Why here                                                                                                                            |
| --- | ------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `ingest`     | engine                                    | Drain `state.pendingCommands` (ascending `seq`), reject commands whose issuer is not in `state.companies` or whose type has no handler, route the rest to the handling system's inbox for this tick.                                                                   | Commands issued during tick t-1 (AI) or between ticks (player) take effect at the start of tick t; everyone sees the same inputs.   |
| 1   | `apply`      | all systems                               | Each system processes its routed commands: validate semantics (ownership, affordability), mutate own slice, post to the ledger, emit events, or `ctx.reject`.                                                                                                          | Decisions are applied before any simulation so the day's activity reflects them.                                                    |
| 2   | `macro`      | economy                                   | Macro indices (inflation, policy rate; M2 business cycle); update every reference price and commodity price from the **previous day's** tallies (ADR-011); open today's baseline demand.                                                                               | Depends on nothing produced today; everything else reads it. Prices for day t are fixed before anyone trades on day t.              |
| 3   | `production` | manufacturing (hr later)                  | Construction completion, WIP completion, JIT input purchases (`EconomyApi.quoteRaw/buyRaw`), batch starts, daily operating cost, month-end depreciation.                                                                                                               | Needs today's input prices (macro).                                                                                                 |
| 4   | `logistics`  | logistics (M2)                            | Advance shipments, arrivals into warehouses/stores (`RetailApi.receive`), fulfil transfer orders. **M1: no handler**; retail restocks directly in `market` (ADR-013).                                                                                                  | Needs today's production output.                                                                                                    |
| 5   | `market`     | retail; economy and manufacturing from M2 | Retail: construction completion, restock from own factories (`ManufacturingApi.withdraw`), then sales via `EconomyApi.clearConsumerMarket`, shrinkage, operating cost, month-end depreciation. M2: economy B2B/commodity clearing, manufacturing B2B deliveries.       | Needs goods on shelves and today's demand/prices (macro). Economy runs before retail here, hence the previous-day tallies in macro. |
| 6   | `finance`    | finance                                   | Daily overdraft check and penalty accrual (ADR-014); month-end interest accrual and scheduled repayments; missed payments and defaults. M3: dividends, stock price, ratings.                                                                                           | Needs the day's cash flows (market) to assess liquidity.                                                                            |
| 7   | `close`      | accounting **only**                       | On `isMonthEnd`: accounting computes the month's statements, then quarter/year work (consolidation and tax from M2, the year-end closing entry). No other system may register `close`; period-end postings belong in the poster's own phase on `isMonthEnd` (ADR-009). | Runs after every money movement of the day so statements are complete and the closing entry leaves income accounts at zero.         |
| 8   | `decide`     | ai (M3; no handler in M1)                 | Read state and today's events, submit commands for tick t+1 via `ctx.submit`.                                                                                                                                                                                          | AI sees the completed day exactly as the player will; its commands queue like the player's.                                         |
| 9   | `finalize`   | engine                                    | Seal the event log, `state.tick += 1`, run debug checks if requested.                                                                                                                                                                                                  | Nothing after this may touch state.                                                                                                 |

Systems may register handlers for phases 1-8 only. `ingest` and `finalize` are engine-only; registering
them is `InvariantError('systems.invalid_phase')`. `close` is accounting-only: `createWorld`/`restore`
throw `InvariantError('systems.close_reserved')` when a system whose `id` is not `accounting`
registers it (the engine special-cases the id `accounting` here exactly as it does `core`; this is the
one place the engine names a domain system). `ctx.submit` is legal only in phase `decide`
(InvariantError otherwise). Period-end work is detected by the system from `ctx.date` flags; the
engine does not have separate monthly hooks. Rationale for reserving `close` rather than ordering
within it: a domain posting after accounting's close would silently land in the next month's report
and, at year end, leave income accounts non-zero after the closing entry; a domain posting before it
in `close` needs no `close` at all, since every domain phase already precedes `close`. Readers of
fresh statements (`ai` in `decide`, the UI) see them the same tick; finance reads last month's report
in its own phase one day later, which is the intended lag.

### 6.2 System interface

```ts
// engine/system.ts
type Phase =
  | 'ingest'
  | 'apply'
  | 'macro'
  | 'production'
  | 'logistics'
  | 'market'
  | 'finance'
  | 'close'
  | 'decide'
  | 'finalize';
const PHASE_ORDER: readonly Phase[];
type SystemPhase = Exclude<Phase, 'ingest' | 'finalize'>;

interface System<S> {
  readonly id: SystemId; // schema literal union; also the slice key in WorldState
  readonly handles: readonly Command['type'][]; // command types routed to this system (unique across systems)
  init(ctx: InitContext): S; // returns the initial slice; may issue IDs, post, emit
  readonly phases: Partial<Record<SystemPhase, (ctx: TickContext<S>) => void>>;
  createService?(handle: ServiceHandle<S>): unknown; // optional: returns the object registered under this system's ServiceKey
  readonly serviceKey?: ServiceKey<unknown>; // required if createService is present
}
type AnySystem = System<unknown>;

interface InitContext {
  readonly seed: number;
  readonly scenario: DeepReadonly<Scenario>;
  readonly state: DeepReadonly<WorldState>; // slices of systems earlier in SYSTEM_ORDER are already initialised
  readonly rng: Rng; // stream `${systemId}` (section 9)
  issueId<K extends EntityKind>(kind: K): IdOf<K>;
  emit(event: EventInput): void; // events emitted during init belong to tick 0's pre-run log
  readonly services: ServiceRegistry; // services of systems earlier in SYSTEM_ORDER
}

interface TickContext<S> {
  readonly tick: number;
  readonly date: CalendarDate;
  readonly phase: SystemPhase;
  readonly scenario: DeepReadonly<Scenario>;
  readonly state: DeepReadonly<WorldState>; // whole world, read-only
  readonly slice: S; // this system's slice, mutable (the ONLY mutable thing)
  readonly rng: Rng; // default stream `${systemId}`
  rngFor(name: string): Rng; // sub-stream `${systemId}/${name}`, created lazily
  readonly commands: readonly Command[]; // routed to this system this tick, ascending seq (same in every phase)
  readonly events: readonly Event[]; // everything emitted so far this tick, by all systems
  emit(event: EventInput): void;
  reject(command: Command, code: string, reason: string): void; // emits command.rejected
  submit(command: CommandInput): Result<number, CommandValidationError>; // decide phase only
  issueId<K extends EntityKind>(kind: K): IdOf<K>;
  readonly services: ServiceRegistry;
}

interface ServiceHandle<S> {
  // what a service closes over (lives for the world's lifetime)
  slice(): S; // current own slice (mutable)
  state(): DeepReadonly<WorldState>;
  scenario(): DeepReadonly<Scenario>; // same object as ctx.scenario; lets a service read content without per-phase re-binding
  readonly services: ServiceRegistry; // live registry; call only EARLIER systems' services (later = dependency-direction violation, reviewed not enforced)
  tick(): number;
  date(): CalendarDate;
  issueId<K extends EntityKind>(kind: K): IdOf<K>;
  emit(event: EventInput): void;
}

type ServiceKey<T> = Brand<string, 'ServiceKey'> & { readonly __type?: T };
function createServiceKey<T>(name: string): ServiceKey<T>;
interface ServiceRegistry {
  get<T>(key: ServiceKey<T>): T; // InvariantError('services.missing') if absent
  has(key: ServiceKey<unknown>): boolean;
}
```

`ctx.scenario` is the immutable scenario the world was created from; it travels inside the snapshot
(section 11), so a system may read it in any phase, not only in `init`.

`DeepReadonly` is a type-level guard only; the engine does not freeze state (too slow). Ownership is
enforced by review and by the engine's debug check `step(world, { checkSliceOwnership: true })`,
which sim-tests runs on short runs. Its exact semantics (**must**, so nobody "fixes" them):

- Around each system phase handler the engine hashes every top-level field of `WorldState` except
  (i) the running system's own slice and (ii) the engine-owned fields systems change only through
  `ctx`/`handle` methods: `commandSeq`, `pendingCommands` (via `submit`), `registry` (via `issueId`),
  `rng` (via `rng`/`rngFor`). A difference in any other field after the handler is
  `InvariantError('slice.foreign_write', { system, phase, slice, tick })`.
- A slice whose owner's **service** was used during the handler is also excluded: every call to
  `ServiceHandle.slice()` marks the owning slice as touched for the current phase. This is what makes
  `accounting.post(...)` from a domain phase legal while a direct write to `state.accounting` from the
  same handler is caught (ADR-007: a service mutates only its own slice, on behalf of its caller).
  Consequently `handle.slice()` is a **mutation declaration**: a service implements read-only methods
  (`balance`, `cash`, `hasEntity`, queries in general) through `handle.state()`, never `handle.slice()`,
  so that a read does not disable the check for that slice.
- Known gaps, accepted: the check is per phase and hash-based, so it cannot attribute a foreign write
  made through a service to the caller rather than the service author, and it does not run unless the
  flag is set. It is a debug net under tests, not a security boundary; review remains the primary
  enforcement.

Services (ADR-007) are how a system exposes an API to others: accounting registers `AccountingApi`
under `ACCOUNTING_SERVICE`; economy will register a price-query API, etc. A service may mutate only its
own slice (via `handle.slice()`). Services are created at `createWorld`/`restore` in `SYSTEM_ORDER`
and are not part of state. Service calls are synchronous and happen inside the caller's phase, so
their ordering is deterministic.

### 6.3 Engine public API

```ts
// engine/index.ts
interface World {
  // runtime container, NOT state; opaque beyond these fields
  readonly state: WorldState; // live; outside the engine treat as read-only
  readonly scenario: Scenario;
  readonly systems: readonly AnySystem[]; // in SYSTEM_ORDER
  readonly lastEvents: readonly Event[]; // events of the most recent step (or init)
}
interface CreateWorldOptions {
  seed: number;
  scenario: Scenario;
  systems: readonly AnySystem[];
}
interface StepOptions {
  checkSliceOwnership?: boolean;
  checkFinite?: boolean;
}
interface TickResult {
  tick: number;
  date: CalendarDate;
  events: readonly Event[];
}

function createWorld(options: CreateWorldOptions): World;
function step(world: World, options?: StepOptions): TickResult;
function submit(world: World, command: CommandInput): Result<number, CommandValidationError>; // returns seq
function snapshot(world: World): Snapshot;
function restore(snapshot: unknown, systems: readonly AnySystem[], options?: RestoreOptions): World; // validates, migrates, rebuilds services
interface RestoreOptions {
  migrations?: MigrationTable;
} // test override only; a snapshot needs nothing else to restore
function hashState(state: WorldState): string; // section 10
function canonicalJson(value: unknown): string;
function findNonFinite(value: unknown): string[]; // JSON paths of NaN/Infinity/-0
const ENGINE_VERSION: string;
```

`createWorld` does, in order: build `WorldState` core fields; run the built-in `core` system init
(creates one `Company` per `scenario.companies` entry, in array order, issuing `co_000001...`, and
emits `company.founded`); run each registered system's `init` in `SYSTEM_ORDER`, assigning the returned
slice; create services. `step` must never hash, validate with zod, or deep-copy state unless a
`StepOptions` flag asks for it (hashing is O(state) and belongs to tests).

---

## 7. Commands and events

### 7.1 Commands

Commands are the **only** way anything outside a system (player UI, AI, tests) changes state. Player
and AI issue identical command types through identical paths; there is no privileged API (ADR-003).

```ts
// schema/commands.ts  (flat discriminated union on `type`)
interface CommandBase {
  seq: number;
  tick: number;
  issuer: CompanyId;
}
interface RenameCompanyCommand extends CommandBase {
  type: 'company.rename';
  payload: { name: string; companyId?: CompanyId }; // target; omitted = the issuer itself
}
// M1 adds e.g. 'facility.build', 'store.open', 'store.set_price', 'loan.draw', ...
type Command = RenameCompanyCommand /* | ... */;
type CommandType = Command['type'];
type CommandInput = DistributiveOmit<Command, 'seq' | 'tick'>; // what submit() takes
const CommandSchema: z.ZodType<Command>; // discriminatedUnion('type', [...]), stamped commands
const CommandInputSchema: z.ZodType<CommandInput>; // same without seq/tick; what submit() validates
interface CommandValidationError {
  code: 'invalid_shape';
  issues: string[];
}
```

Naming: `type` is `'<domain>.<verb>'` in lower snake case. Payloads are plain data; IDs branded.
Convention (**must**): a command that acts on an entity names its target in the payload (`companyId`,
`facilityId`, ...) even when the only legal target is the issuer, so the handler can emit a `not_owner`
rejection with a concrete target instead of silently acting on the issuer; the target may be optional
only when "omitted = the issuer" is unambiguous, as in `company.rename`.

Lifecycle:

1. `submit(world, input)` (or `ctx.submit` in `decide`) validates **shape** with `CommandSchema`
   immediately. Invalid shape returns `err` and queues nothing (malformed input from a typed caller is
   a bug and deserves synchronous feedback). Valid input is stamped `seq = ++state.commandSeq` and
   `tick` = the tick whose `ingest` will process it (between steps: `state.tick`; during a step:
   `state.tick + 1`), then appended to `state.pendingCommands`.
2. `ingest` drains the queue in ascending `seq`. **Ordering is by `seq` only**, never by issuer, never
   by type. Unknown issuer -> `command.rejected` with code `unknown_issuer`; no system `handles` the type
   -> `no_handler`.
3. The handling system, in `apply`, validates **semantics** (issuer owns the target, can afford it,
   target exists). Failure -> `ctx.reject(cmd, code, reason)`, which emits `command.rejected`. Success
   -> mutate own slice, post to ledger, emit a domain event. A system must either fully apply or fully
   reject a command; partial application is a bug.
4. Rejections never throw. Throwing from command handling is reserved for `InvariantError` (section 12).

Each command type has exactly one handling system (engine checks `handles` for duplicates at
`createWorld`; duplicate -> `InvariantError('commands.duplicate_handler')`). `company.rename` is
handled by the engine's `core` system (M0 end-to-end test of routing, rejection and events): target
`payload.companyId ?? issuer`; rejections, in order, `not_owner` (target !== issuer), `unknown_company`,
`invalid_name` (empty after trim); success stores the trimmed name and emits `company.renamed`.

### 7.2 Events

```ts
// schema/events.ts
interface EventBase { tick: number; seq: number; source: SystemId }   // seq: 0.. within the tick
interface CommandRejectedEvent extends EventBase { type: 'command.rejected'; payload: { commandSeq: number; commandType: CommandType; issuer: CompanyId; code: string; reason: string } }
interface CompanyFoundedEvent  extends EventBase { type: 'company.founded';  payload: { companyId: CompanyId; name: string } }
interface CompanyRenamedEvent  extends EventBase { type: 'company.renamed';  payload: { companyId: CompanyId; name: string } }
interface LedgerPostedEvent    extends EventBase { type: 'ledger.posted';    payload: { entryId: JournalEntryId; entityId: CompanyId; memo: string } }
interface PeriodClosedEvent    extends EventBase { type: 'period.closed';    payload: { entityId: CompanyId; kind: 'month' | 'quarter' | 'year'; year: number; month: number } }
type Event = ...union; type EventInput = DistributiveOmit<Event, 'tick' | 'seq' | 'source'>;
```

Events are an append-only log **per tick**, numbered by `seq` in emission order, returned from `step`
as `TickResult.events` and kept on `world.lastEvents`. They are **not** part of `WorldState` and not
hashed (ADR-007): the log would grow without bound and events must never be the channel through which
one system's state reaches another. Systems may read `ctx.events` within the same tick (the AI does in
`decide`); anything a system needs across ticks must be in some slice. The UI's event log is the UI's
own buffer of `TickResult.events`.

---

## 8. Accounting: the only money path

Every change to any balance is a balanced journal entry posted through the accounting service.
Domain systems never hold cash fields; "how much cash does company X have" is
`accounting.balance(X, ACCOUNTS.CASH)`.

### 8.1 State (schema)

```ts
// schema/accounting.ts
type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
interface LedgerAccount {
  code: AccountCode;
  name: string;
  type: AccountType;
  balance: Money;
}
// balance is debit-normal signed: debits increase it, credits decrease it, for EVERY account type.
// Liabilities/equity/revenue therefore carry negative balances. Σ balance over an entity === 0 always.
interface JournalLine {
  account: AccountCode;
  debit: Money;
  credit: Money;
} // exactly one side > 0, other === 0
interface JournalEntryInput {
  memo: string;
  lines: JournalLine[];
  source: SystemId;
  ref?: { kind: string; id: string };
}
interface JournalEntry extends JournalEntryInput {
  id: JournalEntryId;
  entityId: CompanyId;
  tick: number;
}
interface EntityLedger {
  entityId: CompanyId;
  parentId: CompanyId | null; // consolidation parent (used from M2)
  accounts: Record<AccountCode, LedgerAccount>;
  monthOpening: Record<AccountCode, Money>; // balances at the start of the current month
  yearOpening: Record<AccountCode, Money>; // balances at the start of the current fiscal year
  reports: PeriodReport[]; // append-only, chronological
}
interface IncomeStatement {
  revenue: Money;
  cogs: Money;
  grossProfit: Money;
  opex: Money;
  operatingIncome: Money;
  otherIncome: Money;
  pretaxIncome: Money;
  incomeTax: Money;
  netIncome: Money;
  byAccount: Record<AccountCode, Money>;
}
interface BalanceSheet {
  assets: Money;
  liabilities: Money;
  equity: Money;
  byAccount: Record<AccountCode, Money>;
} // equity includes current-period earnings; assets === liabilities + equity
interface CashFlowStatement {
  netIncome: Money;
  operating: Money;
  investing: Money;
  financing: Money;
  netChange: Money;
  openingCash: Money;
  closingCash: Money;
}
interface PeriodReport {
  kind: 'month' | 'quarter' | 'year';
  year: number;
  month: number;
  tick: number;
  income: IncomeStatement;
  balance: BalanceSheet;
  cashFlow: CashFlowStatement;
}
interface AccountingState {
  entities: Record<CompanyId, EntityLedger>;
  journal: JournalEntry[];
} // journal: all entities, posting order
```

### 8.2 Posting API (accounting)

```ts
// accounting/index.ts
const ACCOUNTING_SERVICE: ServiceKey<AccountingApi>;
type PostingErrorCode =
  'unknown_entity' | 'unknown_account' | 'unbalanced' | 'invalid_line' | 'empty' | 'overflow';
interface PostingError {
  code: PostingErrorCode;
  message: string;
}
interface AccountingApi {
  openEntity(entityId: CompanyId, parentId?: CompanyId): void; // standard chart; InvariantError if it exists
  post(entityId: CompanyId, entry: JournalEntryInput): Result<JournalEntry, PostingError>;
  postOrThrow(entityId: CompanyId, entry: JournalEntryInput): JournalEntry; // InvariantError on err
  balance(entityId: CompanyId, account: AccountCode): Money; // debit-normal signed
  cash(entityId: CompanyId): Money; // balance(ACCOUNTS.CASH), convenience
  hasEntity(entityId: CompanyId): boolean;
}
function dr(account: AccountCode, amount: Money): JournalLine; // builders for lines
function cr(account: AccountCode, amount: Money): JournalLine;
// entry builders (return JournalEntryInput): openingCapital, cashSale, cashPurchase, loanDrawdown, interestAccrual, depreciation, ...
function scaleMoney(amount: Money, ratio: number): Money;
function allocateMoney(total: Money, weights: readonly number[]): Money[];
function checkLedgerInvariants(state: AccountingState): InvariantViolation[]; // for sim-tests
```

`post` validation, in order: entity exists; `lines.length >= 2`; every line has exactly one positive
safe-integer side; every account exists in the entity's chart; `Σ debit === Σ credit`; every resulting
balance is a safe integer. Any failure returns `err` and changes nothing (atomic). A caller that receives
`err` **must not swallow it**: it either rejects the originating command (if the failure is attributable
to the command) or throws `InvariantError` (a system constructing an unbalanced entry is a bug). On
success the entry gets `id = issueId('journalEntry')`, `tick`, is appended to `journal`, balances are
updated, `ledger.posted` is emitted.

### 8.3 Chart of accounts

Codes are four-digit strings. The leading digit fixes the type: `1xxx` assets, `2xxx` liabilities,
`3xxx` equity, `4xxx` revenue, `5xxx` COGS, `6xxx` operating expenses, `7xxx` other income/expense and
tax (5-7 are `expense` type; `71xx` interest income is revenue-like but stays in 7 for statement
layout and is negative in `otherIncome`). The standard template (`STANDARD_CHART`) and constants
(`ACCOUNTS.CASH` etc.) are exported by accounting; full list in `docs/design/accounting.md`. Other
systems reference accounts only through `ACCOUNTS.*` constants, never string literals. Adding an
account is an accounting change (template), not a schema change.

### 8.4 Period close

In phase `close` on `isMonthEnd`, for each entity in `sortedKeys(entities)`: compute the month's
`IncomeStatement` (movements since `monthOpening` on 4-7xxx accounts), `BalanceSheet` (current
balances), `CashFlowStatement` (indirect method from balance deltas, classification by code range in
the design doc), append a `month` report, roll `monthOpening`. On `isQuarterEnd` also append a `quarter`
report: the **sum of that quarter's month reports** (flows summed, `openingCash` from the first,
balance sheet and `closingCash` from the last); no quarter-opening balances are stored. On `isYearEnd`:
compute the `year` report from `yearOpening`, post the closing entry moving every 4-7xxx balance into
`3100 Retained Earnings`, append the `year` report, roll `yearOpening`. Emit `period.closed` per
report. Invariants after close: `netChange === closingCash - openingCash`;
`assets === liabilities + equity`; every 4-7xxx balance is 0 after a year end.

Because `close` is accounting-only and runs after every domain phase (section 6.1, ADR-009), a domain
system that must post on a period boundary (depreciation, rent, payroll) posts in its own phase on the
tick with `isMonthEnd`, and the entry is included in that month's statements.

Tax and consolidation with intercompany elimination are M2 (section 15).

---

## 9. Random numbers

The engine owns randomness (ADR-001). Generator: **xoshiro128\*\*** (four 32-bit words, `Math.imul`
and `>>>` only; small, fast, excellent statistical quality, exact in JS without bigint). Streams are
seeded by **splitmix32** over `mix(seed, fnv1a32(streamName))`, so a stream's sequence depends only on
`(seed, name)`: adding or reordering systems, or creating a stream later in a run, never perturbs any
other stream. State per stream is `RngStreamState = { s: [number, number, number, number] }` (u32s),
stored in `state.rng[name]` so snapshots carry it. Stream names: `${systemId}` by default,
`${systemId}/${sub}` via `rngFor`; the engine itself uses `core`.

```ts
// engine/rng.ts
interface Rng {
  nextU32(): number; // [0, 2^32)   the only primitive; everything below derives from it
  nextFloat(): number; // [0, 1)  53-bit: ((hi >>> 5) * 2^26 + (lo >>> 6)) * 2^-53, hi drawn first
  int(min: number, max: number): number; // inclusive both ends, unbiased (rejection sampling on nextU32)
  pick<T>(items: readonly T[]): T; // items[int(0, len - 1)]; InvariantError on empty
  shuffle<T>(items: T[]): T[]; // in-place Fisher-Yates from the end using int(0, i)
  chance(p: number): boolean; // nextFloat() < p
}
```

Forbidden everywhere in `packages/sim`: `Math.random`, `Date`, `performance.now`, `crypto.*`,
timers, and any RNG not obtained from the engine (ESLint bans the obvious ones). Draw counts are part
of the contract: a system must not draw from its stream in a way that depends on iteration order of an
unsorted collection. Exact algorithms are in `docs/design/engine.md`.

---

## 10. Determinism strategy

Determinism means: `createWorld({seed, scenario, systems})` followed by the same sequence of `submit`
and `step` calls yields byte-identical `canonicalJson(state)` at every tick, on any JS engine.

- **Canonical JSON** (`canonicalJson`): recursive; object keys sorted by UTF-16 code-unit order; arrays
  in order; strings via `JSON.stringify`; integers and floats via `String(n)` (`Number::toString` is
  fully specified by ECMAScript, so shortest round-trip output is identical across engines); `-0` is
  written as `0`; `null` as `null`. Throws `InvariantError('canon.unsupported')` on `undefined`,
  functions, symbols, `bigint`, `Map`, `Set`, `Date`, class instances with non-Object prototypes, and
  non-finite numbers.
- **State hash** (`hashState`): two lanes of **FNV-1a 32** over the UTF-16 code units of the canonical
  string (each unit fed as low byte then high byte), lane A offset basis `0x811c9dc5`, lane B offset
  basis `0xcbf29ce4`, prime `0x01000193` via `Math.imul`; result = 16 hex chars `A||B`. Dependency-free,
  runs in browsers, fast enough for per-tick use in tests. It is a regression fingerprint, not a
  security hash. The exact value becomes part of regression snapshots, so the algorithm is frozen
  after M0 (changing it is an ADR).
- **Determinism test** (engine, and sim-tests at scale): run N ticks from a seed twice in fresh worlds
  -> identical hash at every tick; snapshot at tick K, restore in a fresh process-equivalent, run to N
  -> identical hash to the uninterrupted run (section 11).
- **Float policy**: `number` floats are allowed for ratios, elasticities, probabilities, indices and
  similar non-reconciling quantities. Never for money, inventory, shares, headcount. Floats must not be
  summed or multiplied across a collection in an order other than `sortedKeys` order (floating-point
  addition is not associative). Allowed `Math`: `floor ceil round trunc abs sign min max sqrt imul`
  (exactly specified). **Avoid** `Math.exp log pow sin cos tan atan2` and `**` with non-integer
  exponents in anything that influences state: ECMAScript permits implementation-approximated results,
  so V8 versions may differ. Use rational approximations, lookup tables or integer math; if a
  transcendental is unavoidable, the economy agent must round its result to a fixed grid (e.g. 1e-6)
  and document it. Division by zero must be guarded; `NaN`/`Infinity` in state is an invariant failure.
- **Ban list** (code review + lint): `Math.random`, `Date`, `performance.now`, `crypto`, timers,
  `for...in`, unsorted `Object.keys/values/entries` iteration that affects results, `Map`/`Set` in
  state, `Array.prototype.sort` without a comparator on non-string arrays, `JSON.stringify` of state for
  hashing (use `canonicalJson`), `Promise`/`async` anywhere in the tick path (the sim is synchronous).

---

## 11. Serialization, snapshots, migration

```ts
// schema/snapshot.ts
const SCHEMA_VERSION = 1;
interface Snapshot {
  format: 'nepo/snapshot';
  schemaVersion: number; // of `state` as written
  engineVersion: string; // informational, never gates loading
  hash: string; // hashState(state) at write time; covers `state` only
  scenario: Scenario; // the scenario the world was created from (validated with ScenarioSchema)
  state: WorldState; // self-contained: seed, tick, rng streams, pendingCommands are inside
}
interface SnapshotEnvelope extends Omit<Snapshot, 'state'> {
  state: unknown;
} // read before migrating
const SnapshotSchema: z.ZodType<Snapshot>; // deep-validates state (loading is rare; cost is acceptable)
const SnapshotEnvelopeSchema: z.ZodType<SnapshotEnvelope>;
```

A save is **self-contained**: `Snapshot` carries the scenario as well as the state, so `restore` needs
nothing but the file and the system objects (REQ-001, accepted as a required field: no snapshot
pre-dates it, so there is nothing to migrate; `scenario` is not part of `state` and therefore not
hashed, which keeps regression hashes stable). The scenario is immutable configuration: `createWorld`
validates it with `ScenarioSchema`, `restore` re-validates it and rejects `scenario.epochYear !==
state.epochYear` with `SnapshotError('scenario_mismatch')`.

`snapshot(world)` deep-copies via `JSON.parse(canonicalJson(state))` (also proves serializability).
`restore(input, systems)` accepts untrusted input: parse the envelope with `SnapshotEnvelopeSchema`
(`SnapshotError('invalid')`); refuse `schemaVersion > SCHEMA_VERSION` (`too_new`); if
`schemaVersion < SCHEMA_VERSION`, run `migrateSnapshot` (engine `migrations.ts`: an ordered table of
`(fromVersion) => (state: unknown) => unknown` steps, one per version bump, authored by the engine
agent from the schema agent's migration notes in `docs/schema-requests.md`; missing step ->
`no_migration`); deep-validate with `SnapshotSchema`; recompute the hash and compare with
`snapshot.hash` **when no migration ran** (mismatch -> `hash_mismatch`); require a slice for every
registered system (`InvariantError('restore.missing_slice')`); rebuild services without calling `init`.

Not-yet-typed slices in saves (section 2): `WorldStateSchema` accepts a plain-JSON value under any
`SystemId` key that has no typed slice yet and validates nothing inside it. Such a key only ever exists
in development builds and test fixtures. The migration step that introduces the typed slice **must
replace** any pre-existing value under that key with the slice's initial value rather than trust it.

Equivalence requirement (**must**, tested by engine and sim-tests): for any K, `restore(snapshot(worldAfterKTicks))`
followed by `N-K` steps has the same hash as the uninterrupted `N`-tick run. This holds because
everything a step reads is inside `WorldState` or the (immutable, snapshotted) scenario, including
RNG streams and queued commands; services and systems are stateless outside their slices. Any system
that keeps state in a closure or module variable breaks this and is rejected in review.

---

## 12. Error handling

```ts
// schema/errors.ts
class NepoError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
}
class InvariantError extends NepoError {} // a bug: an impossible state was reached
class SnapshotError extends NepoError {} // unreadable, mismatched or too-new snapshot
function invariant(
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): asserts condition;
```

- Player/AI mistakes (bad command shape, unaffordable build, unknown target) are **never thrown**: shape
  errors are returned from `submit`; semantic errors become `command.rejected` events.
- Impossible states (unbalanced entry constructed by a system, negative inventory, foreign slice write,
  unsafe integer, duplicate handler, NaN) **throw `InvariantError`** immediately with a stable `code`.
  The tick is then undefined; callers (UI, sim-tests) treat the world as poisoned and report seed + tick
  - code. The engine does not catch and continue.
- No `console.log` in the sim; `console.warn/error` only for truly exceptional diagnostics.

---

## 13. Testing contract

Every system ships, next to its code (`*.test.ts`, Vitest 5, fast-check 4): unit tests for each
command handler and phase, plus at least one property or invariant test (e.g. "for any sequence of
valid postings, Σ balances === 0"). Tests use `SMOKE_SCENARIO`/`EMPTY_SCENARIO` fixtures from schema
and real engine functions; no mocking of the engine.

sim-tests (`packages/sim-tests`) owns the headless runner (`pnpm sweep -- --seeds 5 --years 5`) and the
invariant suite, run **every tick** of every sweep:

1. Ledger: every entity's `Σ balance === 0` and `Σ debit === Σ credit` for every journal entry
   (`checkLedgerInvariants`).
2. Balance-sheet identity after every tick and `netChange === closingCash - openingCash` in every report.
3. No negative `Quantity` anywhere; no negative cash unless a credit facility covers it (M1+).
4. Goods conservation across production, transit and sales (M1/M2, via each system's exported checker).
5. `findNonFinite(state).length === 0`.
6. Hash stability: identical hash sequence across two runs of the same seed; snapshot/restore equivalence.
7. Economic sanity (M2+): bounded price volatility, no permanent collapse, no runaway inflation.

Hooks sim-tests relies on: `createWorld`, `step` (with `checkSliceOwnership` on short runs),
`submit`, `hashState`, `snapshot`, `restore`, `findNonFinite`, `calendarFromTick` from
`@nepo/sim/engine`; `accountingSystem`, `checkLedgerInvariants`, `ACCOUNTS` from
`@nepo/sim/accounting`; `EMPTY_SCENARIO`, `SMOKE_SCENARIO`, `SCHEMA_VERSION` from `@nepo/sim/schema`.
qa may not weaken an invariant; a failing invariant is routed to the owner of the offending slice.

Performance budget (M0): an empty world steps 1800 ticks (5 years) in under 2 seconds without hashing;
hashing every tick may add at most an order of magnitude. Systems must not do O(entities²) work per tick
without an ADR.

---

## 14. Schema change process

`packages/sim/src/schema` is edited only by `schema`. Everyone else files a request in
`docs/schema-requests.md` using the template there (`REQ-NNN`, requester, additive/breaking, proposal,
affected consumers). The schema agent accepts, rejects with reasoning, or counter-proposes, records the
outcome in the changelog, and for breaking changes bumps `SCHEMA_VERSION` and writes migration notes
(old shape -> new shape, default values) that the engine agent turns into a `migrations.ts` step before
the change merges. Additive, optional-field changes do not bump the version. Slice types, command and
event members, and zod validators are all schema territory; account templates, service APIs and system
objects are not.

Slices before their type lands (section 2): `WorldStateSchema` tolerates an untyped plain-JSON value
under any `SystemId` key, and rejects every other unknown top-level key. This exists so engine, qa and
domain agents can register throwaway or in-progress systems under real `SystemId`s in tests (including
snapshot/restore round trips) without a schema change per test. It does **not** relax contracts-first
for shipped code: a domain system joins `DEFAULT_SYSTEMS` only after schema has typed its slice, bumped
`SCHEMA_VERSION`, and written the migration note; and that migration replaces any pre-existing untyped
value under the key (section 11). Schema additionally exports an empty initial value per typed slice
(`EMPTY_ACCOUNTING_STATE`, ...) that the engine uses for a typed slice whose system is not registered.

Fast path during M0: because the three foundation agents work in parallel, each may land its module
against the interfaces **as written in this document**. Discrepancies discovered at merge are resolved
in favour of this document; if this document is wrong, the architect amends it and the ADR.

---

## 15. Milestone 0 scope

Deliver exactly this; defer the rest.

**schema** (`packages/sim/src/schema`):
`ids.ts` (brands, `ID_PREFIX`, `IdOf`, `EntityKind`, unchecked cast helpers like `companyId(s)`),
`money.ts` (section 4), `result.ts` (`Result<T,E>`, `ok`, `err`), `errors.ts` (section 12),
`system.ts` (`SystemId = 'core'|'accounting'|'economy'|'manufacturing'|'logistics'|'retail'|'finance'|'ai'|'hr'`, `SYSTEM_ORDER`),
`company.ts` (`Company { id; name; controller: 'player'|'ai'|'npc'; parentId: CompanyId|null; foundedTick: number }`),
`scenario.ts` (`Scenario { id: string; name: string; epochYear: number; companies: { name: string; controller: 'player'|'ai'; startingCash: Money }[] }` + `ScenarioSchema`),
`world.ts` (section 2 incl. `RegistryState`, `RngStreamState`), `accounting.ts` (section 8.1),
`commands.ts`/`events.ts` (section 7, M0 members only), `snapshot.ts` (section 11, deep zod for the
M0 state), `content.ts` (minimal `Product`, `Recipe`, `Facility`, `Store`, `Market` interfaces with
authored-ID brands and zod validators; shapes are the schema agent's call and will be revised by M1
requests; they are **not** yet in `WorldState`), `fixtures.ts` (`EMPTY_SCENARIO`: no companies;
`SMOKE_SCENARIO`: two companies, player + ai, 100,000,000 minor units each), `DistributiveOmit`,
`SCHEMA_VERSION = 1`. Hand-written interfaces are the source of truth; zod schemas carry
`satisfies z.ZodType<T>` so they cannot drift.

**engine** (`packages/sim/src/engine`): everything in sections 3, 5, 6, 9, 10, 11 and the `core`
system (companies from scenario, `company.rename`). Tests: RNG known-answer test (first 4 outputs of
xoshiro128\*\* for a fixed state, taken from the reference implementation), stream independence,
calendar table, canonical JSON edge cases, hash KAT for a fixed string, determinism (2 x 200 ticks,
`SMOKE_SCENARIO`, no systems), snapshot/restore equivalence, command ordering and rejection paths,
phase order (a test system recording `(tick, phase)` calls), slice-ownership check catching a foreign
write. Deferred: replay log file format, migration steps (table exists, empty).

**accounting** (`packages/sim/src/accounting`): `accountingSystem` (`init`: open an entity for each
company in `sortedKeys(state.companies)` and post opening capital Dr `1000` / Cr `3000` from
`scenario.companies[i].startingCash`, matched by array index = company number; `phases.close`:
section 8.4), `ACCOUNTING_SERVICE`/`AccountingApi`, `STANDARD_CHART`, `ACCOUNTS`, `dr`/`cr`, the
entry builders listed in `docs/design/accounting.md`, `scaleMoney`, `allocateMoney`,
`checkLedgerInvariants`. Tests: posting validation table, fast-check property "random valid entries
keep Σ balance === 0 and A = L + E", rounding/allocation properties (parts sum to total; deterministic
tie-break), period close on month/quarter/year boundaries over 2 simulated years, cash-flow
reconciliation. Deferred: tax, consolidation/elimination, journal retention, multi-currency (not planned).

**qa** (`packages/sim-tests`): CLI runner (`--seeds`, `--years`, `--scenario`, `--hash-every`), the
invariant framework (checks 1, 2, 5, 6 above; 3/4/7 stubbed as not-applicable until their systems
exist), the determinism and snapshot-equivalence tests on 5 seeds x 5 years with `SMOKE_SCENARIO`,
a regression snapshot of the final hash per seed, and the slice-ownership check on 1 seed x 1 year.

**Exit criteria (BUILD_INSTRUCTIONS M0):** empty sim runs 5 simulated years on 5 seeds, hash stable
across repeat runs, ledger property tests pass, `pnpm check` is green.

Deferred to M1+: all domain slices, content loading from `data/`, UI read/dispatch adapter, replay
files, migrations with real steps. The sim root (`packages/sim/src/index.ts`, orchestrator-owned)
follows the public-surface policy in section 1 from the end of M0: `export *` of schema and engine,
`export * as accounting from './accounting/index.js'`, and from M1 one namespace per domain module plus
`DEFAULT_SYSTEMS = [accountingSystem, economySystem, ...]` in `SYSTEM_ORDER`.

### 15.1 Milestone 1 scope (vertical slice)

One raw material, one consumer product, one factory type, one store format, one city/region/market,
one NPC bank, player company only. Design docs are the contract; this section lists what ships.

**schema** (v2, `docs/design/schema-m1.md`): `ContentPack` + `assembleContentPack` + `Scenario.content`
(ADR-010), `InventoryLot`, slice types `EconomyState`/`ManufacturingState`/`RetailState`/`FinanceState`
with `EMPTY_` constants and `EMPTY_TYPED_SLICES`, 8 commands, 25 events, `BankId`, revised content
types, `SCHEMA_VERSION = 2` with the v1 -> v2 migration note.

**engine**: `MIGRATIONS[1]` (install empty slices; rekey account codes to `'aNNNN'`), `createWorld`
installs `EMPTY_TYPED_SLICES` for unregistered typed slices. No phase or API change.

**accounting**: account codes stored letter-prefixed (`'a1000'`; section 2 collections rule);
accounts `1205 Inventory - Work in Progress` and `1230 Inventory - Merchandise`;
builders `capex`, `inventoryPurchase`, `productionStart`, `productionComplete`, `internalTransfer`,
`retailSale`, `inventoryWriteOff`; `AccountingApi.balanceSheet(entity)` and `latestReport(entity, kind)`
read queries (`docs/design/accounting.md` sections 1, 2, 7).

**economy** (`economy.md`, ADR-011): `macro` phase only; bounded relaxation reference prices, linear
demand response, NPC commodity source, constant macro; `EconomyApi` with `clearConsumerMarket`,
`quoteRaw`/`buyRaw`, `policyRate`; `checkEconomyInvariants`.

**manufacturing** (`manufacturing.md`, ADR-012): `apply` + `production`; construction, WIP, JIT input
purchase, lots valued at moving weighted average, depreciation on `isMonthEnd`; `ManufacturingApi.withdraw`
posts the transfer; `checkManufacturingInvariants`.

**retail** (`retail.md`, ADR-013): `apply` + `market`; restock-then-sell, `retailSale` postings, shrinkage
hook, `RetailApi.receive` ready for M2 logistics; `checkRetailInvariants`.

**finance** (`finance.md`, ADR-014): `apply` + `finance`; term loan (fixed rate = policy rate + tiered
spread, straight-line amortisation, monthly accrual), overdraft backstop, missed payments and default
flag; `FinanceApi` read-only; `checkFinanceInvariants`.

**content**: `data/{products,recipes,facility_types,store_formats,regions,cities,markets}.json`,
`data/economy/{pricing,macro,commodities}.json`, `data/finance/banks.json`,
`data/scenarios/vertical_slice.json`; `packages/tools` `validate-data` and a loader that assembles a
`Scenario` from files.

**ui** (`player-flow.md`): `GameClock`, dashboard views, command forms, save/load; imports from
`@nepo/sim` only.

**qa**: invariants 3, 4 and the bounds part of 7 become active through the four `check*Invariants`
exports plus the cross-system checks (lot values vs 1200/1205/1210/1230; PP&E vs 1500/1590; loans vs
2500/2100; cash < 0 ⇒ overdrawn flag); sweep metrics `priceIndex`, `volatility`, event counts; the
scripted human run of `player-flow.md` section 8; regression hashes updated once for the new slices.

**Exit criteria (BUILD_INSTRUCTIONS M1):** a human builds a factory and a store, borrows, runs a
year and sees correct statements; all invariants pass on 5 seeds x 5 years with `DEFAULT_SYSTEMS` on
`vertical_slice` and on `smoke`.

**Deferred to M2** (with reason): logistics/transit and lead times (ADR-013: one city, same owner);
B2B sales and the economy `market` handler (no third-party buyers in M1); demand segmentation,
business cycle, commodity shocks and capacity (constant macro keeps M1 stability testable);
absorption costing/WIP refinements beyond ADR-012; subsidiaries and intercompany transfer pricing;
journal retention; `facility.close`/`store.close` and disposals; AI (`decide` unused).
