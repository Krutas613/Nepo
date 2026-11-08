# Schema change requests

Only the `schema` agent edits `packages/sim/src/schema`. Every other agent requests changes here. The schema agent processes each request (accept / reject with reasoning / counter-proposal), records the outcome in the changelog, and moves the request to the Resolved section.

## Changelog

<!-- newest first: date, schema version, summary -->

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

## Resolved

- (none)
