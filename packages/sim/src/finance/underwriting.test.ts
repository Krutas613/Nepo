import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, cashPurchase, creditPurchase } from '../accounting/index.js';
import { EMPTY_CONTENT_PACK, M1_CONTENT_PACK, money, type Bank } from '../schema/index.js';
import { BANK, PLAYER, makeLedgerEnv } from './test-helpers.js';
import {
  annualRateFor,
  assessLoan,
  availableCreditFor,
  bankOf,
  previewLoan,
  type UnderwritingBalanceSheet,
} from './underwriting.js';

const bs = (equity: number, liabilities = 0): UnderwritingBalanceSheet => ({
  equity: money(equity),
  liabilities: money(liabilities),
});

const codeOf = (r: ReturnType<typeof assessLoan>): string => (r.ok ? 'ok' : r.error.code);

describe('assessLoan', () => {
  // M1 bank: tiers 0.5/0.02, 1.0/0.035, 2.0/0.05; minPrincipal 100,000; terms 6..60; P/E <= 1.
  it('returns each rejection code in the documented order', () => {
    expect(codeOf(assessLoan(bs(1_000_000), money(100_000), 5, BANK, 0.04))).toBe('invalid_term');
    expect(codeOf(assessLoan(bs(1_000_000), money(100_000), 61, BANK, 0.04))).toBe('invalid_term');
    expect(codeOf(assessLoan(bs(0), money(1), 61, BANK, 0.04))).toBe('invalid_term');
    expect(codeOf(assessLoan(bs(0), money(99_999), 12, BANK, 0.04))).toBe('below_minimum');
    expect(codeOf(assessLoan(bs(0), money(100_000), 12, BANK, 0.04))).toBe('insufficient_equity');
    expect(codeOf(assessLoan(bs(-5), money(100_000), 12, BANK, 0.04))).toBe('insufficient_equity');
    expect(codeOf(assessLoan(bs(1_000_000), money(1_000_001), 12, BANK, 0.04))).toBe(
      'principal_too_large',
    );
    // leverage (1.5M + 1M) / 1M = 2.5 > 2
    expect(codeOf(assessLoan(bs(1_000_000, 1_500_000), money(1_000_000), 12, BANK, 0.04))).toBe(
      'leverage_exceeded',
    );
  });

  it('a zero minEquity still refuses non-positive equity (no division by zero)', () => {
    const bank: Bank = { ...BANK, minEquity: money(0) };
    expect(codeOf(assessLoan(bs(0), money(100_000), 12, bank, 0.04))).toBe('insufficient_equity');
  });

  it('selects tiers inclusively at the boundaries', () => {
    const at = (liabilities: number, principal: number) =>
      assessLoan(bs(1_000_000, liabilities), money(principal), 12, BANK, 0.04);
    const rateAt = (l: number, p: number): number => {
      const r = at(l, p);
      if (!r.ok) throw new Error(r.error.code);
      return r.value.annualRate;
    };
    expect(rateAt(0, 500_000)).toBe(0.06); // leverage 0.5 exactly -> tier 1
    expect(rateAt(1, 500_000)).toBe(0.075); // just above 0.5 -> tier 2
    expect(rateAt(0, 1_000_000)).toBe(0.075); // 1.0 exactly -> tier 2
    expect(rateAt(1, 1_000_000)).toBe(0.09); // just above 1.0 -> tier 3
    expect(rateAt(1_000_000, 1_000_000)).toBe(0.09); // 2.0 exactly -> tier 3
    expect(codeOf(at(1_000_001, 1_000_000))).toBe('leverage_exceeded');
  });

  it('quotes the rate, first instalment and leverage', () => {
    const r = assessLoan(bs(50_000_000), money(12_000_000), 6, BANK, 0.04);
    expect(r).toEqual({
      ok: true,
      value: {
        principal: 12_000_000,
        termMonths: 6,
        annualRate: 0.06,
        firstPrincipalDue: 2_000_000,
        leverageAfter: 0.24,
      },
    });
    expect(annualRateFor(0.04, 0.035)).toBe(0.075);
  });

  it('previewLoan uses the content bank and reports no_bank without one', () => {
    expect(codeOf(previewLoan(EMPTY_CONTENT_PACK, bs(1_000_000), 0.04, money(100_000), 12))).toBe(
      'no_bank',
    );
    expect(codeOf(previewLoan(M1_CONTENT_PACK, bs(1_000_000), 0.04, money(100_000), 12))).toBe(
      'ok',
    );
    expect(bankOf(EMPTY_CONTENT_PACK)).toBeNull();
    expect(bankOf(M1_CONTENT_PACK)?.id).toBe(BANK.id);
  });
});

describe('availableCreditFor', () => {
  it('is capped by equity x maxPrincipalToEquity, or by leverage', () => {
    expect(availableCreditFor(bs(10_000_000), BANK)).toBe(10_000_000);
    // leverage cap: (9M + p) / 10M <= 2 -> p <= 11M, but the P/E cap is 10M
    expect(availableCreditFor(bs(10_000_000, 9_000_000), BANK)).toBe(10_000_000);
    // (15M + p) / 10M <= 2 -> p <= 5M
    expect(availableCreditFor(bs(10_000_000, 15_000_000), BANK)).toBe(5_000_000);
    expect(availableCreditFor(bs(50_000), BANK)).toBe(0);
    expect(availableCreditFor(bs(0), BANK)).toBe(0);
  });

  it('property: equals the largest principal assessLoan accepts, over real ledgers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 150_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        (cash, payables, spent) => {
          // Equity from capital minus an expense; liabilities from a credit purchase.
          const env = makeLedgerEnv([{ id: PLAYER, cash }]);
          if (payables > 0) {
            env.accounting.postOrThrow(
              PLAYER,
              creditPurchase(ACCOUNTS.INVENTORY_RAW, money(payables), 'retail'),
            );
          }
          if (spent > 0) {
            env.accounting.postOrThrow(
              PLAYER,
              cashPurchase(ACCOUNTS.OPEX_OTHER, money(spent), 'retail'),
            );
          }
          const sheet = env.accounting.balanceSheet(PLAYER);
          const best = availableCreditFor(sheet, BANK);
          const accepts = (p: number): boolean =>
            assessLoan(sheet, money(p), BANK.maxTermMonths, BANK, 0.04).ok;
          if (best === 0) {
            expect(accepts(BANK.minPrincipal)).toBe(false);
          } else {
            expect(accepts(best)).toBe(true);
            expect(accepts(best + 1)).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
