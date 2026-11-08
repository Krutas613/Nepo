/**
 * Standard chart of accounts (docs/design/accounting.md section 1, ARCHITECTURE.md section 8.3).
 *
 * Storage form (schema v2, docs/design/schema-m1.md section 10): an `AccountCode` is the letter `a`
 * followed by four digits (`'a1000'`), so no record in state is keyed by an integer-like string.
 * Design docs write `1000` for `'a1000'`. The first digit (`code.charAt(1)`) fixes the account type:
 * `1xxx` asset, `2xxx` liability, `3xxx` equity, `4xxx` revenue, `5xxx`/`6xxx`/`7xxx` expense.
 * Because codes are fixed-width, string order equals numeric order, so "ascending code order" is
 * plain `Object.keys(...).sort()`. Other systems reference accounts only through the `ACCOUNTS.*`
 * constants, never string literals. Adding an account is a change to this template; codes are never
 * renumbered.
 */
import {
  ACCOUNT_CODE_PATTERN,
  InvariantError,
  accountCode,
  type AccountCode,
  type AccountType,
} from '../schema/index.js';

/** Named account codes of the standard template. */
export const ACCOUNTS = {
  CASH: accountCode('a1000'),
  RECEIVABLES: accountCode('a1100'),
  INVENTORY_RAW: accountCode('a1200'),
  /** Work in progress at facilities (M1, ADR-012). */
  INVENTORY_WIP: accountCode('a1205'),
  INVENTORY_FINISHED: accountCode('a1210'),
  INVENTORY_TRANSIT: accountCode('a1220'),
  /** Merchandise on store shelves (M1, ADR-012). */
  INVENTORY_MERCHANDISE: accountCode('a1230'),
  PPE: accountCode('a1500'),
  /** Contra-asset: carries a credit (negative) balance. */
  ACCUM_DEPRECIATION: accountCode('a1590'),
  INVESTMENTS: accountCode('a1800'),
  INTERCO_RECEIVABLE: accountCode('a1900'),
  PAYABLES: accountCode('a2000'),
  INTEREST_PAYABLE: accountCode('a2100'),
  TAX_PAYABLE: accountCode('a2200'),
  LOANS: accountCode('a2500'),
  INTERCO_PAYABLE: accountCode('a2900'),
  SHARE_CAPITAL: accountCode('a3000'),
  RETAINED_EARNINGS: accountCode('a3100'),
  SALES: accountCode('a4000'),
  INTERCO_SALES: accountCode('a4900'),
  COGS: accountCode('a5000'),
  INTERCO_COGS: accountCode('a5900'),
  OPEX_FACILITY: accountCode('a6000'),
  WAGES: accountCode('a6100'),
  DEPRECIATION: accountCode('a6200'),
  MARKETING: accountCode('a6300'),
  OPEX_OTHER: accountCode('a6900'),
  INTEREST_EXPENSE: accountCode('a7000'),
  /** Expense-range account with a credit balance; reported positive in `otherIncome`. */
  INTEREST_INCOME: accountCode('a7100'),
  DISPOSAL_GAIN_LOSS: accountCode('a7500'),
  INCOME_TAX: accountCode('a7900'),
} as const satisfies Record<string, AccountCode>;

export type AccountKey = keyof typeof ACCOUNTS;

/** One row of the chart template. */
export interface ChartAccount {
  readonly code: AccountCode;
  readonly name: string;
  readonly type: AccountType;
}

/**
 * The numeric part of a code (`'a1205'` -> 1205). Throws
 * `InvariantError('accounting.invalid_account_code')` for anything not of the form `a[1-7]NNN`.
 */
export function accountNumber(code: AccountCode): number {
  if (!ACCOUNT_CODE_PATTERN.test(code)) {
    throw new InvariantError(
      'accounting.invalid_account_code',
      `not an account code of the form a1000..a7999: ${code}`,
      { code },
    );
  }
  return Number.parseInt(code.slice(1), 10);
}

/**
 * First digit -> type: `1` asset, `2` liability, `3` equity, `4` revenue, `5|6|7` expense.
 * Throws `InvariantError('accounting.invalid_account_code')` for anything that is not `a` plus four
 * digits starting with 1-7.
 */
export function accountTypeOf(code: AccountCode): AccountType {
  const n = accountNumber(code);
  if (n < 2000) return 'asset';
  if (n < 3000) return 'liability';
  if (n < 4000) return 'equity';
  if (n < 5000) return 'revenue';
  return 'expense';
}

function row(code: AccountCode, name: string): ChartAccount {
  return Object.freeze({ code, name, type: accountTypeOf(code) });
}

/** The standard template, ascending by code. Every new entity is opened with exactly these accounts. */
export const STANDARD_CHART: readonly ChartAccount[] = Object.freeze([
  row(ACCOUNTS.CASH, 'Cash'),
  row(ACCOUNTS.RECEIVABLES, 'Accounts Receivable'),
  row(ACCOUNTS.INVENTORY_RAW, 'Inventory - Raw Materials'),
  row(ACCOUNTS.INVENTORY_WIP, 'Inventory - Work in Progress'),
  row(ACCOUNTS.INVENTORY_FINISHED, 'Inventory - Finished Goods'),
  row(ACCOUNTS.INVENTORY_TRANSIT, 'Inventory - In Transit'),
  row(ACCOUNTS.INVENTORY_MERCHANDISE, 'Inventory - Merchandise'),
  row(ACCOUNTS.PPE, 'Property, Plant & Equipment'),
  row(ACCOUNTS.ACCUM_DEPRECIATION, 'Accumulated Depreciation'),
  row(ACCOUNTS.INVESTMENTS, 'Investments in Subsidiaries'),
  row(ACCOUNTS.INTERCO_RECEIVABLE, 'Intercompany Receivable'),
  row(ACCOUNTS.PAYABLES, 'Accounts Payable'),
  row(ACCOUNTS.INTEREST_PAYABLE, 'Accrued Interest Payable'),
  row(ACCOUNTS.TAX_PAYABLE, 'Income Tax Payable'),
  row(ACCOUNTS.LOANS, 'Loans Payable'),
  row(ACCOUNTS.INTERCO_PAYABLE, 'Intercompany Payable'),
  row(ACCOUNTS.SHARE_CAPITAL, 'Share Capital'),
  row(ACCOUNTS.RETAINED_EARNINGS, 'Retained Earnings'),
  row(ACCOUNTS.SALES, 'Sales Revenue'),
  row(ACCOUNTS.INTERCO_SALES, 'Intercompany Revenue'),
  row(ACCOUNTS.COGS, 'Cost of Goods Sold'),
  row(ACCOUNTS.INTERCO_COGS, 'Intercompany COGS'),
  row(ACCOUNTS.OPEX_FACILITY, 'Facility Operating Expense'),
  row(ACCOUNTS.WAGES, 'Wages and Salaries'),
  row(ACCOUNTS.DEPRECIATION, 'Depreciation Expense'),
  row(ACCOUNTS.MARKETING, 'Marketing'),
  row(ACCOUNTS.OPEX_OTHER, 'Other Operating Expense'),
  row(ACCOUNTS.INTEREST_EXPENSE, 'Interest Expense'),
  row(ACCOUNTS.INTEREST_INCOME, 'Interest Income'),
  row(ACCOUNTS.DISPOSAL_GAIN_LOSS, 'Gain/Loss on Disposal'),
  row(ACCOUNTS.INCOME_TAX, 'Income Tax Expense'),
]);

// ---------------------------------------------------------------------------------------------
// Statement classification (docs/design/accounting.md section 3). Pure functions of the code.
// ---------------------------------------------------------------------------------------------

/** Income-statement line an account (4-7xxx) feeds; `null` for balance-sheet accounts (1-3xxx). */
export type IncomeLine = 'revenue' | 'cogs' | 'opex' | 'other' | 'tax';

/**
 * `4xxx` revenue, `5xxx` cogs, `6xxx` opex, `7000-7899` other income/expense (interest, disposal),
 * `7900-7999` income tax.
 */
export function incomeLineOf(code: AccountCode): IncomeLine | null {
  const n = accountNumber(code);
  if (n >= 4000 && n < 5000) return 'revenue';
  if (n >= 5000 && n < 6000) return 'cogs';
  if (n >= 6000 && n < 7000) return 'opex';
  if (n >= 7000 && n < 7900) return 'other';
  if (n >= 7900 && n < 8000) return 'tax';
  return null;
}

/** `true` for 4-7xxx accounts (closed into retained earnings at year end). */
export function isIncomeAccount(code: AccountCode): boolean {
  return incomeLineOf(code) !== null;
}

/** Cash-flow section of a non-cash balance-sheet account. */
export type CashFlowSection = 'cash' | 'operating' | 'investing' | 'financing';

/**
 * Classification for the indirect cash-flow statement. For the standard chart this is exactly the
 * design doc's sets: operating {1100,1200,1205,1210,1220,1230,1590,1900,2000,2100,2200,2900},
 * investing {1500,1800}, financing {2500,3000} plus 3100 (dividends: 3100 movements other than the
 * year-end closing entry, which is never inside a reported period). Ranges are used so that any
 * future account is classified too: 1500-1589 and 1800-1899 investing (1590-1599 accumulated
 * depreciation is a non-cash add-back, so operating); 2500-2599 and all 3xxx financing; every other
 * non-cash 1xxx/2xxx operating. Returns `null` for 4-7xxx (they enter through net income).
 */
export function cashFlowSectionOf(code: AccountCode): CashFlowSection | null {
  if (code === ACCOUNTS.CASH) return 'cash';
  const n = accountNumber(code);
  if (n >= 1000 && n < 2000) {
    const investing = (n >= 1500 && n < 1590) || (n >= 1800 && n < 1900);
    return investing ? 'investing' : 'operating';
  }
  if (n >= 2000 && n < 3000) return n >= 2500 && n < 2600 ? 'financing' : 'operating';
  if (n >= 3000 && n < 4000) return 'financing';
  return null;
}
