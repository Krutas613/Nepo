import { describe, expect, it } from 'vitest';
import {
  companyId,
  journalEntryId,
  money,
  type JournalEntryInput,
  type JournalLine,
} from '../schema/index.js';
import { ACCOUNTS } from './chart.js';
import {
  cashPurchase,
  cashSale,
  closingEntry,
  cr,
  creditPurchase,
  creditSale,
  depreciation,
  dr,
  interestAccrual,
  interestIncome,
  loanDrawdown,
  loanRepayment,
  openingCapital,
  payroll,
} from './builders.js';
import {
  createAccountingState,
  getBalance,
  getLedger,
  openEntity,
  postEntry,
  postEntryOrThrow,
  type LedgerEnv,
} from './ledger.js';
import { checkLedgerInvariants } from './invariants.js';

const A = companyId('co_000001');

function env(): LedgerEnv {
  let n = 0;
  return {
    tick: 0,
    issueEntryId: () => journalEntryId(`je_${String(++n).padStart(6, '0')}`),
    emit: () => undefined,
  };
}

function sides(lines: JournalLine[]): string[] {
  return lines.map((l) =>
    l.debit > 0 ? `Dr ${l.account} ${l.debit}` : `Cr ${l.account} ${l.credit}`,
  );
}

describe('dr / cr', () => {
  it('build one-sided lines', () => {
    expect(dr(ACCOUNTS.CASH, money(5))).toEqual({ account: '1000', debit: 5, credit: 0 });
    expect(cr(ACCOUNTS.CASH, money(5))).toEqual({ account: '1000', debit: 0, credit: 5 });
  });
});

describe('entry builders', () => {
  const m = money;
  const cases: [string, JournalEntryInput, string[]][] = [
    ['openingCapital', openingCapital(m(100), 'accounting'), ['Dr 1000 100', 'Cr 3000 100']],
    [
      'cashSale',
      cashSale(m(50), m(30), 'retail'),
      ['Dr 1000 50', 'Cr 4000 50', 'Dr 5000 30', 'Cr 1210 30'],
    ],
    ['cashSale without cogs', cashSale(m(50), m(0), 'retail'), ['Dr 1000 50', 'Cr 4000 50']],
    [
      'creditSale',
      creditSale(m(50), m(30), 'retail'),
      ['Dr 1100 50', 'Cr 4000 50', 'Dr 5000 30', 'Cr 1210 30'],
    ],
    [
      'cashPurchase',
      cashPurchase(ACCOUNTS.PPE, m(70), 'manufacturing'),
      ['Dr 1500 70', 'Cr 1000 70'],
    ],
    [
      'creditPurchase',
      creditPurchase(ACCOUNTS.INVENTORY_RAW, m(70), 'manufacturing'),
      ['Dr 1200 70', 'Cr 2000 70'],
    ],
    ['loanDrawdown', loanDrawdown(m(1000), 'finance'), ['Dr 1000 1000', 'Cr 2500 1000']],
    [
      'loanRepayment',
      loanRepayment(m(100), m(5), 'finance'),
      ['Dr 2500 100', 'Dr 2100 5', 'Cr 1000 105'],
    ],
    [
      'loanRepayment interest only',
      loanRepayment(m(0), m(5), 'finance'),
      ['Dr 2100 5', 'Cr 1000 5'],
    ],
    [
      'loanRepayment principal only',
      loanRepayment(m(100), m(0), 'finance'),
      ['Dr 2500 100', 'Cr 1000 100'],
    ],
    ['interestAccrual', interestAccrual(m(5), 'finance'), ['Dr 7000 5', 'Cr 2100 5']],
    ['interestIncome', interestIncome(m(5), 'finance'), ['Dr 1000 5', 'Cr 7100 5']],
    ['depreciation', depreciation(m(9), 'manufacturing'), ['Dr 6200 9', 'Cr 1590 9']],
    ['payroll', payroll(m(40), 'hr'), ['Dr 6100 40', 'Cr 1000 40']],
  ];

  for (const [name, input, expected] of cases) {
    it(`${name}: ${expected.join(', ')}`, () => {
      expect(sides(input.lines)).toEqual(expected);
      const state = createAccountingState();
      openEntity(state, A);
      expect(postEntry(state, A, input, env()).ok).toBe(true);
      expect(checkLedgerInvariants(state)).toEqual([]);
    });
  }

  it('applies memo and ref overrides', () => {
    const e = payroll(money(1), 'hr', {
      memo: 'June wages',
      ref: { kind: 'facility', id: 'fa_000001' },
    });
    expect(e).toEqual({
      memo: 'June wages',
      source: 'hr',
      ref: { kind: 'facility', id: 'fa_000001' },
      lines: [dr(ACCOUNTS.WAGES, money(1)), cr(ACCOUNTS.CASH, money(1))],
    });
    expect('ref' in payroll(money(1), 'hr')).toBe(false);
  });

  it('a zero amount yields an entry that post rejects as invalid_line', () => {
    const state = createAccountingState();
    openEntity(state, A);
    const r = postEntry(state, A, payroll(money(0), 'hr'), env());
    expect(!r.ok && r.error.code).toBe('invalid_line');
  });
});

describe('closingEntry', () => {
  it('returns null when every income account is zero', () => {
    const state = createAccountingState();
    openEntity(state, A);
    postEntryOrThrow(state, A, openingCapital(money(100), 'accounting'), env());
    expect(closingEntry(getLedger(state, A))).toBeNull();
  });

  it('moves every 4-7xxx balance into retained earnings (profit and loss)', () => {
    for (const [revenue, cost] of [
      [500, 200],
      [100, 400],
      [300, 300],
    ] as const) {
      const state = createAccountingState();
      openEntity(state, A);
      const e = env();
      postEntryOrThrow(state, A, openingCapital(money(1000), 'accounting'), e);
      postEntryOrThrow(state, A, cashSale(money(revenue), money(0), 'retail'), e);
      postEntryOrThrow(state, A, payroll(money(cost), 'hr'), e);
      postEntryOrThrow(state, A, interestIncome(money(7), 'finance'), e);
      const closing = closingEntry(getLedger(state, A));
      expect(closing).not.toBeNull();
      if (closing === null) return;
      expect(closing.source).toBe('accounting');
      postEntryOrThrow(state, A, closing, e);
      const ledger = getLedger(state, A);
      for (const code of Object.keys(ledger.accounts)) {
        if (code >= '4000')
          expect(ledger.accounts[code as typeof ACCOUNTS.CASH]?.balance, code).toBe(0);
      }
      // Net profit = revenue + 7 - cost, credited to 3100 (negative debit-normal balance).
      expect(getBalance(state, A, ACCOUNTS.RETAINED_EARNINGS)).toBe(-(revenue + 7 - cost));
      expect(checkLedgerInvariants(state)).toEqual([]);
    }
  });
});
