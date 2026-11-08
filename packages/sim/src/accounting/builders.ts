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
