/**
 * Finance invariants (docs/design/finance.md section 11, ADR-014) for tests and sim-tests.
 * Read-only. Reconciles the finance slice against the accounting ledger:
 *
 * - `loans.principal_mismatch` (1): per entity, Σ `outstanding` over non-closed loans
 *   === −balance(`ACCOUNTS.LOANS`, a2500 Loans Payable). Finance is the only poster to 2500 in M1.
 * - `loans.interest_mismatch` (2): per entity, Σ `accruedInterest` (all loans) + `overdraftAccrued`
 *   === −balance(`ACCOUNTS.INTEREST_PAYABLE`, a2100 Accrued Interest Payable).
 * - `loan.invalid` (3): `0 <= outstanding <= principal`, `accruedInterest >= 0`, `annualRate >= 0`
 *   and finite, `monthsRemaining <= termMonths`, counters non-negative, `consecutiveMissed <=
 *   missedPayments`, borrower has a ledger, record key === id; `closed` ⇒ nothing owed.
 * - `credit.overdraft_flag` / `credit.insolvent_flag` (4): `cash < 0 ⇔ overdrawnSince !== null`;
 *   `cash < −overdraftLimit ⇒ insolventSince !== null` (the second needs `content` for the limit;
 *   skipped without a bank). `credit.missing`: a company with a ledger and negative cash but no
 *   credit record.
 * - `schedule.mismatch`: `amortisationSchedule(principal, termMonths)` does not sum to principal.
 *
 * Status transitions are checked by `checkLoanTransition` (pure, used by tests between ticks).
 */
import { ACCOUNTS } from '../accounting/index.js';
import { sortedKeys, type DeepReadonly } from '../engine/index.js';
import {
  ZERO_MONEY,
  addMoney,
  negMoney,
  type AccountCode,
  type AccountingState,
  type CompanyId,
  type FinanceState,
  type LoanId,
  type LoanStatus,
  type Money,
} from '../schema/index.js';
import { amortisationSchedule } from './schedule.js';
import { bankOf, type ReadonlyContentPack } from './underwriting.js';

export type FinanceInvariantCode =
  | 'loans.principal_mismatch'
  | 'loans.interest_mismatch'
  | 'loan.invalid'
  | 'schedule.mismatch'
  | 'credit.missing'
  | 'credit.overdraft_flag'
  | 'credit.insolvent_flag'
  | 'loan.invalid_transition';

export interface FinanceInvariantViolation {
  code: FinanceInvariantCode;
  entityId?: CompanyId;
  loanId?: LoanId;
  message: string;
}

/** The parts of `WorldState` the check reads (a `WorldState` satisfies it). */
export interface FinanceInvariantInput {
  finance: FinanceState;
  accounting: AccountingState;
}

function balanceOf(
  accounting: DeepReadonly<AccountingState>,
  entityId: CompanyId,
  code: AccountCode,
): Money {
  return accounting.entities[entityId]?.accounts[code]?.balance ?? ZERO_MONEY;
}

export function checkFinanceInvariants(
  state: DeepReadonly<FinanceInvariantInput>,
  content?: ReadonlyContentPack,
): FinanceInvariantViolation[] {
  const out: FinanceInvariantViolation[] = [];
  const { finance, accounting } = state;
  const principalBy: Partial<Record<CompanyId, Money>> = {};
  const interestBy: Partial<Record<CompanyId, Money>> = {};

  for (const loanId of sortedKeys(finance.loans)) {
    const loan = finance.loans[loanId];
    if (loan === undefined) continue;
    const bad = (message: string): void => {
      out.push({ code: 'loan.invalid', entityId: loan.borrowerId, loanId, message });
    };
    if (loan.id !== loanId) bad(`record key ${loanId} !== id ${loan.id}`);
    if (accounting.entities[loan.borrowerId] === undefined) bad(`borrower has no ledger`);
    if (!(loan.outstanding >= 0 && loan.outstanding <= loan.principal)) {
      bad(`outstanding ${String(loan.outstanding)} outside 0..${String(loan.principal)}`);
    }
    if (!(loan.accruedInterest >= 0)) bad(`accruedInterest ${String(loan.accruedInterest)} < 0`);
    if (!(Number.isFinite(loan.annualRate) && loan.annualRate >= 0)) {
      bad(`annualRate ${String(loan.annualRate)} invalid`);
    }
    if (!(loan.monthsRemaining >= 0 && loan.monthsRemaining <= loan.termMonths)) {
      bad(`monthsRemaining ${String(loan.monthsRemaining)} outside 0..${String(loan.termMonths)}`);
    }
    if (!(loan.missedPayments >= 0 && loan.consecutiveMissed >= 0)) bad(`negative miss counters`);
    if (loan.consecutiveMissed > loan.missedPayments) bad(`consecutiveMissed > missedPayments`);
    if (loan.lastAccrualTick < loan.drawnTick) bad(`lastAccrualTick before drawnTick`);
    if (loan.status === 'closed' && (loan.outstanding !== 0 || loan.accruedInterest !== 0)) {
      bad(
        `closed with ${String(loan.outstanding)} principal / ${String(loan.accruedInterest)} interest`,
      );
    }
    let scheduled = ZERO_MONEY;
    for (const p of amortisationSchedule(loan.principal, loan.termMonths)) {
      scheduled = addMoney(scheduled, p);
    }
    if (scheduled !== loan.principal) {
      out.push({
        code: 'schedule.mismatch',
        entityId: loan.borrowerId,
        loanId,
        message: `schedule sums to ${String(scheduled)}, principal ${String(loan.principal)}`,
      });
    }
    const c = loan.borrowerId;
    if (loan.status !== 'closed') {
      principalBy[c] = addMoney(principalBy[c] ?? ZERO_MONEY, loan.outstanding);
    }
    interestBy[c] = addMoney(interestBy[c] ?? ZERO_MONEY, loan.accruedInterest);
  }

  const bank = content === undefined ? null : bankOf(content);
  for (const entityId of sortedKeys(accounting.entities)) {
    const loansPayable = negMoney(balanceOf(accounting, entityId, ACCOUNTS.LOANS));
    const expectedPrincipal = principalBy[entityId] ?? ZERO_MONEY;
    if (loansPayable !== expectedPrincipal) {
      out.push({
        code: 'loans.principal_mismatch',
        entityId,
        message: `Σ outstanding ${String(expectedPrincipal)} !== 2500 ${String(loansPayable)}`,
      });
    }
    const credit = finance.credit[entityId];
    const interestPayable = negMoney(balanceOf(accounting, entityId, ACCOUNTS.INTEREST_PAYABLE));
    const expectedInterest = addMoney(
      interestBy[entityId] ?? ZERO_MONEY,
      credit?.overdraftAccrued ?? ZERO_MONEY,
    );
    if (interestPayable !== expectedInterest) {
      out.push({
        code: 'loans.interest_mismatch',
        entityId,
        message: `Σ accrued ${String(expectedInterest)} !== 2100 ${String(interestPayable)}`,
      });
    }

    const cash = balanceOf(accounting, entityId, ACCOUNTS.CASH);
    if (credit === undefined) {
      if (cash < 0) {
        out.push({
          code: 'credit.missing',
          entityId,
          message: `cash ${String(cash)} < 0 and no credit record`,
        });
      }
      continue;
    }
    if (cash < 0 !== (credit.overdrawnSince !== null)) {
      out.push({
        code: 'credit.overdraft_flag',
        entityId,
        message: `cash ${String(cash)} but overdrawnSince ${String(credit.overdrawnSince)}`,
      });
    }
    if (bank !== null && cash < negMoney(bank.overdraftLimit) && credit.insolventSince === null) {
      out.push({
        code: 'credit.insolvent_flag',
        entityId,
        message: `cash ${String(cash)} below -${String(bank.overdraftLimit)} but not insolvent`,
      });
    }
    if (credit.insolventSince !== null && credit.overdrawnSince === null) {
      out.push({ code: 'credit.insolvent_flag', entityId, message: `insolvent but not overdrawn` });
    }
  }
  return out;
}

/** Legal status changes: active → defaulted | closed, defaulted → closed; never out of closed. */
export function isValidLoanTransition(from: LoanStatus, to: LoanStatus): boolean {
  if (from === to) return true;
  if (from === 'active') return to === 'defaulted' || to === 'closed';
  if (from === 'defaulted') return to === 'closed';
  return false;
}

/**
 * Compares two finance slices (before/after a tick): every loan that existed before still exists and
 * changed status only along `isValidLoanTransition`; `principal`, `termMonths`, `annualRate`,
 * `borrowerId` and `drawnTick` never change; `missedPayments` never decreases.
 */
export function checkLoanTransitions(
  before: DeepReadonly<FinanceState>,
  after: DeepReadonly<FinanceState>,
): FinanceInvariantViolation[] {
  const out: FinanceInvariantViolation[] = [];
  for (const loanId of sortedKeys(before.loans)) {
    const a = before.loans[loanId];
    const b = after.loans[loanId];
    if (a === undefined) continue;
    const bad = (message: string): void => {
      out.push({ code: 'loan.invalid_transition', entityId: a.borrowerId, loanId, message });
    };
    if (b === undefined) {
      bad('loan disappeared');
      continue;
    }
    if (!isValidLoanTransition(a.status, b.status)) bad(`status ${a.status} -> ${b.status}`);
    if (
      a.principal !== b.principal ||
      a.termMonths !== b.termMonths ||
      a.annualRate !== b.annualRate ||
      a.borrowerId !== b.borrowerId ||
      a.drawnTick !== b.drawnTick
    ) {
      bad('immutable loan terms changed');
    }
    if (b.missedPayments < a.missedPayments) bad('missedPayments decreased');
  }
  return out;
}
