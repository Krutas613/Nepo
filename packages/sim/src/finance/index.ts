/**
 * Nepo `finance` module: term loans, the overdraft backstop and credit status
 * (docs/design/finance.md, ADR-014). Owned by the `finance` agent.
 *
 * Other systems and the UI use `services.get(FINANCE_SERVICE)` (read-only). The pure helpers
 * (`assessLoan`, `previewLoan`, `availableCreditFor`, schedule math) serve UI previews and tests;
 * `checkFinanceInvariants` is for sim-tests.
 */
export { financeSystem } from './system.js';
export {
  FINANCE_SERVICE,
  createFinanceApi,
  loansOfIn,
  policyRateOf,
  totalDebtIn,
  type FinanceApi,
} from './service.js';
export {
  annualRateFor,
  assessLoan,
  availableCreditFor,
  bankOf,
  previewLoan,
  type LoanQuote,
  type ReadonlyBank,
  type ReadonlyContentPack,
  type UnderwritingBalanceSheet,
  type UnderwritingCode,
  type UnderwritingRejection,
} from './underwriting.js';
export {
  RATE_GRID,
  amortisationSchedule,
  interestFor,
  overdraftInterest,
  principalDue,
  roundRate,
  splitRepayment,
  type RepaymentSplit,
} from './schedule.js';
export {
  accrueLoanInterest,
  createCreditState,
  createFinanceState,
  creditOf,
  payScheduledInstalment,
  processOverdraft,
  repayLoan,
  requestLoan,
  runFinanceDay,
  updateCreditFlags,
  type CommandRejection,
  type FinanceEnv,
  type RepayLoanCode,
  type RequestLoanCode,
} from './loans.js';
export {
  checkFinanceInvariants,
  checkLoanTransitions,
  isValidLoanTransition,
  type FinanceInvariantCode,
  type FinanceInvariantInput,
  type FinanceInvariantViolation,
} from './invariants.js';
