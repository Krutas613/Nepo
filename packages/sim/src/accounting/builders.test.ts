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
  SPEND_CLASS,
  canSpend,
  capex,
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
  internalTransfer,
  inventoryPurchase,
  inventoryWriteOff,
  loanDrawdown,
  loanRepayment,
  openingCapital,
  payroll,
  productionComplete,
  productionStart,
  retailSale,
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
    // Design-doc notation: `1000` denotes the stored code `'a1000'`.
    l.debit > 0 ? `Dr ${l.account.slice(1)} ${l.debit}` : `Cr ${l.account.slice(1)} ${l.credit}`,
  );
}

describe('dr / cr', () => {
  it('build one-sided lines', () => {
    expect(dr(ACCOUNTS.CASH, money(5))).toEqual({ account: 'a1000', debit: 5, credit: 0 });
    expect(cr(ACCOUNTS.CASH, money(5))).toEqual({ account: 'a1000', debit: 0, credit: 5 });
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
    // M1 (ADR-012, design doc section 2 table)
    ['capex', capex(m(900), 'manufacturing'), ['Dr 1500 900', 'Cr 1000 900']],
    ['inventoryPurchase', inventoryPurchase(m(80), 'manufacturing'), ['Dr 1200 80', 'Cr 1000 80']],
    [
      'productionStart',
      productionStart(m(60), m(15), 'manufacturing'),
      ['Dr 1205 75', 'Cr 1200 60', 'Cr 1000 15'],
    ],
    [
      'productionStart without labour',
      productionStart(m(60), m(0), 'manufacturing'),
      ['Dr 1205 60', 'Cr 1200 60'],
    ],
    [
      'productionStart without materials',
      productionStart(m(0), m(15), 'manufacturing'),
      ['Dr 1205 15', 'Cr 1000 15'],
    ],
    [
      'productionComplete',
      productionComplete(m(75), 'manufacturing'),
      ['Dr 1210 75', 'Cr 1205 75'],
    ],
    [
      'internalTransfer to merchandise',
      internalTransfer(m(40), ACCOUNTS.INVENTORY_MERCHANDISE, 'manufacturing'),
      ['Dr 1230 40', 'Cr 1210 40'],
    ],
    [
      'internalTransfer to transit',
      internalTransfer(m(40), ACCOUNTS.INVENTORY_TRANSIT, 'logistics'),
      ['Dr 1220 40', 'Cr 1210 40'],
    ],
    [
      'retailSale',
      retailSale(m(120), m(40), 'retail'),
      ['Dr 1000 120', 'Cr 4000 120', 'Dr 5000 40', 'Cr 1230 40'],
    ],
    ['retailSale without cogs', retailSale(m(120), m(0), 'retail'), ['Dr 1000 120', 'Cr 4000 120']],
    [
      'inventoryWriteOff',
      inventoryWriteOff(ACCOUNTS.INVENTORY_MERCHANDISE, m(3), 'retail'),
      ['Dr 6900 3', 'Cr 1230 3'],
    ],
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

  it('M1 builders set the posting source and a default memo', () => {
    const built = [
      capex(m(1), 'manufacturing'),
      inventoryPurchase(m(1), 'manufacturing'),
      productionStart(m(1), m(1), 'manufacturing'),
      productionComplete(m(1), 'manufacturing'),
      internalTransfer(m(1), ACCOUNTS.INVENTORY_MERCHANDISE, 'manufacturing'),
      retailSale(m(1), m(1), 'retail'),
      inventoryWriteOff(ACCOUNTS.INVENTORY_RAW, m(1), 'retail'),
    ];
    expect(built.map((e) => e.memo)).toEqual([
      'Capital expenditure',
      'Inventory purchase',
      'Production start',
      'Production complete',
      'Internal transfer',
      'Retail sale',
      'Inventory write-off',
    ]);
    expect(built.map((e) => e.source)).toEqual([
      'manufacturing',
      'manufacturing',
      'manufacturing',
      'manufacturing',
      'manufacturing',
      'retail',
      'retail',
    ]);
    const ref = { kind: 'facility', id: 'fa_000001' };
    expect(capex(m(1), 'manufacturing', { memo: 'Build', ref })).toMatchObject({
      memo: 'Build',
      ref,
    });
  });

  it('the ADR-012 goods flow keeps every holder account at its lot value', () => {
    const state = createAccountingState();
    openEntity(state, A);
    const e = env();
    const post = (x: JournalEntryInput): void => {
      postEntryOrThrow(state, A, x, e);
    };
    post(openingCapital(m(10_000), 'accounting'));
    post(capex(m(3_000), 'manufacturing'));
    post(inventoryPurchase(m(500), 'manufacturing'));
    post(productionStart(m(400), m(100), 'manufacturing'));
    post(productionComplete(m(500), 'manufacturing'));
    post(internalTransfer(m(300), ACCOUNTS.INVENTORY_MERCHANDISE, 'manufacturing'));
    post(retailSale(m(450), m(200), 'retail'));
    post(inventoryWriteOff(ACCOUNTS.INVENTORY_MERCHANDISE, m(10), 'retail'));
    const bal = (c: typeof ACCOUNTS.CASH): number => getBalance(state, A, c);
    expect(bal(ACCOUNTS.CASH)).toBe(10_000 - 3_000 - 500 - 100 + 450);
    expect(bal(ACCOUNTS.PPE)).toBe(3_000);
    expect(bal(ACCOUNTS.INVENTORY_RAW)).toBe(100);
    expect(bal(ACCOUNTS.INVENTORY_WIP)).toBe(0);
    expect(bal(ACCOUNTS.INVENTORY_FINISHED)).toBe(200);
    expect(bal(ACCOUNTS.INVENTORY_MERCHANDISE)).toBe(90);
    expect(bal(ACCOUNTS.COGS)).toBe(200);
    expect(bal(ACCOUNTS.OPEX_OTHER)).toBe(10);
    expect(checkLedgerInvariants(state)).toEqual([]);
  });

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
        if (code >= 'a4000' && code < 'a8000')
          expect(ledger.accounts[code as typeof ACCOUNTS.CASH]?.balance, code).toBe(0);
      }
      // Net profit = revenue + 7 - cost, credited to 3100 (negative debit-normal balance).
      expect(getBalance(state, A, ACCOUNTS.RETAINED_EARNINGS)).toBe(-(revenue + 7 - cost));
      expect(checkLedgerInvariants(state)).toEqual([]);
    }
  });
});

describe('spend classes (ADR-014)', () => {
  it('classifies every spend the design doc lists', () => {
    expect(SPEND_CLASS).toEqual({
      capex: 'discretionary',
      inventoryPurchase: 'discretionary',
      productionStart: 'discretionary',
      loanRepaymentRequested: 'discretionary',
      operatingCost: 'non_discretionary',
      depreciation: 'non_discretionary',
      interestAccrual: 'non_discretionary',
      loanRepaymentScheduled: 'non_discretionary',
      inventoryWriteOff: 'non_discretionary',
    });
    expect(Object.isFrozen(SPEND_CLASS)).toBe(true);
  });

  it('canSpend: discretionary needs cash >= amount; non-discretionary always passes', () => {
    expect(canSpend('discretionary', money(100), money(100))).toBe(true);
    expect(canSpend('discretionary', money(99), money(100))).toBe(false);
    expect(canSpend('discretionary', money(-5), money(1))).toBe(false);
    expect(canSpend('non_discretionary', money(-5_000), money(100))).toBe(true);
  });
});
