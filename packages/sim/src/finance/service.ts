/**
 * `FinanceApi` (docs/design/finance.md section 7): read-only queries for the UI and AI, registered
 * under `FINANCE_SERVICE`. Every method reads through `handle.state()` (never `handle.slice()`, which
 * would declare a mutation, ARCHITECTURE.md section 6.2) and computes balance sheets with
 * accounting's own pure `balanceSheet` over the live ledger, so no figure is a private copy.
 *
 * `quoteLoan` and `availableCredit` read the bank from `handle.scenario().content` and the policy
 * rate through `policyRateOf(handle.services, ...)` on every call, so they work from world creation
 * on, including right after a `restore`.
 */
import { balanceSheet, getLedger, hasEntity } from '../accounting/index.js';
import { ECONOMY_SERVICE } from '../economy/index.js';
import {
  createServiceKey,
  sortedKeys,
  type DeepReadonly,
  type ServiceHandle,
  type ServiceKey,
  type ServiceRegistry,
} from '../engine/index.js';
import {
  ZERO_MONEY,
  addMoney,
  err,
  type CompanyId,
  type CreditState,
  type FinanceState,
  type Loan,
  type Money,
  type Result,
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

export const FINANCE_SERVICE: ServiceKey<FinanceApi> = createServiceKey<FinanceApi>('finance');

/**
 * Policy rate (finance.md section 4: `economy.policyRate()`): `EconomyApi.policyRate()` when the
 * economy system is registered, else the scenario's `content.economy.macro.policyRate` (worlds
 * without economy, e.g. finance unit tests).
 */
export function policyRateOf(services: ServiceRegistry, content: ReadonlyContentPack): number {
  return services.has(ECONOMY_SERVICE)
    ? services.get(ECONOMY_SERVICE).policyRate()
    : content.economy.macro.policyRate;
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

export function createFinanceApi(handle: ServiceHandle<FinanceState>): FinanceApi {
  const content = (): ReadonlyContentPack => handle.scenario().content;
  const view = (): DeepReadonly<FinanceState> => handle.state().finance;
  const sheetOf = (companyId: CompanyId) =>
    balanceSheet(getLedger(handle.state().accounting, companyId));

  return {
    loansOf(companyId) {
      return loansOfIn(view(), companyId);
    },
    credit(companyId) {
      return view().credit[companyId] ?? null;
    },
    availableCredit(companyId) {
      const bank = bankOf(content());
      if (bank === null || !hasEntity(handle.state().accounting, companyId)) return ZERO_MONEY;
      return availableCreditFor(sheetOf(companyId), bank);
    },
    quoteLoan(companyId, principal, termMonths) {
      const pack = content();
      const bank = bankOf(pack);
      if (bank === null) return err({ code: 'no_bank', message: 'no bank is available' });
      const rate = policyRateOf(handle.services, pack);
      return assessLoan(sheetOf(companyId), principal, termMonths, bank, rate);
    },
    totalDebt(companyId) {
      return totalDebtIn(view(), companyId);
    },
  };
}
