/** Unit tests of the finance transitions over a real (pure) accounting ledger, engine-free. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, checkLedgerInvariants, getBalance } from '../accounting/index.js';
import {
  EMPTY_CONTENT_PACK,
  M1_CONTENT_PACK,
  loanId,
  money,
  negMoney,
  type EventInput,
  type FinanceState,
  type Loan,
} from '../schema/index.js';
import { checkFinanceInvariants } from './invariants.js';
import { createFinanceState, repayLoan, requestLoan, runFinanceDay } from './loans.js';
import { interestFor } from './schedule.js';
import {
  BANK,
  PLAYER,
  RIVAL,
  makeLedgerEnv,
  moveCash,
  type LedgerTestEnv,
} from './test-helpers.js';

const isMonthEnd = (tick: number): boolean => tick % 30 === 29;

function setup(cash = 50_000_000): { env: LedgerTestEnv; slice: FinanceState } {
  const env = makeLedgerEnv([
    { id: PLAYER, cash },
    { id: RIVAL, cash },
  ]);
  return { env, slice: createFinanceState([RIVAL, PLAYER]) };
}

function borrow(
  env: LedgerTestEnv,
  slice: FinanceState,
  principal: number,
  termMonths: number,
): Loan {
  const r = requestLoan(slice, env, M1_CONTENT_PACK, 0.04, PLAYER, {
    companyId: PLAYER,
    principal: money(principal),
    termMonths,
  });
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

/** Runs `runFinanceDay` for ticks `from..to` inclusive, applying `before(tick)` first each day. */
function runDays(
  env: LedgerTestEnv,
  slice: FinanceState,
  from: number,
  to: number,
  before?: (tick: number) => void,
): void {
  for (let t = from; t <= to; t++) {
    env.tick = t;
    before?.(t);
    runFinanceDay(slice, env, M1_CONTENT_PACK, [PLAYER, RIVAL], isMonthEnd(t));
    expect(
      checkFinanceInvariants({ finance: slice, accounting: env.ledger }, M1_CONTENT_PACK),
    ).toEqual([]);
    expect(checkLedgerInvariants(env.ledger)).toEqual([]);
  }
}

const ofType = <T extends EventInput['type']>(events: readonly EventInput[], type: T) =>
  events.filter((e): e is Extract<EventInput, { type: T }> => e.type === type);

describe('requestLoan', () => {
  it('rejects not_owner, no_bank and underwriting codes without posting', () => {
    const { env, slice } = setup();
    const payload = { companyId: PLAYER, principal: money(1_000_000), termMonths: 12 };
    const r1 = requestLoan(slice, env, M1_CONTENT_PACK, 0.04, RIVAL, payload);
    expect(r1.ok ? null : r1.error.code).toBe('not_owner');
    const r2 = requestLoan(slice, env, EMPTY_CONTENT_PACK, 0.04, PLAYER, payload);
    expect(r2.ok ? null : r2.error.code).toBe('no_bank');
    const r3 = requestLoan(slice, env, M1_CONTENT_PACK, 0.04, PLAYER, {
      ...payload,
      termMonths: 3,
    });
    expect(r3.ok ? null : r3.error.code).toBe('invalid_term');
    expect(slice.loans).toEqual({});
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.LOANS)).toBe(0);
    expect(env.events).toEqual([]);
  });

  it('draws the loan: Dr 1000 / Cr 2500, loan record, loan.issued', () => {
    const { env, slice } = setup();
    env.tick = 9;
    const loan = borrow(env, slice, 12_000_000, 6);
    expect(loan).toMatchObject({
      id: 'ln_000001',
      borrowerId: PLAYER,
      bankId: BANK.id,
      outstanding: 12_000_000,
      accruedInterest: 0,
      annualRate: 0.06,
      monthsRemaining: 6,
      drawnTick: 9,
      lastAccrualTick: 9,
      status: 'active',
    });
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.CASH)).toBe(62_000_000);
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.LOANS)).toBe(-12_000_000);
    expect(env.ledger.journal.at(-1)?.ref).toEqual({ kind: 'loan', id: 'ln_000001' });
    expect(env.events).toEqual([
      {
        type: 'loan.issued',
        payload: {
          loanId: loan.id,
          companyId: PLAYER,
          principal: 12_000_000,
          termMonths: 6,
          annualRate: 0.06,
        },
      },
    ]);
  });
});

describe('loan life (pure)', () => {
  it('draw on day 10, 6 months: prorated first interest, 6 payments, closes on the last', () => {
    const { env, slice } = setup();
    env.tick = 9;
    const loan = borrow(env, slice, 12_000_000, 6);
    runDays(env, slice, 9, 6 * 30 + 29);
    const payments = ofType(env.events, 'loan.payment');
    expect(payments).toHaveLength(6);
    expect(payments.reduce((a, e) => a + e.payload.principal, 0)).toBe(12_000_000);
    expect(payments[0]?.payload).toEqual({
      loanId: loan.id,
      principal: 2_000_000,
      interest: 40_000, // 20 days at 6%
      outstanding: 10_000_000,
    });
    expect(payments[1]?.payload.interest).toBe(interestFor(money(10_000_000), 0.06, 30));
    expect(ofType(env.events, 'loan.closed')).toEqual([
      { type: 'loan.closed', payload: { loanId: loan.id } },
    ]);
    expect(slice.loans[loan.id]).toMatchObject({
      status: 'closed',
      outstanding: 0,
      monthsRemaining: 0,
    });
    const interestTotal = payments.reduce((a, e) => a + e.payload.interest, 0);
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.INTEREST_EXPENSE)).toBe(interestTotal);
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.CASH)).toBe(50_000_000 - interestTotal);
  });

  it('a loan drawn on a month end pays nothing that day and accrues 30 days next month', () => {
    const { env, slice } = setup();
    env.tick = 29;
    const loan = borrow(env, slice, 6_000_000, 6);
    runDays(env, slice, 29, 59);
    const payments = ofType(env.events, 'loan.payment');
    expect(payments).toHaveLength(1);
    expect(payments[0]?.payload.interest).toBe(30_000);
    expect(slice.loans[loan.id]?.monthsRemaining).toBe(5);
  });
});

describe('repayLoan', () => {
  it('rejects in order: unknown_loan, not_owner, invalid_amount, insufficient_cash; closed -> loan_not_active', () => {
    const { env, slice } = setup(1_000_000);
    const loan = borrow(env, slice, 500_000, 6);
    const code = (issuer: typeof PLAYER, id: string, amount: number): string => {
      const r = repayLoan(slice, env, issuer, { loanId: loanId(id), amount: money(amount) });
      return r.ok ? 'ok' : r.error.code;
    };
    expect(code(PLAYER, 'ln_999999', 1)).toBe('unknown_loan');
    expect(code(RIVAL, loan.id, 1)).toBe('not_owner');
    expect(code(PLAYER, loan.id, 0)).toBe('invalid_amount');
    expect(code(PLAYER, loan.id, -5)).toBe('invalid_amount');
    expect(code(PLAYER, loan.id, 1_500_001)).toBe('insufficient_cash');
    expect(code(PLAYER, loan.id, 1_500_000)).toBe('ok'); // closes (excess not taken)
    expect(code(PLAYER, loan.id, 1)).toBe('loan_not_active');
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.CASH)).toBe(1_000_000);
  });

  it('partial repayment pays accrued interest first; full repayment closes; later instalments shrink', () => {
    const { env, slice } = setup();
    const loan = borrow(env, slice, 12_000_000, 12);
    // Drain the player so the first payment is missed and interest stays accrued.
    moveCash(env, PLAYER, -(62_000_000 + BANK.overdraftLimit));
    runDays(env, slice, 1, 29);
    expect(ofType(env.events, 'loan.payment_missed')).toHaveLength(1);
    const accrued = slice.loans[loan.id]?.accruedInterest ?? 0;
    expect(accrued).toBe(interestFor(money(12_000_000), 0.06, 29));
    moveCash(env, PLAYER, 80_000_000);
    runDays(env, slice, 30, 30);
    env.events.length = 0;

    const part = repayLoan(slice, env, PLAYER, {
      loanId: loan.id,
      amount: money(accrued + 1_000_000),
    });
    expect(part.ok).toBe(true);
    expect(env.events[0]).toEqual({
      type: 'loan.repaid',
      payload: { loanId: loan.id, principal: 1_000_000, interest: accrued },
    });
    expect(slice.loans[loan.id]).toMatchObject({ outstanding: 11_000_000, accruedInterest: 0 });
    expect(checkFinanceInvariants({ finance: slice, accounting: env.ledger })).toEqual([]);

    // 12 months remaining on 11M: the next instalment is 11M / 12, not 1M.
    runDays(env, slice, 31, 59);
    expect(ofType(env.events, 'loan.payment')[0]?.payload.principal).toBe(916_667);

    const full = repayLoan(slice, env, PLAYER, { loanId: loan.id, amount: money(50_000_000) });
    expect(full.ok).toBe(true);
    expect(slice.loans[loan.id]?.status).toBe('closed');
    expect(ofType(env.events, 'loan.closed')).toHaveLength(1);
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.LOANS)).toBe(0);
  });

  it('property: 2500 tracks outstanding under random repayment sequences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100_000, max: 40_000_000 }),
        fc.integer({ min: 6, max: 60 }),
        fc.array(
          fc.tuple(fc.integer({ min: 0, max: 400 }), fc.integer({ min: -10, max: 20_000_000 })),
          {
            maxLength: 12,
          },
        ),
        (principal, term, repays) => {
          const { env, slice } = setup();
          const loan = borrow(env, slice, principal, term);
          const byTick = new Map<number, number[]>();
          for (const [t, a] of repays) byTick.set(t, [...(byTick.get(t) ?? []), a]);
          for (let t = 0; t <= 400; t++) {
            env.tick = t;
            for (const a of byTick.get(t) ?? []) {
              repayLoan(slice, env, PLAYER, { loanId: loan.id, amount: money(a) });
            }
            runFinanceDay(slice, env, M1_CONTENT_PACK, [PLAYER, RIVAL], isMonthEnd(t));
            const l = slice.loans[loan.id];
            expect(negMoney(getBalance(env.ledger, PLAYER, ACCOUNTS.LOANS))).toBe(
              l?.status === 'closed' ? 0 : l?.outstanding,
            );
            expect(l?.accruedInterest).toBeGreaterThanOrEqual(0);
          }
          expect(
            checkFinanceInvariants({ finance: slice, accounting: env.ledger }, M1_CONTENT_PACK),
          ).toEqual([]);
          expect(checkLedgerInvariants(env.ledger)).toEqual([]);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('missed payments and default', () => {
  it('misses when the payment would breach the overdraft limit, applies the penalty, defaults after 3', () => {
    const { env, slice } = setup();
    const loan = borrow(env, slice, 12_000_000, 12);
    // Cash just above -limit: any payment would breach it.
    moveCash(env, PLAYER, -(62_000_000 + BANK.overdraftLimit - 1));
    runDays(env, slice, 1, 29);
    const missed = ofType(env.events, 'loan.payment_missed');
    expect(missed).toHaveLength(1);
    expect(missed[0]?.payload.loanId).toBe(loan.id);
    expect(slice.loans[loan.id]).toMatchObject({
      consecutiveMissed: 1,
      missedPayments: 1,
      monthsRemaining: 12,
    });
    const firstAccrued = slice.loans[loan.id]?.accruedInterest ?? 0;

    runDays(env, slice, 30, 59);
    // Second month accrues at 6% + 5% penalty on the unchanged principal (no compounding).
    expect((slice.loans[loan.id]?.accruedInterest ?? 0) - firstAccrued).toBe(
      interestFor(money(12_000_000), 0.11, 30),
    );
    runDays(env, slice, 60, 89);
    expect(ofType(env.events, 'loan.payment_missed')).toHaveLength(3);
    expect(ofType(env.events, 'loan.defaulted')).toEqual([
      { type: 'loan.defaulted', payload: { loanId: loan.id } },
    ]);
    expect(slice.loans[loan.id]?.status).toBe('defaulted');
    expect(slice.credit[PLAYER]?.insolventSince).not.toBeNull();

    // A defaulted loan keeps accruing (penalty) but takes no scheduled payment.
    env.events.length = 0;
    runDays(env, slice, 90, 119);
    expect(ofType(env.events, 'loan.payment')).toHaveLength(0);
    expect(ofType(env.events, 'loan.payment_missed')).toHaveLength(0);

    // Recovery: cash comes back, the owner repays in full, the loan closes, credit is restored.
    moveCash(env, PLAYER, 200_000_000);
    runDays(env, slice, 120, 120);
    expect(ofType(env.events, 'credit.restored')).toHaveLength(1);
    const owed =
      (slice.loans[loan.id]?.outstanding ?? 0) + (slice.loans[loan.id]?.accruedInterest ?? 0);
    const r = repayLoan(slice, env, PLAYER, { loanId: loan.id, amount: money(owed) });
    expect(r.ok).toBe(true);
    expect(slice.loans[loan.id]?.status).toBe('closed');
    expect(
      checkFinanceInvariants({ finance: slice, accounting: env.ledger }, M1_CONTENT_PACK),
    ).toEqual([]);
  });

  it('a successful payment resets consecutiveMissed', () => {
    const { env, slice } = setup();
    const loan = borrow(env, slice, 12_000_000, 12);
    moveCash(env, PLAYER, -(62_000_000 + BANK.overdraftLimit - 1));
    runDays(env, slice, 1, 29);
    moveCash(env, PLAYER, 100_000_000);
    runDays(env, slice, 30, 59);
    expect(slice.loans[loan.id]).toMatchObject({
      consecutiveMissed: 0,
      missedPayments: 1,
      monthsRemaining: 11,
    });
    expect(slice.loans[loan.id]?.status).toBe('active');
  });
});

describe('overdraft backstop', () => {
  it('flags, accrues daily, settles at month end, restores, and flags insolvency beyond the limit', () => {
    const { env, slice } = setup(1_000_000);
    runDays(env, slice, 0, 9, (t) => {
      if (t === 5) moveCash(env, PLAYER, -2_000_000); // cash -1,000,000
    });
    expect(ofType(env.events, 'credit.overdrawn')).toEqual([
      { type: 'credit.overdrawn', payload: { companyId: PLAYER, cash: -1_000_000 } },
    ]);
    expect(slice.credit[PLAYER]?.overdrawnSince).toBe(5);
    // 5 days (ticks 5..9) at 18% on 1,000,000 (500/day) accrue; nothing paid yet.
    expect(slice.credit[PLAYER]?.overdraftAccrued).toBe(2_500);
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.INTEREST_PAYABLE)).toBe(-2_500);

    runDays(env, slice, 10, 29);
    // Month end: settled from cash (Dr 2100 / Cr 1000).
    expect(slice.credit[PLAYER]?.overdraftAccrued).toBe(0);
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.INTEREST_PAYABLE)).toBe(0);
    expect(getBalance(env.ledger, PLAYER, ACCOUNTS.INTEREST_EXPENSE)).toBeGreaterThan(12_000);
    expect(ofType(env.events, 'credit.insolvent')).toHaveLength(0);

    runDays(env, slice, 30, 31, (t) => {
      if (t === 30) moveCash(env, PLAYER, -(BANK.overdraftLimit + 1));
    });
    expect(ofType(env.events, 'credit.insolvent')).toHaveLength(1);
    expect(slice.credit[PLAYER]?.insolventSince).toBe(30);

    runDays(env, slice, 32, 33, (t) => {
      if (t === 32) moveCash(env, PLAYER, 20_000_000);
    });
    expect(ofType(env.events, 'credit.restored')).toEqual([
      { type: 'credit.restored', payload: { companyId: PLAYER } },
    ]);
    expect(slice.credit[PLAYER]).toMatchObject({ overdrawnSince: null, insolventSince: null });
    // Accrued but unsettled interest stays owed after restoration and is paid at month end.
    expect(slice.credit[PLAYER]?.overdraftAccrued).toBeGreaterThan(0);
    runDays(env, slice, 34, 59);
    expect(slice.credit[PLAYER]?.overdraftAccrued).toBe(0);
    // The rival was never touched.
    expect(slice.credit[RIVAL]).toEqual({
      companyId: RIVAL,
      overdrawnSince: null,
      insolventSince: null,
      overdraftAccrued: 0,
    });
  });

  it('a scheduled payment that takes cash negative is flagged the same tick', () => {
    const env2 = makeLedgerEnv([{ id: PLAYER, cash: 10_000_000 }]);
    const s2 = createFinanceState([PLAYER]);
    const r = requestLoan(s2, env2, M1_CONTENT_PACK, 0.04, PLAYER, {
      companyId: PLAYER,
      principal: money(6_000_000),
      termMonths: 6,
    });
    expect(r.ok).toBe(true);
    moveCash(env2, PLAYER, -15_500_000); // cash 500,000 < first payment ~1,019,333
    for (let t = 0; t <= 29; t++) {
      env2.tick = t;
      runFinanceDay(s2, env2, M1_CONTENT_PACK, [PLAYER], isMonthEnd(t));
    }
    expect(ofType(env2.events, 'loan.payment')).toHaveLength(1);
    expect(getBalance(env2.ledger, PLAYER, ACCOUNTS.CASH)).toBeLessThan(0);
    expect(s2.credit[PLAYER]?.overdrawnSince).toBe(29);
    expect(
      checkFinanceInvariants({ finance: s2, accounting: env2.ledger }, M1_CONTENT_PACK),
    ).toEqual([]);
  });

  it('without a bank only the overdrawn flag is kept (no interest, no insolvency)', () => {
    const env = makeLedgerEnv([{ id: PLAYER, cash: 100 }]);
    const slice = createFinanceState([PLAYER]);
    moveCash(env, PLAYER, -100_000_000);
    runFinanceDay(slice, env, EMPTY_CONTENT_PACK, [PLAYER], true);
    expect(slice.credit[PLAYER]).toMatchObject({
      overdrawnSince: 0,
      insolventSince: null,
      overdraftAccrued: 0,
    });
    expect(ofType(env.events, 'credit.insolvent')).toHaveLength(0);
    expect(checkFinanceInvariants({ finance: slice, accounting: env.ledger })).toEqual([]);
  });
});
