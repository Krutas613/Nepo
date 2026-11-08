# ADR-009: `close` is accounting-only; domain period-end postings happen in the poster's own phase

**Status:** Accepted (Milestone 0 review)

## Context

ARCHITECTURE.md originally let any system hook the `close` phase "for month-end postings
(depreciation)". Within a phase systems run in `SYSTEM_ORDER`, where `accounting` comes first. So a
domain system posting in `close` posts **after** accounting has computed the month's statements and
rolled `monthOpening`: the entry lands in the next month's report, and on a year end it is posted
after the closing entry, leaving 4-7xxx balances non-zero in the new year. Nothing posts there in M0,
but every M1 domain agent would meet this. Three fixes were weighed: (a) reserve `close` for
accounting and have domain systems post period-end entries in their own earlier phase when
`ctx.date.isMonthEnd`; (b) split `close` into `close:pre` (domain) and `close` (accounting); (c) run
accounting last in `close` by reversing `SYSTEM_ORDER` for that phase only.

## Decision

Option (a).

- The `close` phase may be registered only by the system with `id: 'accounting'`. The engine enforces
  this at `createWorld`/`restore` with `InvariantError('systems.close_reserved')`, the same way it
  reserves `ingest`/`finalize` and the `core` id.
- A domain system that must post on a period boundary (depreciation, rent, payroll runs, tax
  provisions) does so in its **own normal phase** on the tick whose `ctx.date` has `isMonthEnd` (or
  `isQuarterEnd`/`isYearEnd`). Every domain phase precedes `close`, so the entry is in that period's
  statements and before the year-end closing entry.
- Readers that need freshly closed statements the same tick (`ai` in `decide`, the UI after `step`)
  already run after `close`. A system that runs before `close` (finance) reads the previous period's
  report, a one-day lag that is intended and deterministic.

## Why not (b) or (c)

(b) adds a phase whose only purpose is ordering that the existing phases already provide; it would
also tempt systems to defer work to "the end of the day" and couple it to accounting's timing.
(c) makes one phase run in a different order from every other, a rule readers would not expect and the
ownership check and phase-order tests would have to special-case; it also still lets a domain system
post after another domain system's close-time reads.

## Consequences

- The engine names a domain system id (`accounting`) in one validation; this is accepted as the price
  of an enforceable rule.
- Accounting's period-close contract is simple: at the time `close` runs, the day's books are complete.
- Design docs for M1 systems must state in which phase their period-end postings occur.
