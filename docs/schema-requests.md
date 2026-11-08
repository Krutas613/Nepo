# Schema change requests

Only the `schema` agent edits `packages/sim/src/schema`. Every other agent requests changes here. The schema agent processes each request (accept / reject with reasoning / counter-proposal), records the outcome in the changelog, and moves the request to the Resolved section.

## Changelog

<!-- newest first: date, schema version, summary -->

- 2026-11-08, **schema v2 (BREAKING, `SCHEMA_VERSION` 1 -> 2)**: Milestone 1 (REQ-002 per
  `docs/design/schema-m1.md`, plus REQ-004).
  - **Breaking for code:** `AccountCode` is stored letter-prefixed (`'a1000'`,
    `ACCOUNT_CODE_PATTERN = /^a[1-7][0-9]{3}$/`); `'1000'` no longer validates anywhere (chart,
    `ACCOUNTS.*`, `LedgerAccount.code`, `JournalLine.account`, every code-keyed record). `WorldState`
    gains required slices `economy`, `manufacturing`, `retail`, `finance`; `TypedSliceSystemId` is
    `core | accounting | economy | manufacturing | retail | finance` and only `logistics`, `ai`, `hr`
    stay untyped (test systems using `economy`/`retail`/... as untyped JSON slices must move to those).
    Content M0 types `Facility`, `Store`, `MarketDemand.referencePrice`, `Market.region`/`population`,
    `Recipe.facility` and `FacilityKind 'warehouse'` are gone; the names `Facility`/`FacilitySchema`
    and `Store`/`StoreSchema` now denote the **runtime** slice entities (content definitions are
    `FacilityType`/`StoreFormat`).
  - **New:** `BankId`; `RecordKeySchema` + `INTEGER_LIKE_KEY_PATTERN` (no integer-like record key in
    state: every record key schema in state is a slug, entity id, account code or `RecordKeySchema`,
    and `JsonValueSchema` object keys use `RecordKeySchema` too); `inventory.ts` (`InventoryLot`,
    `EMPTY_LOT`); slice files `economy.ts`, `manufacturing.ts`, `retail.ts`, `finance.ts` with
    `EMPTY_*_STATE`; `EMPTY_TYPED_SLICES` and `TypedDomainSliceId` in `world.ts`; revised `content.ts`
    (`ContentPack`, `EMPTY_CONTENT_PACK`, `ContentPackSchema`, `ContentFiles`,
    `ContentValidationError`, `assembleContentPack`); `Scenario.content` (defaults to a validated
    copy of `EMPTY_CONTENT_PACK` when absent) and `ScenarioCompany.homeCity?`; 8 commands, 25 events;
    fixtures `M1_CONTENT_PACK` and `VERTICAL_SLICE_SCENARIO` (`EMPTY_SCENARIO`/`SMOKE_SCENARIO` carry
    `EMPTY_CONTENT_PACK`); shared `NonNegativeMoneySchema`, `PositiveMoneySchema`,
    `PositiveQuantitySchema`.
  - **Migration note v1 -> v2 (engine `MIGRATIONS[1]`; one step, applied in this order to `state`):**
    1. Typed slices: install a deep copy of `EMPTY_TYPED_SLICES[id]` (equivalently
       `EMPTY_ECONOMY_STATE`, `EMPTY_MANUFACTURING_STATE`, `EMPTY_RETAIL_STATE`,
       `EMPTY_FINANCE_STATE`) at `state.economy`, `state.manufacturing`, `state.retail` and
       `state.finance`, **replacing** any pre-existing untyped value under those keys.
    2. Account-code rekey, with `rekey = (code: string) => (/^[0-9]{4}$/.test(code) ? 'a' + code : code)`.
       For every `ledger` in `state.accounting.entities[*]`: rebuild `accounts` as
       `{ [rekey(k)]: { ...acct, code: rekey(acct.code) } }`; rebuild `monthOpening` and `yearOpening`
       as `{ [rekey(k)]: v }`; for every `report` in `ledger.reports`, rebuild `report.income.byAccount`
       and `report.balance.byAccount` as `{ [rekey(k)]: v }`. For every `entry` in
       `state.accounting.journal`: `entry.lines[i].account = rekey(entry.lines[i].account)`.
    3. New chart accounts (REQ-004), after the rekey: for every `ledger` in
       `state.accounting.entities[*]` and for each code `c` of `'a1205'`, `'a1230'` **not already in**
       `ledger.accounts`: set `ledger.accounts[c]` to a copy of the matching accounting
       `STANDARD_CHART` row with `balance: 0` (`a1205` "Inventory - Work in Progress", `a1230`
       "Inventory - Merchandise", both `type: 'asset'`), and `ledger.monthOpening[c] = 0`,
       `ledger.yearOpening[c] = 0`. Stored `reports` are left unchanged (a code missing from an old
       report's `byAccount` means 0).
    4. Nothing else in `state` changes. The envelope's `scenario` needs no migration: it parses
       unchanged, `content` defaulting to `EMPTY_CONTENT_PACK`.

    Steps 2 and 3 are idempotent (prefixed codes are left alone; existing `a1205`/`a1230` accounts are
    kept). Step 1 is safe only because the step runs on v1 states alone (never re-run it on v2 data).
    Per-entity sum of balances is unchanged (new accounts are 0). The result must pass
    `SnapshotSchema`; the hash comparison is skipped because a migration ran (ARCHITECTURE.md
    section 11).

  - **Follow-ups (other owners):** engine: `MIGRATIONS[1]` above; `createWorld` installs copies of
    `EMPTY_TYPED_SLICES[id]` for every typed domain slice whose system is not registered; tests that
    register throwaway systems as `economy`/`retail`/`finance` with untyped slices. accounting:
    `ACCOUNTS.* = accountCode('aNNNN')`, `accountTypeOf` reads `code.charAt(1)`, `codeNumber` parses
    `code.slice(1)`, chart rows `a1205`/`a1230`. qa: `/^[4-7]/` code tests become `/^a[4-7]/`;
    regression hashes regenerate **once** for v2 (new state keys + rekeyed codes), citing REQ-002.
    ui: display `code.slice(1)`. content/tools: validate `data/` with `assembleContentPack`.

- 2026-11-08, schema v1 (no bump): M0 review follow-ups (ARCHITECTURE.md sections 2, 11, 14 as amended).
  - **REQ-001 accepted as a required field.** `Snapshot.scenario: Scenario` and
    `SnapshotEnvelope.scenario: Scenario`, validated with `ScenarioSchema` by both `SnapshotSchema`
    and `SnapshotEnvelopeSchema`. Outside `state`, so `hashState` and regression hashes are unchanged.
    No version bump: no v1 snapshot without it was ever released. **Engine action required:**
    `snapshot()` must write `scenario`, `restore()` must use it (dropping the optional third argument
    and the stub) and enforce `scenario_mismatch`; until then engine/sim-tests snapshot tests fail.
    Note: because the envelope validates `scenario` before migrations run, a future breaking change
    to `Scenario` would need its own ADR and envelope-level handling.
  - **Untyped-slice policy.** `WorldState extends UntypedSlices`, where
    `UntypedSlices = Partial<Record<UntypedSliceId, JsonValue>>` and
    `UntypedSliceId = Exclude<SystemId, TypedSliceSystemId>`, with typed ids `core` and
    `accounting` (core's typed slice is `companies`, so a top-level `core` key is rejected).
    `WorldStateSchema` stays a strict object with one `JsonValueSchema.exactOptional()` key per
    untyped id; any other unknown key is still rejected, and typed slices are validated as before.
    New `json.ts`: `JsonValue` / `JsonValueSchema` (finite numbers, no `-0`, plain objects and arrays
    only). Additive; shipped code must not read or write untyped slices.
  - **Empty slice constants.** `EMPTY_ACCOUNTING_STATE` (deep-frozen `{ entities: {}, journal: [] }`)
    in `accounting.ts`: what the engine installs (as a copy) when accounting is not registered. Every
    future typed slice ships an `EMPTY_<SLICE>` constant next to its type. Additive.
  - Migration notes: none. Rule for later slice typing: the step that types slice `X` removes `X` from
    `UntypedSliceId`, adds a required property, bumps `SCHEMA_VERSION`, and its migration note says
    "set `state.X = EMPTY_X` (replacing any existing untyped value)".

- 2026-11-08, schema v1: initial M0 types (`packages/sim/src/schema`: ids, money, result, errors,
  system, company, scenario, world, accounting, commands, events, snapshot, content, fixtures;
  `SCHEMA_VERSION = 1`). Additions beyond ARCHITECTURE.md, all additive: optional
  `companyId?: CompanyId` on the `company.rename` payload (target; omitted = issuer, needed for
  engine.md's `not_owner` check); `CommandInputSchema`/`validateCommandInput` for `submit`;
  `SnapshotEnvelopeSchema` (state unvalidated) for reading `schemaVersion` before migrating;
  `FacilityTypeId` authored brand for content `Facility` definitions.
  Migration notes: none (first version; the engine's migration table stays empty).

## Open requests

<!--
### REQ-NNN: short title
- Requested by: <agent>
- Date: YYYY-MM-DD
- Type: additive | breaking
- Proposal: what type/field/union member to add or change and why
- Consumers affected: which modules read/write this
-->

### REQ-003: optional income index on `City` (for demand segmentation)

- Requested by: content (task brief: "one city (population, income index)")
- Date: 2026-11-08
- Type: additive
- Proposal: add `incomeIndex?: number` (finite, > 0, relative to 1 = national median) to `City` in
  `content.ts`/`schema-m1.md` section 3, optional so the M1 content files stay valid. Not written into
  `data/cities.json` because `City` has no such field in `schema-m1.md`; M1 economy does not read it
  (income segmentation is M2 per economy.md section 1). Only needed once the demand segmentation
  design in economy.md is implemented; if game-design prefers to hold it in `Market` instead, say so.
- Consumers affected: content (`data/cities.json`), economy (M2 segmentation), ui (city panel).

## Resolved

### REQ-004: v1 -> v2 migration must add the M1 chart accounts `1205` and `1230` to existing ledgers

- Requested by: accounting
- Date: 2026-11-08
- Type: breaking (amends the REQ-002 / `schema-m1.md` section 10 migration note; no type change)
- Proposal: `STANDARD_CHART` gains `1205 INVENTORY_WIP` and `1230 INVENTORY_MERCHANDISE` (ADR-012).
  New ledgers get them from `openEntity`, but a ledger migrated from v1 only has its codes rekeyed, so
  it would lack both accounts and every `productionStart`/`productionComplete`/`internalTransfer`/
  `retailSale` posting to it would fail with `unknown_account` (and `balance(..., 1205)` would throw).
  Add to engine `MIGRATIONS[1]`, after the rekey, for every `ledger` in `state.accounting.entities`
  and for each code `c` of `a1205`, `a1230` not already present: set `accounts[c]` to a copy of the
  matching `STANDARD_CHART` row with `balance: 0` (names "Inventory - Work in Progress" and
  "Inventory - Merchandise", type `asset`), and `monthOpening[c] = 0`, `yearOpening[c] = 0`. Stored
  reports are left unchanged
  (a missing code in an old report's `byAccount` means 0). Idempotent. Hash-neutral for v2 worlds.
- Consumers affected: engine (`MIGRATIONS[1]`), qa (migration test from a v1 fixture).
- **Outcome (schema, 2026-11-08): accepted.** No type change; included as step 3 of the v1 -> v2
  migration note in the changelog (applied after the rekey; idempotent; reports untouched).

### REQ-002: Milestone 1 schema (consolidated)

- Requested by: architect (for economy, manufacturing, retail, finance, ui, content, qa)
- Date: 2026-11-08
- Type: breaking (`SCHEMA_VERSION` 1 -> 2)
- Proposal: everything in `docs/design/schema-m1.md`: `ContentPack` + `assembleContentPack` +
  `Scenario.content` (ADR-010), `InventoryLot` (ADR-012), four typed slices with `EMPTY_` constants
  and `EMPTY_TYPED_SLICES`, eight commands, twenty-five events, `BankId`, revised content types,
  `AccountCode` stored letter-prefixed (`'a1000'`; section 10 ruling after engine profiling, with a
  general "no integer-like record keys" validator rule), migration note v1 -> v2 (install empty
  slices replacing untyped values; rekey account codes in ledgers, reports and journal lines).
- Consumers affected: engine (`MIGRATIONS[1]`, `createWorld` empty-slice install), accounting (none
  in schema; accounts/builders are its own template), all M1 domain systems, ui, sim-tests
  (regression hashes change once), tools (`validate-data` uses `assembleContentPack`).
- **Outcome (schema, 2026-11-08): accepted**, landed as schema v2 (see changelog). Deviations from
  `schema-m1.md`, all stricter or more precise, none changing a name or shape:
  - `EMPTY_TYPED_SLICES` is typed `{ readonly [K in TypedDomainSliceId]: WorldState[K] }` (assignable
    to the requested `Readonly<Record<Exclude<TypedSliceSystemId, 'core'>, unknown>>`), so the engine
    gets typed values; `TypedDomainSliceId` is exported.
  - Single-bank rules (tiers ascending, `minTermMonths <= maxTermMonths`) live in `BankSchema`, so
    `assembleContentPack` reports them as `invalid_shape`, not `cross_reference`. Tiers must be
    **strictly** ascending (an equal `maxLeverage` makes the later tier unreachable). `minTermMonths`
    shares the 1..120 range of `maxTermMonths`.
  - Extra cross-reference rule: a market lists each product at most once in `demand` (economy keys
    `MarketState.products` by product, so a duplicate would be silently ambiguous).
  - The "no integer-like key" rule also covers `JsonValueSchema` object keys (untyped slices are state).
  - Non-negativity / minimums where the design docs state them but the request did not: `Money >= 0`
    for facility/store `cost`, `accumulatedDepreciation`, WIP `value`, `revenueToday`, loan
    `principal`/`outstanding`/`accruedInterest`, `overdraftAccrued`, store-format costs;
    `referencePrice`/`unitPrice >= 1`; `offeredToday`/`lastOffered >= 0`; `priceIndex > 0`; loan
    `termMonths >= 1` (state and `loan.issued`). Other floats in slices are only required finite.
  - `Scenario.content` uses zod `prefault`: a missing `content` yields a fresh, validated copy of
    `EMPTY_CONTENT_PACK` (not the frozen constant).
  - Fixture ids (`grain`, `bread`, `bake_bread`, `bakery`, `grocery`, `heartland`, `springfield`,
    `springfield_market`, `first_national`) are test-only; `data/` may choose its own.

### REQ-001: carry the scenario in `Snapshot`

- Requested by: engine
- Date: 2026-11-08
- Type: additive (optional field now; could become required at the next version bump)
- Proposal: add `scenario?: Scenario` to `Snapshot` and `SnapshotEnvelope`, validated with
  `ScenarioSchema.exactOptional()` in `SnapshotSchema`/`SnapshotEnvelopeSchema`. ARCHITECTURE.md 6.3
  gives `World` a `scenario` and `TickContext` a `ctx.scenario`, but `restore(snapshot, systems)`
  has no source for it, so a restored world is not fully self-contained. Until this lands the engine's
  `restore` takes an optional third argument `{ scenario }` and otherwise uses a stub scenario
  (`id: 'restored'`, the state's `epochYear`, no companies). M0 systems read the scenario only in
  `init`, which `restore` never calls, so equivalence holds today. Once the field exists the engine
  will write it in `snapshot()` and prefer it in `restore()`.
- Consumers affected: engine (`snapshot`/`restore`), qa (snapshot equivalence tests), UI save/load.
- architect: recommend **accept, as a required field** (`scenario: Scenario` on `Snapshot` and
  `SnapshotEnvelope`, validated with `ScenarioSchema`), because a save must be self-contained and
  `restore(snapshot, systems)` total; no snapshot pre-dates v1 so nothing needs migrating, and the
  field is outside `state` so hashes are unchanged. ARCHITECTURE.md section 11 now specifies this.
- **Outcome (schema, 2026-11-08): accepted, as a required field** per the architect's recommendation
  and ARCHITECTURE.md section 11: `scenario: Scenario` on `Snapshot` and `SnapshotEnvelope`,
  validated with `ScenarioSchema` in both schemas. Schema version stays 1; no migration. See the
  changelog entry for the engine follow-up.
