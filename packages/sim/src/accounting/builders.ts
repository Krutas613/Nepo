/**
 * Line and entry builders (docs/design/accounting.md section 2). Builders only assemble a
 * `JournalEntryInput`; they never post and never validate beyond what `money()` already checks.
 * `post` is the single place that validates (a zero amount, for example, produces an
 * `invalid_line` error there). Builders that have an optional pair (cogs, accrued interest)
 * omit the pair when its amount is 0.
 *
 * Every entry builder takes the amounts first, then the posting system's `source`, then optional
 * `meta` (`memo` override and `ref` back-reference).
 */
import {
  ZERO_MONEY,
  addMoney,
  negMoney,
  type AccountCode,
  type EntityLedger,
  type JournalEntryInput,
  type JournalEntryRef,
  type JournalLine,
  type Money,
  type SystemId,
} from '../schema/index.js';
import { ACCOUNTS, isIncomeAccount } from './chart.js';
import { accountOf } from './ledger.js';

/** A debit line. */
export function dr(account: AccountCode, amount: Money): JournalLine {
  return { account, debit: amount, credit: ZERO_MONEY };
}

/** A credit line. */
export function cr(account: AccountCode, amount: Money): JournalLine {
  return { account, debit: ZERO_MONEY, credit: amount };
}

/** Optional metadata for entry builders. */
export interface EntryMeta {
  memo?: string;
  ref?: JournalEntryRef;
}

/** Assembles an entry; `meta.memo` overrides `defaultMemo`, `ref` is omitted when absent. */
export function makeJournalEntry(
  lines: JournalLine[],
  source: SystemId,
  defaultMemo: string,
  meta: EntryMeta = {},
): JournalEntryInput {
  const out: JournalEntryInput = { memo: meta.memo ?? defaultMemo, lines, source };
  if (meta.ref !== undefined) out.ref = meta.ref;
  return out;
}

/** Owners contribute capital: Dr 1000 Cash / Cr 3000 Share Capital. */
export function openingCapital(
  amount: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.CASH, amount), cr(ACCOUNTS.SHARE_CAPITAL, amount)],
    source,
    'Opening capital',
    meta,
  );
}

/**
 * Cash sale: Dr 1000 / Cr 4000 `revenue`; and, if `cogs > 0`, Dr 5000 / Cr 1210 `cogs`
 * (finished goods leave inventory at cost).
 */
export function cashSale(
  revenue: Money,
  cogs: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  const lines = [dr(ACCOUNTS.CASH, revenue), cr(ACCOUNTS.SALES, revenue)];
  if (cogs !== 0) lines.push(dr(ACCOUNTS.COGS, cogs), cr(ACCOUNTS.INVENTORY_FINISHED, cogs));
  return makeJournalEntry(lines, source, 'Cash sale', meta);
}

/** Sale on credit: Dr 1100 / Cr 4000 `revenue`; and, if `cogs > 0`, Dr 5000 / Cr 1210 `cogs`. */
export function creditSale(
  revenue: Money,
  cogs: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  const lines = [dr(ACCOUNTS.RECEIVABLES, revenue), cr(ACCOUNTS.SALES, revenue)];
  if (cogs !== 0) lines.push(dr(ACCOUNTS.COGS, cogs), cr(ACCOUNTS.INVENTORY_FINISHED, cogs));
  return makeJournalEntry(lines, source, 'Credit sale', meta);
}

/** Cash purchase of anything (inventory, PPE, an expense): Dr `account` / Cr 1000. */
export function cashPurchase(
  account: AccountCode,
  amount: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  return makeJournalEntry(
    [dr(account, amount), cr(ACCOUNTS.CASH, amount)],
    source,
    'Cash purchase',
    meta,
  );
}

/** Purchase on credit: Dr `account` / Cr 2000 Accounts Payable. */
export function creditPurchase(
  account: AccountCode,
  amount: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  return makeJournalEntry(
    [dr(account, amount), cr(ACCOUNTS.PAYABLES, amount)],
    source,
    'Credit purchase',
    meta,
  );
}

/** Loan proceeds received: Dr 1000 / Cr 2500. */
export function loanDrawdown(amount: Money, source: SystemId, meta?: EntryMeta): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.CASH, amount), cr(ACCOUNTS.LOANS, amount)],
    source,
    'Loan drawdown',
    meta,
  );
}

/**
 * Loan repayment: Dr 2500 `principal` (if > 0), Dr 2100 `interest` (accrued interest paid, if > 0) /
 * Cr 1000 `principal + interest`.
 */
export function loanRepayment(
  principal: Money,
  interest: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  const lines: JournalLine[] = [];
  if (principal !== 0) lines.push(dr(ACCOUNTS.LOANS, principal));
  if (interest !== 0) lines.push(dr(ACCOUNTS.INTEREST_PAYABLE, interest));
  lines.push(cr(ACCOUNTS.CASH, addMoney(principal, interest)));
  return makeJournalEntry(lines, source, 'Loan repayment', meta);
}

/** Interest accrued but not yet paid: Dr 7000 / Cr 2100. */
export function interestAccrual(
  amount: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.INTEREST_EXPENSE, amount), cr(ACCOUNTS.INTEREST_PAYABLE, amount)],
    source,
    'Interest accrual',
    meta,
  );
}

/** Interest earned in cash (e.g. on deposits): Dr 1000 / Cr 7100. */
export function interestIncome(
  amount: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.CASH, amount), cr(ACCOUNTS.INTEREST_INCOME, amount)],
    source,
    'Interest income',
    meta,
  );
}

/** Depreciation charge: Dr 6200 / Cr 1590. */
export function depreciation(amount: Money, source: SystemId, meta?: EntryMeta): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.DEPRECIATION, amount), cr(ACCOUNTS.ACCUM_DEPRECIATION, amount)],
    source,
    'Depreciation',
    meta,
  );
}

/** Wages paid in cash: Dr 6100 / Cr 1000. */
export function payroll(amount: Money, source: SystemId, meta?: EntryMeta): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.WAGES, amount), cr(ACCOUNTS.CASH, amount)],
    source,
    'Payroll',
    meta,
  );
}

// ---------------------------------------------------------------------------------------------
// M1 builders (ADR-012; docs/design/accounting.md section 2). Inventory moves between holder
// accounts at carrying cost; the caller computes the cost with `allocateMoney` (ADR-012 issue rule).
// ---------------------------------------------------------------------------------------------

/** Capital expenditure (facility or store build): Dr 1500 PP&E / Cr 1000. Discretionary. */
export function capex(amount: Money, source: SystemId, meta?: EntryMeta): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.PPE, amount), cr(ACCOUNTS.CASH, amount)],
    source,
    'Capital expenditure',
    meta,
  );
}

/** Raw materials bought for cash: Dr 1200 / Cr 1000. Discretionary. */
export function inventoryPurchase(
  amount: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.INVENTORY_RAW, amount), cr(ACCOUNTS.CASH, amount)],
    source,
    'Inventory purchase',
    meta,
  );
}

/**
 * Batches enter production: Dr 1205 `materials + labor` / Cr 1200 `materials` / Cr 1000 `labor`.
 * A zero credit side is omitted (no labour; or a recipe without inputs). Only the labour part spends
 * cash; it is discretionary (ADR-014), so the caller checks `cash >= labor` first.
 */
export function productionStart(
  materials: Money,
  labor: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  const lines = [dr(ACCOUNTS.INVENTORY_WIP, addMoney(materials, labor))];
  if (materials !== 0) lines.push(cr(ACCOUNTS.INVENTORY_RAW, materials));
  if (labor !== 0) lines.push(cr(ACCOUNTS.CASH, labor));
  return makeJournalEntry(lines, source, 'Production start', meta);
}

/** Batches finish: Dr 1210 Finished Goods / Cr 1205 Work in Progress. */
export function productionComplete(
  amount: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.INVENTORY_FINISHED, amount), cr(ACCOUNTS.INVENTORY_WIP, amount)],
    source,
    'Production complete',
    meta,
  );
}

/**
 * Same-entity move of finished goods to another holder: Dr `destination` / Cr 1210. M1: destination
 * `ACCOUNTS.INVENTORY_MERCHANDISE` (posted by manufacturing inside `withdraw`); M2 logistics uses
 * `ACCOUNTS.INVENTORY_TRANSIT`.
 */
export function internalTransfer(
  amount: Money,
  destination: AccountCode,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  return makeJournalEntry(
    [dr(destination, amount), cr(ACCOUNTS.INVENTORY_FINISHED, amount)],
    source,
    'Internal transfer',
    meta,
  );
}

/**
 * Store sale for cash: Dr 1000 / Cr 4000 `revenue`; and, if `cogs > 0`, Dr 5000 / Cr 1230 `cogs`
 * (merchandise leaves the shelf at carrying cost).
 */
export function retailSale(
  revenue: Money,
  cogs: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  const lines = [dr(ACCOUNTS.CASH, revenue), cr(ACCOUNTS.SALES, revenue)];
  if (cogs !== 0) lines.push(dr(ACCOUNTS.COGS, cogs), cr(ACCOUNTS.INVENTORY_MERCHANDISE, cogs));
  return makeJournalEntry(lines, source, 'Retail sale', meta);
}

/** Shrinkage or spoilage: Dr 6900 Other Operating Expense / Cr `account` (the holder account). */
export function inventoryWriteOff(
  account: AccountCode,
  amount: Money,
  source: SystemId,
  meta?: EntryMeta,
): JournalEntryInput {
  return makeJournalEntry(
    [dr(ACCOUNTS.OPEX_OTHER, amount), cr(account, amount)],
    source,
    'Inventory write-off',
    meta,
  );
}

// ---------------------------------------------------------------------------------------------
// Spend classes (ADR-014; docs/design/accounting.md section 2). Accounting only classifies; it never
// refuses a balanced entry because of cash. The posting system applies the rule before posting
// (reject the command with `insufficient_cash`, or scale the purchase down); finance owns the
// overdraft that covers non-discretionary spend.
// ---------------------------------------------------------------------------------------------

/** ADR-014 spend class. */
export type SpendClass = 'discretionary' | 'non_discretionary';

/**
 * The class of each spend the design docs name. Keys are postings, not builders, because
 * `loanRepayment` and `cashPurchase` are classed by context:
 * `loanRepaymentRequested` is a `loan.repay` command, `loanRepaymentScheduled` a scheduled payment
 * or the month-end overdraft-interest settlement; `operatingCost` is `cashPurchase(ACCOUNTS.OPEX_*)`.
 * For `productionStart` the discretionary amount is the labour (the only cash line).
 */
export const SPEND_CLASS = Object.freeze({
  capex: 'discretionary',
  inventoryPurchase: 'discretionary',
  productionStart: 'discretionary',
  loanRepaymentRequested: 'discretionary',
  operatingCost: 'non_discretionary',
  depreciation: 'non_discretionary',
  interestAccrual: 'non_discretionary',
  loanRepaymentScheduled: 'non_discretionary',
  inventoryWriteOff: 'non_discretionary',
} as const satisfies Record<string, SpendClass>);

export type SpendKind = keyof typeof SPEND_CLASS;

/**
 * ADR-014 affordability rule: discretionary spend requires `cash >= amount` at posting time;
 * non-discretionary spend is always allowed (it may take cash negative, covered by finance's
 * overdraft).
 */
export function canSpend(spendClass: SpendClass, cash: Money, amount: Money): boolean {
  return spendClass === 'non_discretionary' || cash >= amount;
}

/**
 * Year-end closing entry: moves every non-zero 4-7xxx balance into 3100 Retained Earnings
 * (each income account is posted to the opposite side of its balance; the net goes to 3100: a credit
 * for a profit, a debit for a loss). Accounts are visited in ascending code order. Returns `null`
 * when every 4-7xxx balance is already 0 (nothing to close). Built and posted by accounting only.
 */
export function closingEntry(ledger: EntityLedger, meta?: EntryMeta): JournalEntryInput | null {
  const lines: JournalLine[] = [];
  let net = ZERO_MONEY; // Σ 4-7xxx balances: > 0 is a net loss, < 0 a net profit
  for (const code of Object.keys(ledger.accounts).sort() as AccountCode[]) {
    if (!isIncomeAccount(code)) continue;
    const balance = accountOf(ledger, code).balance;
    if (balance === 0) continue;
    lines.push(balance > 0 ? cr(code, balance) : dr(code, negMoney(balance)));
    net = addMoney(net, balance);
  }
  if (lines.length === 0) return null;
  if (net > 0) lines.push(dr(ACCOUNTS.RETAINED_EARNINGS, net));
  else if (net < 0) lines.push(cr(ACCOUNTS.RETAINED_EARNINGS, negMoney(net)));
  return makeJournalEntry(lines, 'accounting', 'Year-end closing', meta);
}
