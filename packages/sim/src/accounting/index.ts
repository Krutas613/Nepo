/**
 * Nepo `accounting` module: the only money path (ARCHITECTURE.md section 8). Owned by the
 * `accounting` agent.
 *
 * Other systems use `ctx.services.get(ACCOUNTING_SERVICE)` and the entry builders; they reference
 * accounts only through `ACCOUNTS.*` and round money only through `scaleMoney`/`allocateMoney`.
 * The pure ledger functions are exported for tests and tools; systems must go through the service.
 */
export { accountingSystem } from './system.js';
export { ACCOUNTING_SERVICE, createAccountingApi, type AccountingApi } from './service.js';
export {
  ACCOUNTS,
  STANDARD_CHART,
  accountNumber,
  accountTypeOf,
  cashFlowSectionOf,
  incomeLineOf,
  isIncomeAccount,
  type AccountKey,
  type CashFlowSection,
  type ChartAccount,
  type IncomeLine,
} from './chart.js';
export { allocateMoney, roundHalfAwayFromZero, scaleMoney } from './rounding.js';
export {
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
  makeJournalEntry,
  openingCapital,
  payroll,
  productionComplete,
  productionStart,
  retailSale,
  type EntryMeta,
  type SpendClass,
  type SpendKind,
} from './builders.js';
export {
  createAccountingState,
  getBalance,
  getLedger,
  hasEntity,
  openEntity,
  postEntry,
  postEntryOrThrow,
  snapshotBalances,
  validateEntry,
  type LedgerEnv,
  type PostingError,
  type PostingErrorCode,
} from './ledger.js';
export {
  balanceSheet,
  buildReport,
  cashFlowStatement,
  combineReports,
  incomeStatement,
  accountMovement,
  latestReport,
  type LedgerView,
  type OpeningBalances,
  type ReportDate,
} from './statements.js';
export { closePeriod, type CloseDate } from './close.js';
export {
  checkLedgerInvariants,
  type LedgerInvariantCode,
  type LedgerInvariantViolation,
} from './invariants.js';
