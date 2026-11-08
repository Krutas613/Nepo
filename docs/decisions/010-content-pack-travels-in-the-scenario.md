# ADR-010: Content is loaded outside the sim and travels inside `Scenario.content`

**Status:** Accepted (Milestone 1 design)

## Context

Rule 7 puts products, recipes, cities and tunables in `data/` as JSON with validators. Rule 1 makes
`packages/sim` pure: it may not import `node:fs`, `fetch` or Vite loaders, so it cannot read those
files itself. A save must stay self-contained (section 11: `restore(snapshot, systems)` takes nothing
else), and the regression hash covers `state` only. Options: (a) a `content` option on `createWorld`
plus a new `Snapshot.content` field; (b) content embedded in `Scenario`, which is already validated,
snapshotted and not hashed; (c) content inside `WorldState` (hashed, migrated, mutable by nobody).

## Decision

Option (b).

- Schema adds `ContentPack` (records keyed by authored id: `products`, `recipes`, `facilityTypes`,
  `storeFormats`, `regions`, `cities`, `markets`, `economy` tunables, `finance.banks`) and
  `Scenario.content: ContentPack`. `ScenarioSchema` **defaults a missing `content` to
  `EMPTY_CONTENT_PACK`**, so the M0 fixtures, v1 snapshot envelopes and `data/scenarios/*.json`
  files (which omit `content`) all still parse; the type is required so systems never branch on it.
- Schema exports a pure `assembleContentPack(files: ContentFiles): Result<ContentPack, ContentValidationError>`
  that takes the parsed JSON of each `data/` file (arrays), keys them by id, and runs the
  cross-reference checks (every recipe input exists as a product, every city has a region, one
  market per city, every raw product has a commodity source, ...). It is the single validator.
- Loading is the caller's job: `packages/tools` (`validate-data`, CLI runner) reads files with
  `node:fs`; the UI imports `data/**/*.json` through Vite; sim-tests reads them with `node:fs`. Each
  then builds `{ ...scenarioFile, content }` and passes it to `createWorld`.
- Systems read content through `ctx.scenario.content` in any phase (the scenario is immutable and
  inside the snapshot). Systems never copy content into their slice; they store authored ids.

## Consequences

- Saves grow by the content pack (tens of KB at M2 scale; acceptable). A content-by-reference form
  with a pack hash is a possible M2+ change and would need its own ADR because it touches the envelope.
- A content change does not change `hashState` directly, only through behaviour; regression hashes
  therefore move when `data/` moves, which is intended and must be a deliberate update.
- `SMOKE_SCENARIO` and `EMPTY_SCENARIO` carry `EMPTY_CONTENT_PACK`: M1 systems registered against
  them do nothing (no markets, no facility types), which keeps the M0 sweep meaningful.
