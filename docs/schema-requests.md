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

- (none)

## Resolved

- (none)
