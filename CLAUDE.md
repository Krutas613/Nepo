# Nepo

Nepo is a deterministic, single-player corporate-empire business simulation (manufacturing, retail, finance) in the vein of Capitalism Lab.

Read, in order:

1. `BUILD_INSTRUCTIONS.md` — project brief, agent roster, milestones. Section 3 (architecture rules) is law.
2. `ARCHITECTURE.md` — tick phases, command/event model, module boundaries, determinism strategy.
3. `docs/decisions/` — ADRs. Any change to an architecture rule needs an ADR first.

## Hard rules (summary; full text in BUILD_INSTRUCTIONS.md §3)

- `packages/sim` is pure and headless; it never imports UI or Node platform APIs.
- All randomness comes from the engine's seeded RNG sub-streams. No `Math.random`, `Date.now`, or order-dependent iteration over unordered collections. ESLint enforces the obvious cases.
- State changes only via typed commands in the tick loop; systems emit typed events.
- Money moves only through the accounting ledger, as integer minor units (`Money` branded type).
- Only the `schema` agent edits `packages/sim/src/schema`. Everyone else files requests in `docs/schema-requests.md`.
- Content lives in `data/` with validators, not in code.
- Every system ships unit tests plus at least one invariant or property test.

## Ownership

Directory ownership and model assignments are in `BUILD_INSTRUCTIONS.md` §5; agent definitions in `.claude/agents/`. Work on a directory goes to its owning agent.

## Commands

- `pnpm install` — install workspace.
- `pnpm check` — typecheck + lint + tests (the merge gate).
- `pnpm test` — all Vitest projects.
- `pnpm sweep -- --seeds 5 --years 5` — headless invariant sweep (`packages/sim-tests`).
- `pnpm --filter @nepo/ui dev` — UI dev server.

## Conventions

- Commit messages name the agent and system: `accounting: add period close and consolidation`.
- TypeScript strict, ESM, `.js` extensions on relative imports inside `packages/sim`.
- Tests live next to code as `*.test.ts`; property tests use fast-check.
