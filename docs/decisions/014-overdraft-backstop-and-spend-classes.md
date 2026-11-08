# ADR-014: Negative cash is covered by a bank overdraft; discretionary spend never uses it

**Status:** Accepted (Milestone 1 design)

## Context

Daily operating costs, interest and scheduled repayments are posted whether or not the company has
cash. The qa invariant "no negative cash without credit" needs a definition of "credit". Options:
(a) refuse to post non-discretionary costs when cash is short (facilities silently stop paying, books
understate costs); (b) immediate bankruptcy at cash < 0 (brutal for a one-day timing gap); (c) an
implicit bank overdraft up to a limit, at a penalty rate, with insolvency flagged beyond the limit.

## Decision

Option (c), owned by finance.

- Every spend is one of two classes. **Discretionary** (builds, input purchases, early loan
  repayments, M3 dividends and acquisitions) requires `cash ≥ amount` at posting time; otherwise the
  command is rejected (`insufficient_cash`) or the purchase is scaled down. **Non-discretionary**
  (daily operating cost, depreciation, interest accrual, scheduled loan payments, overdraft interest)
  is always posted.
- The bank definition (`data/finance/banks.json`) carries `overdraftLimit: Money` and
  `overdraftAnnualRate`. In the `finance` phase, for every company with `cash < 0`, finance marks
  `credit[c].overdrawnSince` (emits `credit.overdrawn` on entry), accrues
  `scaleMoney(−cash, overdraftAnnualRate / 360)` daily (Dr 7000 / Cr 2100) and settles the accrual at
  month end; when `cash ≥ 0` it clears the flag (`credit.restored`). If `cash < −overdraftLimit`,
  finance marks `insolventSince` and emits `credit.insolvent`; a scheduled loan payment that would
  push cash below `−overdraftLimit` is **missed** instead (ADR-level default path: `loan.payment_missed`,
  penalty spread, `loan.defaulted` after `defaultAfterMissed` consecutive misses).
- M1 stops at the event. Restructuring, asset seizure and bankruptcy liquidation are M3 and will
  consume the same `credit` record.

## Consequences

- qa invariant 3 becomes exact: after every tick, for every company, `cash < 0 ⇒ finance.credit[c].overdrawnSince !== null`,
  and `cash < −overdraftLimit ⇒ insolventSince !== null`. The sweep reports the count of
  `credit.insolvent` events as a metric.
- Cash can go below `−overdraftLimit` by at most one day of non-discretionary postings; this is
  accepted and visible.
- Systems must classify each posting they make; the design docs list the class per posting.
