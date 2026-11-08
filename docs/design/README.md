# Design docs

One document per system, written by `architect` (or the owning domain agent with architect review) before implementation starts. Each covers: purpose, state owned, commands handled, events emitted, tick-phase participation, interfaces exposed to other systems, determinism notes, invariants qa will check, and tests the owner must ship. Tunable parameters live in `data/`, never in code.

| Doc                | Owner of the code | Milestone |
| ------------------ | ----------------- | --------- |
| `engine.md`        | engine            | 0         |
| `accounting.md`    | accounting        | 0 (M1 additions in sections 1, 2, 7) |
| `economy.md`       | economy           | 1         |
| `manufacturing.md` | manufacturing     | 1         |
| `retail.md`        | retail            | 1         |
| `finance.md`       | finance           | 1         |
| `player-flow.md`   | ui + sim root     | 1         |
| `schema-m1.md`     | schema (request)  | 1         |

Related ADRs for M1: 010 (content in scenario), 011 (price discovery), 012 (inventory valuation and holder accounts), 013 (M1 direct transfer), 014 (overdraft and spend classes).
