/**
 * `FinanceApi` (docs/design/finance.md section 7): read-only queries for the UI and AI, registered
 * under `FINANCE_SERVICE`. Every method reads through `handle.state()` (never `handle.slice()`, which
 * would declare a mutation, ARCHITECTURE.md section 6.2) and computes balance sheets with
 * accounting's own pure `balanceSheet` over the live ledger, so no figure is a private copy.
 *
 * `quoteLoan` and `availableCredit` need the bank (content) and the policy rate source. A
 * `ServiceHandle` does not expose the scenario, so the finance system binds both at the start of
 * each of its phases (the pattern economy uses). Before the first `apply` of a world (or of a
 * restored world) those two methods throw `InvariantError('finance.content_unbound')`; the UI can use
 * the pure `previewLoan` instead.
 */
import { balanceSheet, getLedger, hasEntity } from '../accounting/index.js';
import {
  createServiceKey,
  sortedKeys,
  type DeepReadonly,
  type ServiceHandle,
  type ServiceKey,
} from '../engine/index.js';
import {
  InvariantError,
  ZERO_MONEY,
  addMoney,
  err,
  type CompanyId,
  type CreditState,
  type FinanceState,
  type Loan,
  type Money,
  type Result,
  type WorldState,
} from '../schema/index.js';
import {
  assessLoan,
  availableCreditFor,
  bankOf,
  type LoanQuote,
  type ReadonlyContentPack,
  type UnderwritingRejection,
} from './underwriting.js';

export interface FinanceApi {
  /** The company's loans (every status), sorted by id. */
  loansOf(companyId: CompanyId): readonly DeepReadonly<Loan>[];
  credit(companyId: CompanyId): DeepReadonly<CreditState> | null;
  /** Largest principal `quoteLoan` accepts at the bank's `maxTermMonths`; `0` if none or no bank. */
  availableCredit(companyId: CompanyId): Money;
  quoteLoan(
    companyId: CompanyId,
    principal: Money,
    termMonths: number,
  ): Result<LoanQuote, UnderwritingRejection>;
  /** Σ outstanding + Σ accrued interest over `active`/`defaulted` loans. */
  totalDebt(companyId: CompanyId): Money;
}

/** Internal surface the finance system uses on its own service; not exported from the barrel. */
export interface FinanceApiInternal extends FinanceApi {
  bind(content: ReadonlyContentPack, economyRegistered: boolean): void;
}

export const FINANCE_SERVICE: ServiceKey<FinanceApi> = createServiceKey<FinanceApi>('finance');

/**
 * Policy rate (finance.md section 4: `economy.policyRate()`): the economy slice's
 * `macro.policyRate` when the economy system runs (what `EconomyApi.policyRate` returns), else the
 * scenario's `content.economy.macro.policyRate` (worlds without economy, e.g. finance unit tests).
 */
export function policyRateOf(
  state: DeepReadonly<Pick<WorldState, 'economy'>>,
  content: ReadonlyContentPack,
  economyRegistered: boolean,
): number {
  return economyRegistered ? state.economy.macro.policyRate : content.economy.macro.policyRate;
}

/** Loans of `companyId` in `sortedKeys` order. */
export function loansOfIn(
  finance: DeepReadonly<FinanceState>,
  companyId: CompanyId,
): DeepReadonly<Loan>[] {
  const out: DeepReadonly<Loan>[] = [];
  for (const id of sortedKeys(finance.loans)) {
    const loan = finance.loans[id];
    if (loan?.borrowerId === companyId) out.push(loan);
  }
  return out;
}

/** Σ outstanding + Σ accruedInterest over the company's non-closed loans. */
export function totalDebtIn(finance: DeepReadonly<FinanceState>, companyId: CompanyId): Money {
  let total = ZERO_MONEY;
  for (const loan of loansOfIn(finance, companyId)) {
    if (loan.status === 'closed') continue;
    total = addMoney(total, addMoney(loan.outstanding, loan.accruedInterest));
  }
  return total;
}

export function createFinanceApi(handle: ServiceHandle<FinanceState>): FinanceApiInternal {
  let bound: { content: ReadonlyContentPack; economyRegistered: boolean } | null = null;
  const binding = (): { content: ReadonlyContentPack; economyRegistered: boolean } => {
    if (bound === null) {
      throw new InvariantError(
        'finance.content_unbound',
        'FinanceApi.quoteLoan/availableCredit used before the finance system first ran',
      );
    }
    return bound;
  };
  const view = (): DeepReadonly<FinanceState> => handle.state().finance;
  const sheetOf = (companyId: CompanyId) =>
    balanceSheet(getLedger(handle.state().accounting, companyId));

  return {
    bind(content, economyRegistered) {
      bound = { content, economyRegistered };
    },
    loansOf(companyId) {
      return loansOfIn(view(), companyId);
    },
    credit(companyId) {
      return view().credit[companyId] ?? null;
    },
    availableCredit(companyId) {
      const bank = bankOf(binding().content);
      if (bank === null || !hasEntity(handle.state().accounting, companyId)) return ZERO_MONEY;
      return availableCreditFor(sheetOf(companyId), bank);
    },
    quoteLoan(companyId, principal, termMonths) {
      const { content, economyRegistered } = binding();
      const bank = bankOf(content);
      if (bank === null) return err({ code: 'no_bank', message: 'no bank is available' });
      const rate = policyRateOf(handle.state(), content, economyRegistered);
      return assessLoan(sheetOf(companyId), principal, termMonths, bank, rate);
    },
    totalDebt(companyId) {
      return totalDebtIn(view(), companyId);
    },
  };
}
