/**
 * Loan schedule and interest arithmetic (docs/design/finance.md sections 5, 6). Pure.
 *
 * Every money figure is produced by accounting's `scaleMoney`/`allocateMoney` (the only place a ratio
 * becomes money). Rates are plain floats, fixed for the life of a loan.
 */
import { allocateMoney, scaleMoney } from '../accounting/index.js';
import { DAYS_PER_YEAR } from '../engine/index.js';
import { InvariantError, ZERO_MONEY, minMoney, subMoney, type Money } from '../schema/index.js';

/** Grid that rates are rounded to (1e-6 = 0.01 basis points), ARCHITECTURE.md section 10. */
export const RATE_GRID = 1_000_000;

/** Rounds a float rate to `RATE_GRID` so `0.04 + 0.035` is stored as `0.075`, not `0.07500000000000001`. */
export function roundRate(rate: number): number {
  const r = Math.round(rate * RATE_GRID) / RATE_GRID;
  return r === 0 ? 0 : r; // never -0
}

/**
 * Principal due at the next scheduled payment (straight-line amortisation, finance.md section 6.3):
 * the whole `outstanding` when `monthsRemaining <= 1`, else the first part of
 * `allocateMoney(outstanding, [1, monthsRemaining - 1])`. Because each month re-splits what is left,
 * an early partial repayment automatically lowers every later instalment (the "reschedule").
 */
export function principalDue(outstanding: Money, monthsRemaining: number): Money {
  if (outstanding < 0) {
    throw new InvariantError('finance.negative_outstanding', 'outstanding must be >= 0', {
      outstanding,
    });
  }
  if (monthsRemaining <= 1) return outstanding;
  const [first] = allocateMoney(outstanding, [1, monthsRemaining - 1]);
  return first ?? ZERO_MONEY;
}

/**
 * The principal instalments of a loan paid on schedule with no prepayment: `termMonths` entries
 * summing exactly to `principal` (each from `principalDue` on the remaining balance).
 */
export function amortisationSchedule(principal: Money, termMonths: number): Money[] {
  if (!Number.isSafeInteger(termMonths) || termMonths < 1) {
    throw new InvariantError('finance.invalid_term', 'termMonths must be an integer >= 1', {
      termMonths,
    });
  }
  const out: Money[] = [];
  let left = principal;
  for (let m = termMonths; m >= 1; m--) {
    const due = principalDue(left, m);
    out.push(due);
    left = subMoney(left, due);
  }
  return out;
}

/**
 * Simple (non-compounding) interest on `outstanding` for `days` at `annualRate` on the 360-day year:
 * `scaleMoney(outstanding, annualRate × days / 360)`. Never negative for valid inputs.
 */
export function interestFor(outstanding: Money, annualRate: number, days: number): Money {
  if (outstanding <= 0 || days <= 0 || !(annualRate > 0)) return ZERO_MONEY;
  return scaleMoney(outstanding, (annualRate * days) / DAYS_PER_YEAR);
}

/** One day of overdraft interest on a negative cash balance (ADR-014). `0` when `cash >= 0`. */
export function overdraftInterest(cash: Money, overdraftAnnualRate: number): Money {
  if (cash >= 0) return ZERO_MONEY;
  return interestFor(subMoney(ZERO_MONEY, cash), overdraftAnnualRate, 1);
}

/** How an early repayment of `amount` splits: interest first, then principal (finance.md section 5). */
export interface RepaymentSplit {
  interest: Money;
  principal: Money;
}

export function splitRepayment(
  amount: Money,
  accruedInterest: Money,
  outstanding: Money,
): RepaymentSplit {
  const interest = minMoney(amount, accruedInterest);
  const principal = minMoney(subMoney(amount, interest), outstanding);
  return { interest, principal };
}
