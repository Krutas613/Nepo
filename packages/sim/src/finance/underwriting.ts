/**
 * Underwriting (docs/design/finance.md section 4). Pure: every input (balance sheet, bank, policy
 * rate) is passed in, so the system, `FinanceApi` and UI previews share exactly one implementation.
 *
 * The balance sheet is accounting's (`AccountingApi.balanceSheet` / `accounting.balanceSheet(ledger)`),
 * never a private copy of the numbers.
 */
import { scaleMoney } from '../accounting/index.js';
import { sortedKeys, type DeepReadonly } from '../engine/index.js';
import {
  ZERO_MONEY,
  addMoney,
  err,
  money,
  ok,
  type Bank,
  type BalanceSheet,
  type ContentPack,
  type Money,
  type Result,
} from '../schema/index.js';
import { principalDue, roundRate } from './schedule.js';

export type UnderwritingCode =
  | 'no_bank'
  | 'invalid_term'
  | 'below_minimum'
  | 'insufficient_equity'
  | 'principal_too_large'
  | 'leverage_exceeded';

export interface UnderwritingRejection {
  code: UnderwritingCode;
  message: string;
}

export interface LoanQuote {
  principal: Money;
  termMonths: number;
  /** `policyRate + tier.spread`, rounded to `RATE_GRID`. Fixed for the life of the loan. */
  annualRate: number;
  /** Principal part of the first scheduled payment (straight line). */
  firstPrincipalDue: Money;
  /** `(liabilities + principal) / equity` after the draw. */
  leverageAfter: number;
}

export type ReadonlyBank = DeepReadonly<Bank>;
export type ReadonlyContentPack = DeepReadonly<ContentPack>;

/** The balance-sheet figures underwriting reads (a full `BalanceSheet` satisfies it). */
export type UnderwritingBalanceSheet = Pick<DeepReadonly<BalanceSheet>, 'equity' | 'liabilities'>;

/**
 * The bank that serves every company: M1 has exactly one, and with several the lowest `BankId`
 * (`sortedKeys` order) is used. `null` when content has no bank.
 */
export function bankOf(content: ReadonlyContentPack): ReadonlyBank | null {
  const banks = content.finance.banks;
  const [first] = sortedKeys(banks);
  return first === undefined ? null : (banks[first] ?? null);
}

/** `policyRate + spread`, rounded to the rate grid. */
export function annualRateFor(policyRate: number, spread: number): number {
  return roundRate(policyRate + spread);
}

function reject(code: UnderwritingCode, message: string): Result<never, UnderwritingRejection> {
  return err({ code, message });
}

/**
 * `assessLoan` (finance.md section 4): rejections in order `invalid_term`, `below_minimum`,
 * `insufficient_equity`, `principal_too_large`, `leverage_exceeded`; otherwise a quote at the first
 * tier whose `maxLeverage >= leverage after the draw`.
 *
 * `insufficient_equity` also covers `equity <= 0` whatever `minEquity` says, so leverage is never a
 * division by zero or by a negative number.
 */
export function assessLoan(
  bs: UnderwritingBalanceSheet,
  principal: Money,
  termMonths: number,
  bank: ReadonlyBank,
  policyRate: number,
): Result<LoanQuote, UnderwritingRejection> {
  if (
    !Number.isSafeInteger(termMonths) ||
    termMonths < bank.minTermMonths ||
    termMonths > bank.maxTermMonths
  ) {
    return reject(
      'invalid_term',
      `term ${String(termMonths)} months is outside ${String(bank.minTermMonths)}..${String(bank.maxTermMonths)}`,
    );
  }
  if (principal < bank.minPrincipal) {
    return reject(
      'below_minimum',
      `principal ${String(principal)} is below the minimum ${String(bank.minPrincipal)}`,
    );
  }
  const equity = bs.equity;
  if (equity < bank.minEquity || equity <= 0) {
    return reject(
      'insufficient_equity',
      `equity ${String(equity)} is below the minimum ${String(bank.minEquity)}`,
    );
  }
  const cap = scaleMoney(equity, bank.maxPrincipalToEquity);
  if (principal > cap) {
    return reject(
      'principal_too_large',
      `principal ${String(principal)} exceeds ${String(cap)} (equity x ${String(bank.maxPrincipalToEquity)})`,
    );
  }
  const leverage = addMoney(bs.liabilities, principal) / equity;
  const tier = bank.spreadTiers.find((t) => leverage <= t.maxLeverage);
  if (tier === undefined) {
    return reject(
      'leverage_exceeded',
      `leverage after the loan ${leverage.toFixed(3)} exceeds every tier of ${bank.name}`,
    );
  }
  return ok({
    principal,
    termMonths,
    annualRate: annualRateFor(policyRate, tier.spread),
    firstPrincipalDue: principalDue(principal, termMonths),
    leverageAfter: leverage,
  });
}

/**
 * The largest principal `assessLoan` accepts at the bank's `maxTermMonths` (finance.md section 7),
 * by binary search over integers (acceptance is monotone in principal: both the equity cap and the
 * leverage test only get harder as principal grows). `0` when even `minPrincipal` is refused.
 */
export function availableCreditFor(bs: UnderwritingBalanceSheet, bank: ReadonlyBank): Money {
  const accepts = (p: number): boolean => assessLoan(bs, money(p), bank.maxTermMonths, bank, 0).ok;
  let lo: number = bank.minPrincipal;
  if (!accepts(lo)) return ZERO_MONEY;
  // The equity cap is an upper bound on any accepted principal.
  let hi: number = Math.max(lo, scaleMoney(bs.equity, bank.maxPrincipalToEquity));
  if (accepts(hi)) return money(hi);
  // Invariant: accepts(lo) && !accepts(hi). At most ~53 iterations for safe integers.
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (accepts(mid)) lo = mid;
    else hi = mid;
  }
  return money(lo);
}

/**
 * UI preview (player-flow.md "Bank" view): underwrite a hypothetical loan from content, a balance
 * sheet and the policy rate, with the same rules and rejection codes as `loan.request`
 * (including `no_bank`).
 */
export function previewLoan(
  content: ReadonlyContentPack,
  bs: UnderwritingBalanceSheet,
  policyRate: number,
  principal: Money,
  termMonths: number,
): Result<LoanQuote, UnderwritingRejection> {
  const bank = bankOf(content);
  if (bank === null) return reject('no_bank', 'no bank is available');
  return assessLoan(bs, principal, termMonths, bank, policyRate);
}
