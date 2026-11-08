import { describe, expect, it } from 'vitest';
import { companyId, money, type AccountCode, type PeriodReport } from '../schema/index.js';
import { ACCOUNTS, isIncomeAccount } from './chart.js';
import {
  cashPurchase,
  cashSale,
  creditPurchase,
  creditSale,
  depreciation,
  interestAccrual,
  interestIncome,
  loanDrawdown,
  loanRepayment,
  makeJournalEntry,
  dr,
  cr,
  openingCapital,
  payroll,
} from './builders.js';
import { closePeriod } from './close.js';
import { checkLedgerInvariants } from './invariants.js';
import {
  createAccountingState,
  getBalance,
  getLedger,
  openEntity,
  postEntryOrThrow,
} from './ledger.js';
import { makeTestEnv, testCloseDate } from './test-helpers.js';

const A = companyId('co_000001');
const B = companyId('co_000002');
const C = companyId('co_000003');

/** A deterministic daily script exercising every builder and every cash-flow section. */
function scriptDay(
  state: ReturnType<typeof createAccountingState>,
  entity: typeof A,
  tick: number,
  env: ReturnType<typeof makeTestEnv>,
): void {
  const k = (tick % 17) + 1;
  const post = (e: Parameters<typeof postEntryOrThrow>[2]): void => {
    postEntryOrThrow(state, entity, e, env);
  };
  post(cashPurchase(ACCOUNTS.INVENTORY_FINISHED, money(1000 * k), 'manufacturing'));
  post(cashSale(money(1500 * k), money(900 * k), 'retail'));
  post(creditSale(money(200 * k), money(100 * k), 'retail'));
  post(payroll(money(300 + k), 'hr'));
  post(interestAccrual(money(11), 'finance'));
  if (tick % 7 === 0) post(creditPurchase(ACCOUNTS.INVENTORY_RAW, money(50 * k), 'manufacturing'));
  if (tick % 9 === 0) post(interestIncome(money(3), 'finance'));
  if (tick % 30 === 0) {
    post(cashPurchase(ACCOUNTS.PPE, money(30_000), 'manufacturing'));
    post(depreciation(money(1_250), 'manufacturing'));
  }
  if (tick % 45 === 0) post(loanDrawdown(money(100_000), 'finance'));
  if (tick % 45 === 44) post(loanRepayment(money(20_000), money(400), 'finance'));
  if (tick % 60 === 5) {
    // collect receivables, pay payables, a dividend out of retained earnings
    post(
      makeJournalEntry(
        [dr(ACCOUNTS.CASH, money(5_000)), cr(ACCOUNTS.RECEIVABLES, money(5_000))],
        'retail',
        'Collection',
      ),
    );
    post(
      makeJournalEntry(
        [dr(ACCOUNTS.PAYABLES, money(700)), cr(ACCOUNTS.CASH, money(700))],
        'manufacturing',
        'Pay supplier',
      ),
    );
    post(
      makeJournalEntry(
        [dr(ACCOUNTS.RETAINED_EARNINGS, money(900)), cr(ACCOUNTS.CASH, money(900))],
        'finance',
        'Dividend',
      ),
    );
  }
}

function incomeBalancesAreZero(
  state: ReturnType<typeof createAccountingState>,
  entity: typeof A,
): boolean {
  const ledger = getLedger(state, entity);
  return (Object.keys(ledger.accounts) as AccountCode[])
    .filter(isIncomeAccount)
    .every((c) => ledger.accounts[c]?.balance === 0);
}

function byKind(reports: readonly PeriodReport[], kind: PeriodReport['kind']): PeriodReport[] {
  return reports.filter((r) => r.kind === kind);
}

describe('closePeriod', () => {
  it('is a no-op on days that are not month ends', () => {
    const state = createAccountingState();
    openEntity(state, A);
    const env = makeTestEnv();
    for (let t = 0; t < 29; t++) expect(closePeriod(state, testCloseDate(t), env)).toEqual([]);
    expect(getLedger(state, A).reports).toEqual([]);
    expect(env.events).toEqual([]);
  });

  it('closes month/quarter/year over 2 simulated years (720 ticks) with exact reconciliation', () => {
    const state = createAccountingState();
    const env = makeTestEnv(0);
    openEntity(state, B);
    openEntity(state, A);
    postEntryOrThrow(state, A, openingCapital(money(10_000_000), 'accounting'), env);
    postEntryOrThrow(state, B, openingCapital(money(5_000_000), 'accounting'), env);
    let retainedBefore = 0;
    for (let tick = 0; tick < 720; tick++) {
      env.tick = tick;
      scriptDay(state, A, tick, env);
      if (tick % 3 === 0) scriptDay(state, B, tick, env);
      const date = testCloseDate(tick);
      const eventsBefore = env.events.length;
      const appended = closePeriod(state, date, env);
      expect(checkLedgerInvariants(state)).toEqual([]);

      if (date.isMonthEnd) {
        const expectedPerEntity = 1 + (date.isQuarterEnd ? 1 : 0) + (date.isYearEnd ? 1 : 0);
        expect(appended).toHaveLength(2 * expectedPerEntity);
        const closedEvents = env.events
          .slice(eventsBefore)
          .filter((e) => e.type === 'period.closed');
        expect(closedEvents).toHaveLength(2 * expectedPerEntity);
        // Entities in sorted order: A's events before B's.
        expect(closedEvents[0]).toEqual({
          type: 'period.closed',
          payload: { entityId: A, kind: 'month', year: date.year, month: date.month },
        });
        for (const r of appended) {
          expect(r.tick).toBe(tick);
          expect(r.cashFlow.netChange).toBe(r.cashFlow.closingCash - r.cashFlow.openingCash);
          expect(r.balance.assets).toBe(r.balance.liabilities + r.balance.equity);
        }
        const ledger = getLedger(state, A);
        expect(ledger.monthOpening[ACCOUNTS.CASH]).toBe(getBalance(state, A, ACCOUNTS.CASH));
      } else {
        expect(appended).toEqual([]);
      }

      if (date.isYearEnd) {
        expect(incomeBalancesAreZero(state, A)).toBe(true);
        expect(incomeBalancesAreZero(state, B)).toBe(true);
        const yearReport = byKind(getLedger(state, A).reports, 'year').at(-1);
        // Retained earnings grew by the year's net income less dividends paid out of it.
        const dividends =
          900 * [...Array(360).keys()].filter((d) => (tick - 359 + d) % 60 === 5).length;
        expect(0 - getBalance(state, A, ACCOUNTS.RETAINED_EARNINGS) - retainedBefore).toBe(
          (yearReport?.income.netIncome ?? NaN) - dividends,
        );
        retainedBefore = 0 - getBalance(state, A, ACCOUNTS.RETAINED_EARNINGS);
        expect(getLedger(state, A).yearOpening).toEqual(getLedger(state, A).monthOpening);
      }
    }

    for (const entity of [A, B]) {
      const reports = getLedger(state, entity).reports;
      const months = byKind(reports, 'month');
      const quarters = byKind(reports, 'quarter');
      const years = byKind(reports, 'year');
      expect(months).toHaveLength(24);
      expect(quarters).toHaveLength(8);
      expect(years).toHaveLength(2);
      expect(months.map((r) => `${r.year}-${r.month}`)).toEqual(
        [2000, 2001].flatMap((y) => Array.from({ length: 12 }, (_, i) => `${y}-${i + 1}`)),
      );
      expect(quarters.map((r) => r.month)).toEqual([3, 6, 9, 12, 3, 6, 9, 12]);
      // Report order within a year-end day: month, quarter, year.
      expect(reports.slice(-3).map((r) => r.kind)).toEqual(['month', 'quarter', 'year']);

      // Quarters are the sum of their months; years the sum of their months.
      quarters.forEach((q, qi) => {
        const ms = months.slice(qi * 3, qi * 3 + 3);
        const sum = (f: (r: PeriodReport) => number): number => ms.reduce((s, r) => s + f(r), 0);
        expect(q.income.netIncome).toBe(sum((r) => r.income.netIncome));
        expect(q.income.revenue).toBe(sum((r) => r.income.revenue));
        expect(q.cashFlow.operating).toBe(sum((r) => r.cashFlow.operating));
        expect(q.cashFlow.netChange).toBe(sum((r) => r.cashFlow.netChange));
        expect(q.cashFlow.openingCash).toBe(ms[0]?.cashFlow.openingCash);
        expect(q.cashFlow.closingCash).toBe(ms[2]?.cashFlow.closingCash);
        expect(q.balance).toEqual(ms[2]?.balance);
        expect(q.income.byAccount[ACCOUNTS.WAGES]).toBe(
          sum((r) => r.income.byAccount[ACCOUNTS.WAGES] ?? 0),
        );
      });
      years.forEach((y, yi) => {
        const ms = months.slice(yi * 12, yi * 12 + 12);
        const sum = (f: (r: PeriodReport) => number): number => ms.reduce((s, r) => s + f(r), 0);
        expect(y.income.netIncome).toBe(sum((r) => r.income.netIncome));
        expect(y.cashFlow.investing).toBe(sum((r) => r.cashFlow.investing));
        expect(y.cashFlow.financing).toBe(sum((r) => r.cashFlow.financing));
        expect(y.cashFlow.openingCash).toBe(ms[0]?.cashFlow.openingCash);
        expect(y.cashFlow.closingCash).toBe(ms[11]?.cashFlow.closingCash);
        // The year report is computed before the closing entry: it still shows the year's income.
        expect(y.income.revenue).toBeGreaterThan(0);
      });
      // The first month carries the opening capital as financing inflow.
      expect(months[0]?.cashFlow.openingCash).toBe(0);
    }

    // Spot-check the statement formulas on A's first month.
    const first = byKind(getLedger(state, A).reports, 'month')[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const i = first.income;
    expect(i.grossProfit).toBe(i.revenue - i.cogs);
    expect(i.operatingIncome).toBe(i.grossProfit - i.opex);
    expect(i.pretaxIncome).toBe(i.operatingIncome + i.otherIncome);
    expect(i.netIncome).toBe(i.pretaxIncome - i.incomeTax);
    expect(i.revenue).toBe(
      -((i.byAccount[ACCOUNTS.SALES] ?? 0) + (i.byAccount[ACCOUNTS.INTERCO_SALES] ?? 0)),
    );
    expect(first.cashFlow.financing).toBeGreaterThanOrEqual(10_000_000);
    expect(first.cashFlow.investing).toBe(-30_000);
    expect(first.cashFlow.netIncome).toBe(i.netIncome);
  });

  it('builds quarter reports from the available months for an entity opened mid-quarter', () => {
    const state = createAccountingState();
    const env = makeTestEnv();
    openEntity(state, A);
    postEntryOrThrow(state, A, openingCapital(money(100), 'accounting'), env);
    for (let tick = 0; tick < 60; tick++) closePeriod(state, testCloseDate(tick), env);
    openEntity(state, C); // opened in month 3
    env.tick = 70;
    postEntryOrThrow(state, C, openingCapital(money(500), 'accounting'), env);
    postEntryOrThrow(state, C, payroll(money(20), 'hr'), env);
    for (let tick = 60; tick < 90; tick++) closePeriod(state, testCloseDate(tick), env);
    const q = byKind(getLedger(state, C).reports, 'quarter');
    expect(q).toHaveLength(1);
    expect(q[0]?.cashFlow.openingCash).toBe(0);
    expect(q[0]?.cashFlow.closingCash).toBe(480);
    expect(q[0]?.income.netIncome).toBe(-20);
    expect(byKind(getLedger(state, A).reports, 'quarter')[0]?.cashFlow.netChange).toBe(100);
    expect(checkLedgerInvariants(state)).toEqual([]);
  });

  it('a year with no income activity posts no closing entry', () => {
    const state = createAccountingState();
    const env = makeTestEnv();
    openEntity(state, A);
    postEntryOrThrow(state, A, openingCapital(money(100), 'accounting'), env);
    const journalBefore = state.journal.length;
    for (let tick = 0; tick < 360; tick++) closePeriod(state, testCloseDate(tick), env);
    expect(state.journal).toHaveLength(journalBefore);
    expect(byKind(getLedger(state, A).reports, 'year')).toHaveLength(1);
  });
});
