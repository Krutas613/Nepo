# ADR-002: Money is a branded safe integer and moves only through the ledger

**Status:** Accepted (Milestone 0)

## Context

Rules 4 and 5: every money movement is a balanced double-entry posting and money is stored as integer
minor units. Floats cannot reconcile; `bigint` does not serialize to JSON, is slow, and cannot mix with
ordinary arithmetic. Rounding must happen in one place or balances drift between systems.

## Decision

- `Money = Brand<number, 'Money'>`, integer minor units (cents), may be negative. Every construction
  (`money(n)`), every `addMoney`/`subMoney`, and every ledger posting asserts `Number.isSafeInteger`;
  violation throws `InvariantError('money.unsafe')`. Scenarios are rejected if total starting cash
  exceeds 2^50, leaving three orders of magnitude before 2^53.
- No domain slice stores a cash balance. Cash is `accounting.balance(entity, ACCOUNTS.CASH)`.
  The only API that changes any balance is `AccountingApi.post`, which rejects unbalanced entries and
  applies atomically.
- Balances are stored debit-normal signed for all account types, so the per-entity invariant is simply
  `Σ balance === 0`.
- Rounding is owned by accounting: `scaleMoney(amount, ratio)` rounds half away from zero once at the
  end of a computation; `allocateMoney(total, weights)` uses largest-remainder with lowest-index
  tie-break so parts always sum to the total. No other module rounds money.
- Unit prices are `Money` per unit; content picks units so prices are at least one minor unit.

## Consequences

- Every system depends on accounting (dependency direction schema <- engine <- accounting <- domains).
- Interest and tax computations are integer-exact and reproducible; small per-day rounding bias is
  accepted and documented.
- Reaching 2^53 is a hard failure rather than silent corruption; game-design keeps scenario scale well
  below it.
