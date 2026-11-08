# Accounting design notes (Milestone 0)

Companion to ARCHITECTURE.md section 8. Owner of the code: `accounting`. State types live in
`schema/accounting.ts`; this document fixes the template, formulas and helpers.

## 1. Standard chart of accounts (`STANDARD_CHART`, `ACCOUNTS`)

| Code | Name                        | Type                                              | `ACCOUNTS.`        |
| ---- | --------------------------- | ------------------------------------------------- | ------------------ |
| 1000 | Cash                        | asset                                             | CASH               |
| 1100 | Accounts Receivable         | asset                                             | RECEIVABLES        |
| 1200 | Inventory - Raw Materials   | asset                                             | INVENTORY_RAW      |
| 1205 | Inventory - Work in Progress (M1, ADR-012) | asset                              | INVENTORY_WIP      |
| 1210 | Inventory - Finished Goods  | asset                                             | INVENTORY_FINISHED |
| 1220 | Inventory - In Transit      | asset                                             | INVENTORY_TRANSIT  |
| 1230 | Inventory - Merchandise (store shelves; M1, ADR-012) | asset                    | INVENTORY_MERCHANDISE |
| 1500 | Property, Plant & Equipment | asset                                             | PPE                |
| 1590 | Accumulated Depreciation    | asset (contra, credit balance)                    | ACCUM_DEPRECIATION |
| 1800 | Investments in Subsidiaries | asset                                             | INVESTMENTS        |
| 1900 | Intercompany Receivable     | asset                                             | INTERCO_RECEIVABLE |
| 2000 | Accounts Payable            | liability                                         | PAYABLES           |
| 2100 | Accrued Interest Payable    | liability                                         | INTEREST_PAYABLE   |
| 2200 | Income Tax Payable          | liability                                         | TAX_PAYABLE        |
| 2500 | Loans Payable               | liability                                         | LOANS              |
| 2900 | Intercompany Payable        | liability                                         | INTERCO_PAYABLE    |
| 3000 | Share Capital               | equity                                            | SHARE_CAPITAL      |
| 3100 | Retained Earnings           | equity                                            | RETAINED_EARNINGS  |
| 4000 | Sales Revenue               | revenue                                           | SALES              |
| 4900 | Intercompany Revenue        | revenue                                           | INTERCO_SALES      |
| 5000 | Cost of Goods Sold          | expense                                           | COGS               |
| 5900 | Intercompany COGS           | expense                                           | INTERCO_COGS       |
| 6000 | Facility Operating Expense  | expense                                           | OPEX_FACILITY      |
| 6100 | Wages and Salaries          | expense                                           | WAGES              |
| 6200 | Depreciation Expense        | expense                                           | DEPRECIATION       |
| 6300 | Marketing                   | expense                                           | MARKETING          |
| 6900 | Other Operating Expense     | expense                                           | OPEX_OTHER         |
| 7000 | Interest Expense            | expense                                           | INTEREST_EXPENSE   |
| 7100 | Interest Income             | expense (credit balance; reported in otherIncome) | INTEREST_INCOME    |
| 7500 | Gain/Loss on Disposal       | expense                                           | DISPOSAL_GAIN_LOSS |
| 7900 | Income Tax Expense          | expense                                           | INCOME_TAX         |

`accountTypeOf(code)`: `1`->asset, `2`->liability, `3`->equity, `4`->revenue, `5|6|7`->expense.
Adding accounts is an accounting-module change; codes are never renumbered.

## 2. Posting rules

`post(entityId, input)` validation order and error codes: `unknown_entity`; `empty` (fewer than 2
lines); `invalid_line` (a side not a positive safe integer, both sides non-zero, both zero);
`unknown_account`; `unbalanced` (`Σ debit !== Σ credit`); `overflow` (a resulting balance fails
`Number.isSafeInteger`). Validation is complete before any mutation. On success: `id = handle.issueId('journalEntry')`,
`tick = handle.tick()`, push to `journal`, apply `balance += debit - credit` per line, emit
`ledger.posted`. Entries are never edited or deleted; corrections are reversing entries.

Builders (all return `JournalEntryInput`, all take `source: SystemId`):

| Builder                                        | Lines                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `openingCapital(amount)`                       | Dr 1000 / Cr 3000                                                                                                                          |
| `cashSale(revenue, cogs)`                      | Dr 1000 revenue, Cr 4000 revenue; Dr 5000 cogs, Cr 1210 cogs (cogs may be 0: omit pair)                                                    |
| `cashPurchase(account, amount)`                | Dr `account` / Cr 1000                                                                                                                     |
| `loanDrawdown(amount)`                         | Dr 1000 / Cr 2500                                                                                                                          |
| `loanRepayment(principal, interest)`           | Dr 2500 principal, Dr 2100 interest (if accrued) / Cr 1000 total                                                                           |
| `interestAccrual(amount)`                      | Dr 7000 / Cr 2100                                                                                                                          |
| `interestIncome(amount)`                       | Dr 1000 / Cr 7100                                                                                                                          |
| `depreciation(amount)`                         | Dr 6200 / Cr 1590                                                                                                                          |
| `payroll(amount)`                              | Dr 6100 / Cr 1000                                                                                                                          |
| `creditSale(revenue, cogs)`                    | Dr 1100 revenue, Cr 4000 revenue; Dr 5000 cogs, Cr 1210 cogs (cogs may be 0: omit pair)                                                    |
| `creditPurchase(account, amount)`              | Dr `account` / Cr 2000                                                                                                                     |
| `makeJournalEntry(lines, source, memo, meta?)` | generic assembler every builder uses; `meta` = `{ memo?, ref? }`                                                                           |
| `closingEntry(entity)`                         | moves every non-zero 4-7xxx balance to 3100, ascending code order; `null` if nothing to close (built and posted by accounting at year end) |
| **M1 additions (ADR-012, design docs)**        |                                                                                                                                            |
| `capex(amount)`                                | Dr 1500 / Cr 1000 (facility or store build; manufacturing, retail)                                                                        |
| `inventoryPurchase(amount)`                    | Dr 1200 / Cr 1000 (raw materials bought from the commodity source; manufacturing)                                                          |
| `productionStart(materials, labor)`            | Dr 1205 `materials + labor` / Cr 1200 `materials` / Cr 1000 `labor` (labour line omitted when 0; manufacturing)                            |
| `productionComplete(amount)`                   | Dr 1210 / Cr 1205 (manufacturing)                                                                                                          |
| `internalTransfer(amount, destination)`        | Dr `destination` (M1: 1230) / Cr 1210 (posted by manufacturing inside `withdraw`; M2 logistics uses 1220)                                 |
| `retailSale(revenue, cogs)`                    | Dr 1000 / Cr 4000 `revenue`; Dr 5000 / Cr 1230 `cogs` (cogs may be 0: omit pair; retail)                                                   |
| `inventoryWriteOff(account, amount)`           | Dr 6900 / Cr `account` (shrinkage, spoilage; retail, manufacturing)                                                                        |

Spend classes (ADR-014): `capex`, `inventoryPurchase`, `productionStart` (labour), `loanRepayment` from
`loan.repay` are discretionary (caller checks `cash >= amount` first); `cashPurchase(OPEX_*)`,
`depreciation`, `interestAccrual`, scheduled `loanRepayment`, `inventoryWriteOff` are non-discretionary.

Builders are reachable as `accounting.payroll(...)` from the sim root or by name from
`@nepo/sim/accounting` (ARCHITECTURE.md section 1 public-surface policy); their generic names are
intentional and will not be prefixed.

### Period-end postings by other systems (ADR-009)

`close` is accounting-only. A domain system that posts on a period boundary (depreciation, rent,
payroll runs, finance's tax provision) posts in its **own phase** when `ctx.date.isMonthEnd` (or
`isQuarterEnd`/`isYearEnd`). Accounting guarantees in return that, when `close` runs, every entry of
the day is already in the ledger: it is included in that month's report and precedes the year-end
closing entry. Accounting must not assume anything about _which_ phase an entry came from; it only
relies on the engine's phase order.

## 3. Statements

Let `mv(code) = balance(code) - monthOpening[code]` (or `yearOpening` / quarter opening for other
kinds). Sign convention: revenue accounts have negative (credit) balances, so amounts below are
presented positive by negating credit-normal figures.

- `revenue = -(Σ mv over 4xxx)`; `cogs = Σ mv over 5xxx`; `grossProfit = revenue - cogs`;
  `opex = Σ mv over 6xxx`; `operatingIncome = grossProfit - opex`;
  `otherIncome = -(Σ mv over 70xx..75xx)` (interest expense negative, interest income positive);
  `pretaxIncome = operatingIncome + otherIncome`; `incomeTax = Σ mv over 79xx`;
  `netIncome = pretaxIncome - incomeTax`. `byAccount` holds `mv` per 4-7xxx account.
- Balance sheet: `assets = Σ balance over 1xxx`; `liabilities = -(Σ balance over 2xxx)`;
  `equity = -(Σ balance over 3xxx) + (undistributed current-year 4-7xxx) = -(Σ balance over 3xxx + Σ balance over 4-7xxx)`.
  Because Σ all balances === 0, `assets === liabilities + equity` holds identically; the test asserts it
  from the report fields anyway.
- Cash flow (indirect), over the same period. Because every balance is stored debit-normal, the cash
  effect of any non-cash balance-sheet account over the period is simply `cashEffect(code) = -mv(code)`
  (an asset increase consumes cash; a liability increase, stored as a more negative balance, releases
  cash; depreciation shows up as a negative `mv(1590)` and is thereby added back). Then:
  `operating = netIncome + Σ cashEffect over {1100, 1200, 1210, 1220, 1590, 1900, 2000, 2100, 2200, 2900}`;
  `investing = Σ cashEffect over {1500, 1800}`;
  `financing = Σ cashEffect over {2500, 3000} + dividends` where dividends are 3100 movements other than
  the closing entry (M3; 0 in M0);
  `netChange = operating + investing + financing`; `openingCash = monthOpening[1000]`;
  `closingCash = balance(1000)`. Invariant: `netChange === closingCash - openingCash` (exact, integers).
  The year-end closing entry moves 4-7xxx into 3100 and must be excluded from `mv` of the `year` report
  (compute the report before posting it).

## 4. Rounding helpers

- `roundHalfAwayFromZero(x: number): number` on a finite float: `sign(x) * floor(abs(x) + 0.5)`.
- `scaleMoney(amount, ratio)`: `money(roundHalfAwayFromZero(amount * ratio))`; `ratio` must be finite.
- `allocateMoney(total, weights)`: weights non-negative finite, `Σ > 0`; `raw_i = total * w_i / Σw`;
  `base_i = trunc(raw_i)`; distribute the remaining `total - Σ base` one unit at a time to the largest
  fractional remainders, ties to the lowest index; sign-aware for negative totals. Property:
  `Σ result === total`, `|result_i - raw_i| < 1`.

## 5. Period close in the `close` phase

```
if !date.isMonthEnd return
for entityId of sortedKeys(entities):
  month = report('month', monthOpening); append month
  if date.isQuarterEnd: append combineReports('quarter', monthReportsOfThisQuarter)   // see below
  if date.isYearEnd: yearReport = report('year', yearOpening); post closingEntry (if non-null); append yearReport; yearOpening = balances
  monthOpening = balances
  emit period.closed per appended report, in append order
```

**Quarter reports are the sum of the quarter's month reports** (decided; no quarter-opening balances
are stored). `combineReports` adds every flow figure (`IncomeStatement` lines and `byAccount`,
`CashFlowStatement` sections and `netChange`), takes `openingCash` from the first month report and the
`BalanceSheet` and `closingCash` from the last. This is exact because every statement figure is linear
in the period's movements and all arithmetic is integer. The month reports of the current quarter are
found by scanning `reports` backwards for `kind === 'month'` with the same `year` and `month` in the
quarter's range; the current month's report is appended first so it is included. An entity opened
mid-quarter has fewer month reports in that quarter (its balances were zero before). A quarter end with
no month report is `InvariantError('accounting.quarter_without_months')`. The `year` report is **not** a
sum: it is computed from `yearOpening` before the closing entry is posted; the two methods agree by
linearity, which a test may assert.

## 6. Invariants and tests

`checkLedgerInvariants(state)` returns `[]` or a list of `LedgerInvariantViolation`
`{ code, entityId?, entryId?, message }` with `LedgerInvariantCode` one of `entity.unbalanced`
(Σ balance !== 0), `entry.unbalanced`, `entry.invalid_line`, `entry.unknown_account`,
`balance.unsafe`, `report.cashflow_mismatch`, `report.identity_mismatch`. (Named
`LedgerInvariantViolation`, not `InvariantViolation`, so it reads unambiguously next to the engine's
`InvariantError`; that name stays even under the namespace policy.)

## 7. Service implementation rules

`AccountingApi` is a thin adapter over the pure ledger functions through the engine's `ServiceHandle`.
Mutating methods (`openEntity`, `post`, `postOrThrow`) use `handle.slice()`; read-only methods
(`balance`, `cash`, `hasEntity`, and the M1 queries `balanceSheet(entityId): BalanceSheet` (live, from
current balances via the pure `balanceSheet(ledger)`) and `latestReport(entityId, kind: PeriodKind):
PeriodReport | null` (last appended report of that kind), requested by finance) read through `handle.state().accounting`, because
`handle.slice()` marks the slice as legitimately written for the caller's phase and would disable the
engine's foreign-write check for a caller that only queried (ARCHITECTURE.md section 6.2). The service
keeps no state of its own. Iteration inside accounting uses `Object.keys(x).sort()` or the engine's
`sortedKeys`; both are the same UTF-16 code-unit order, and the ledger's pure functions may use the
former so they stay independent of the engine.

Tests: posting validation table (one case per error code); fast-check property generating random
balanced entries over the standard chart for 1-3 entities and asserting all invariants after each post
and that `post` of a random **unbalanced** entry returns `err` without changing state; rounding and
allocation properties; period close over 720 ticks of `SMOKE_SCENARIO` with a scripted daily posting
(use `step` with the real engine) checking report counts (24 month, 8 quarter, 2 year), cash-flow
reconciliation and that 4-7xxx balances are 0 after each year end.
