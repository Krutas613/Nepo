/**
 * Finance state transitions (docs/design/finance.md sections 5, 6; ADR-014). Pure functions over the
 * `FinanceState` slice plus a small `FinanceEnv` (the accounting service, the tick, `emit`, an ID
 * issuer); `system.ts` is the thin adapter that builds the env from a `TickContext`.
 *
 * Every cash flow is posted through accounting builders (`loanDrawdown`, `loanRepayment`,
 * `interestAccrual`); balances are always read from accounting at the moment of use.
 */
import {
  interestAccrual,
  loanDrawdown,
  loanRepayment,
  type AccountingApi,
} from '../accounting/index.js';
import { sortedKeys, type DeepReadonly } from '../engine/index.js';
import {
  InvariantError,
  ZERO_MONEY,
  addMoney,
  err,
  negMoney,
  ok,
  subMoney,
  type CompanyId,
  type CreditState,
  type EventInput,
  type FinanceState,
  type JournalEntryRef,
  type Loan,
  type LoanId,
  type Money,
  type RepayLoanPayload,
  type RequestLoanPayload,
  type Result,
} from '../schema/index.js';
import { interestFor, overdraftInterest, principalDue, splitRepayment } from './schedule.js';
import {
  assessLoan,
  bankOf,
  type ReadonlyBank,
  type ReadonlyContentPack,
  type UnderwritingCode,
} from './underwriting.js';

/** What the finance transitions need from the outside world. */
export interface FinanceEnv {
  readonly tick: number;
  readonly accounting: Pick<AccountingApi, 'postOrThrow' | 'cash' | 'balanceSheet' | 'hasEntity'>;
  emit(event: EventInput): void;
  issueLoanId(): LoanId;
}

/** Rejection codes of `loan.request` (finance.md section 5). */
export type RequestLoanCode = 'not_owner' | UnderwritingCode;
/** Rejection codes of `loan.repay` (finance.md section 5). */
export type RepayLoanCode =
  'unknown_loan' | 'not_owner' | 'loan_not_active' | 'invalid_amount' | 'insufficient_cash';

export interface CommandRejection<C extends string> {
  code: C;
  message: string;
}

const SOURCE = 'finance';

function loanRef(id: LoanId): JournalEntryRef {
  return { kind: 'loan', id };
}

function creditRef(id: CompanyId): JournalEntryRef {
  return { kind: 'credit', id };
}

// ---------------------------------------------------------------------------------------------
// Credit records
// ---------------------------------------------------------------------------------------------

export function createCreditState(companyId: CompanyId): CreditState {
  return { companyId, overdrawnSince: null, insolventSince: null, overdraftAccrued: ZERO_MONEY };
}

/** `creditOf` (finance.md section 3): the company's record, created on first use. */
export function creditOf(slice: FinanceState, companyId: CompanyId): CreditState {
  const existing = slice.credit[companyId];
  if (existing !== undefined) return existing;
  const created = createCreditState(companyId);
  slice.credit[companyId] = created;
  return created;
}

/** Fresh slice: one credit record per company (in `sortedKeys` order), no loans. */
export function createFinanceState(companies: readonly CompanyId[]): FinanceState {
  const state: FinanceState = { loans: {}, credit: {} };
  for (const c of [...companies].sort()) creditOf(state, c);
  return state;
}

function loanOf(slice: FinanceState, id: LoanId): Loan {
  const loan = slice.loans[id];
  if (loan === undefined) {
    throw new InvariantError('finance.unknown_loan', `no loan ${id}`, { loanId: id });
  }
  return loan;
}

function bankForLoan(content: ReadonlyContentPack, loan: Loan): ReadonlyBank {
  const bank = content.finance.banks[loan.bankId];
  if (bank === undefined) {
    throw new InvariantError('finance.unknown_bank', `loan ${loan.id} names unknown bank`, {
      loanId: loan.id,
      bankId: loan.bankId,
    });
  }
  return bank;
}

// ---------------------------------------------------------------------------------------------
// Commands (phase `apply`)
// ---------------------------------------------------------------------------------------------

/**
 * `loan.request`: rejections `not_owner`, `no_bank`, then `assessLoan`'s codes. On success posts
 * `loanDrawdown` (Dr 1000 / Cr 2500), stores the loan and emits `loan.issued`.
 */
export function requestLoan(
  slice: FinanceState,
  env: FinanceEnv,
  content: ReadonlyContentPack,
  policyRate: number,
  issuer: CompanyId,
  payload: DeepReadonly<RequestLoanPayload>,
): Result<Loan, CommandRejection<RequestLoanCode>> {
  const { companyId, principal, termMonths } = payload;
  if (issuer !== companyId || !env.accounting.hasEntity(companyId)) {
    return err({ code: 'not_owner', message: `${issuer} cannot borrow for ${companyId}` });
  }
  const bank = bankOf(content);
  if (bank === null) return err({ code: 'no_bank', message: 'no bank is available' });
  const assessed = assessLoan(
    env.accounting.balanceSheet(companyId),
    principal,
    termMonths,
    bank,
    policyRate,
  );
  if (!assessed.ok) return assessed;

  const id = env.issueLoanId();
  env.accounting.postOrThrow(companyId, loanDrawdown(principal, SOURCE, { ref: loanRef(id) }));
  const loan: Loan = {
    id,
    borrowerId: companyId,
    bankId: bank.id,
    principal,
    outstanding: principal,
    accruedInterest: ZERO_MONEY,
    annualRate: assessed.value.annualRate,
    termMonths,
    monthsRemaining: termMonths,
    drawnTick: env.tick,
    lastAccrualTick: env.tick,
    missedPayments: 0,
    consecutiveMissed: 0,
    status: 'active',
  };
  slice.loans[id] = loan;
  creditOf(slice, companyId);
  env.emit({
    type: 'loan.issued',
    payload: { loanId: id, companyId, principal, termMonths, annualRate: loan.annualRate },
  });
  return ok(loan);
}

/**
 * `loan.repay` (early repayment, discretionary under ADR-014): rejections `unknown_loan`,
 * `not_owner`, `loan_not_active` (closed only), `invalid_amount` (< 1), `insufficient_cash`
 * (cash < amount). Pays accrued interest first, then principal; any excess over what is owed is not
 * taken. Emits `loan.repaid`, then `loan.closed` when nothing is owed any more. `monthsRemaining` is
 * unchanged, so later straight-line instalments shrink (the reschedule).
 */
export function repayLoan(
  slice: FinanceState,
  env: FinanceEnv,
  issuer: CompanyId,
  payload: DeepReadonly<RepayLoanPayload>,
): Result<Loan, CommandRejection<RepayLoanCode>> {
  const loan = slice.loans[payload.loanId];
  if (loan === undefined) {
    return err({ code: 'unknown_loan', message: `no loan ${payload.loanId}` });
  }
  if (loan.borrowerId !== issuer) {
    return err({ code: 'not_owner', message: `${issuer} does not owe loan ${loan.id}` });
  }
  if (loan.status === 'closed') {
    return err({ code: 'loan_not_active', message: `loan ${loan.id} is closed` });
  }
  const amount = payload.amount;
  if (!(amount >= 1)) {
    return err({ code: 'invalid_amount', message: `amount ${String(amount)} must be >= 1` });
  }
  const cash = env.accounting.cash(loan.borrowerId);
  if (cash < amount) {
    return err({
      code: 'insufficient_cash',
      message: `cash ${String(cash)} is below the repayment ${String(amount)}`,
    });
  }
  const split = splitRepayment(amount, loan.accruedInterest, loan.outstanding);
  env.accounting.postOrThrow(
    loan.borrowerId,
    loanRepayment(split.principal, split.interest, SOURCE, {
      memo: 'Loan early repayment',
      ref: loanRef(loan.id),
    }),
  );
  loan.accruedInterest = subMoney(loan.accruedInterest, split.interest);
  loan.outstanding = subMoney(loan.outstanding, split.principal);
  env.emit({
    type: 'loan.repaid',
    payload: { loanId: loan.id, principal: split.principal, interest: split.interest },
  });
  if (loan.outstanding === 0 && loan.accruedInterest === 0) closeLoan(loan, env);
  return ok(loan);
}

function closeLoan(loan: Loan, env: FinanceEnv): void {
  loan.status = 'closed';
  loan.monthsRemaining = 0;
  env.emit({ type: 'loan.closed', payload: { loanId: loan.id } });
}

// ---------------------------------------------------------------------------------------------
// Finance phase
// ---------------------------------------------------------------------------------------------

/**
 * Sets/clears the overdraft flags from the current cash (ADR-014): entering `cash < 0` sets
 * `overdrawnSince` (`credit.overdrawn`); `cash < -limit` sets `insolventSince` (`credit.insolvent`);
 * `cash >= 0` clears both (`credit.restored`). With no bank there is no limit, so only the overdrawn
 * flag is maintained. Idempotent within a tick.
 */
export function updateCreditFlags(
  credit: CreditState,
  cash: Money,
  bank: ReadonlyBank | null,
  env: FinanceEnv,
): void {
  if (cash < 0) {
    if (credit.overdrawnSince === null) {
      credit.overdrawnSince = env.tick;
      env.emit({ type: 'credit.overdrawn', payload: { companyId: credit.companyId, cash } });
    }
    if (bank !== null && cash < negMoney(bank.overdraftLimit) && credit.insolventSince === null) {
      credit.insolventSince = env.tick;
      env.emit({
        type: 'credit.insolvent',
        payload: { companyId: credit.companyId, cash, limit: bank.overdraftLimit },
      });
    }
  } else if (credit.overdrawnSince !== null) {
    credit.overdrawnSince = null;
    credit.insolventSince = null;
    env.emit({ type: 'credit.restored', payload: { companyId: credit.companyId } });
  }
}

/**
 * Step 1 for one company (finance.md section 6.1): flags, daily overdraft interest
 * (`interestAccrual`, Dr 7000 / Cr 2100), and on month end the non-discretionary settlement of the
 * month's overdraft interest (`loanRepayment(0, accrued)`, Dr 2100 / Cr 1000).
 */
export function processOverdraft(
  slice: FinanceState,
  env: FinanceEnv,
  bank: ReadonlyBank | null,
  companyId: CompanyId,
  isMonthEnd: boolean,
): void {
  const credit = creditOf(slice, companyId);
  const cash = env.accounting.cash(companyId);
  updateCreditFlags(credit, cash, bank, env);
  if (cash < 0 && bank !== null) {
    const interest = overdraftInterest(cash, bank.overdraftAnnualRate);
    if (interest > 0) {
      env.accounting.postOrThrow(
        companyId,
        interestAccrual(interest, SOURCE, {
          memo: 'Overdraft interest',
          ref: creditRef(companyId),
        }),
      );
      credit.overdraftAccrued = addMoney(credit.overdraftAccrued, interest);
    }
  }
  if (isMonthEnd && credit.overdraftAccrued > 0) {
    env.accounting.postOrThrow(
      companyId,
      loanRepayment(ZERO_MONEY, credit.overdraftAccrued, SOURCE, {
        memo: 'Overdraft interest payment',
        ref: creditRef(companyId),
      }),
    );
    credit.overdraftAccrued = ZERO_MONEY;
  }
}

/**
 * Step 2 (month end): accrue interest on the outstanding principal since `lastAccrualTick`
 * (prorating the first period), at `annualRate` plus `latePenaltySpread` while payments are missed.
 */
export function accrueLoanInterest(loan: Loan, bank: ReadonlyBank, env: FinanceEnv): void {
  if (loan.status === 'closed' || loan.outstanding <= 0 || env.tick <= loan.drawnTick) return;
  const days = env.tick - loan.lastAccrualTick;
  const rate = loan.annualRate + (loan.consecutiveMissed > 0 ? bank.latePenaltySpread : 0);
  const interest = interestFor(loan.outstanding, rate, days);
  if (interest > 0) {
    env.accounting.postOrThrow(
      loan.borrowerId,
      interestAccrual(interest, SOURCE, { ref: loanRef(loan.id) }),
    );
    loan.accruedInterest = addMoney(loan.accruedInterest, interest);
  }
  loan.lastAccrualTick = env.tick;
}

/**
 * Step 3 (month end, `active` loans): pay the straight-line principal instalment plus all accrued
 * interest (non-discretionary) unless that would take cash below `-overdraftLimit`, in which case the
 * payment is missed (`loan.payment_missed`; `loan.defaulted` after `defaultAfterMissed` in a row).
 */
export function payScheduledInstalment(loan: Loan, bank: ReadonlyBank, env: FinanceEnv): void {
  if (loan.status !== 'active' || env.tick <= loan.drawnTick) return;
  const principal = principalDue(loan.outstanding, loan.monthsRemaining);
  const interest = loan.accruedInterest;
  const due = addMoney(principal, interest);
  const cash = env.accounting.cash(loan.borrowerId);
  if (subMoney(cash, due) >= negMoney(bank.overdraftLimit)) {
    if (due > 0) {
      env.accounting.postOrThrow(
        loan.borrowerId,
        loanRepayment(principal, interest, SOURCE, { ref: loanRef(loan.id) }),
      );
    }
    loan.outstanding = subMoney(loan.outstanding, principal);
    loan.accruedInterest = ZERO_MONEY;
    loan.monthsRemaining = Math.max(0, loan.monthsRemaining - 1);
    loan.consecutiveMissed = 0;
    env.emit({
      type: 'loan.payment',
      payload: { loanId: loan.id, principal, interest, outstanding: loan.outstanding },
    });
    if (loan.outstanding === 0) closeLoan(loan, env);
    return;
  }
  loan.missedPayments += 1;
  loan.consecutiveMissed += 1;
  env.emit({ type: 'loan.payment_missed', payload: { loanId: loan.id, due, cash } });
  if (loan.consecutiveMissed >= bank.defaultAfterMissed) {
    loan.status = 'defaulted';
    env.emit({ type: 'loan.defaulted', payload: { loanId: loan.id } });
  }
}

/**
 * The whole `finance` phase for one tick (finance.md section 6):
 *
 * 1. every company (`sortedKeys(companies)`; a missing credit record is created): overdraft flags,
 *    daily accrual, month-end settlement;
 * 2-3. on month end, every loan in `sortedKeys(loans)`: accrual then scheduled payment;
 * 4. every company again: flags only, so a payment made in step 3 (or the month-end overdraft
 *    settlement) that took cash negative or past the limit is flagged the same tick. This keeps
 *    ADR-014's "after every tick, cash < 0 ⇒ overdrawnSince !== null" exact.
 */
export function runFinanceDay(
  slice: FinanceState,
  env: FinanceEnv,
  content: ReadonlyContentPack,
  companies: readonly CompanyId[],
  isMonthEnd: boolean,
): void {
  const bank = bankOf(content);
  const ordered = companies.filter((c) => env.accounting.hasEntity(c)).sort();
  for (const companyId of ordered) processOverdraft(slice, env, bank, companyId, isMonthEnd);
  if (isMonthEnd) {
    for (const id of sortedKeys(slice.loans)) {
      const loan = loanOf(slice, id);
      if (loan.status === 'closed') continue;
      const loanBank = bankForLoan(content, loan);
      accrueLoanInterest(loan, loanBank, env);
      payScheduledInstalment(loan, loanBank, env);
    }
  }
  for (const companyId of ordered) {
    updateCreditFlags(creditOf(slice, companyId), env.accounting.cash(companyId), bank, env);
  }
}
