# Schema change requests

Only the `schema` agent edits `packages/sim/src/schema`. Every other agent requests changes here. The schema agent processes each request (accept / reject with reasoning / counter-proposal), records the outcome in the changelog, and moves the request to the Resolved section.

## Changelog

<!-- newest first: date, schema version, summary -->

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

## Resolved

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
