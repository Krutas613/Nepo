/**
 * Statement presentation: turns the accounting report shapes (docs/design/accounting.md section 5)
 * into display rows. Sign convention for display: everything is shown in its natural direction
 * (revenue, liabilities and equity positive when normal), so credit-normal accounts are negated
 * from the ledger's debit-normal signed form.
 */
import { accountTypeOf, incomeLineOf } from '@nepo/sim/accounting';
import type {
  AccountCode,
  BalanceSheet,
  CashFlowStatement,
  IncomeStatement,
} from '@nepo/sim/schema';
import { accountName, displayCode } from '../sim/selectors.js';

export type StatementRowKind = 'section' | 'line' | 'subtotal' | 'total' | 'spacer' | 'check';

export interface StatementRow {
  kind: StatementRowKind;
  label: string;
  /** Minor units; absent for sections and spacers. */
  amount?: number;
  /** Account number shown in the code column. */
  code?: string;
}

const section = (label: string): StatementRow => ({ kind: 'section', label });
const spacer = (): StatementRow => ({ kind: 'spacer', label: '' });
const total = (kind: 'subtotal' | 'total', label: string, amount: number): StatementRow => ({
  kind,
  label,
  amount,
});

function codesOf(byAccount: Readonly<Record<string, number>>): AccountCode[] {
  return Object.keys(byAccount).sort() as AccountCode[];
}

function accountLines(
  byAccount: Readonly<Record<string, number>>,
  include: (code: AccountCode) => boolean,
  sign: 1 | -1,
): StatementRow[] {
  const rows: StatementRow[] = [];
  for (const code of codesOf(byAccount)) {
    if (!include(code)) continue;
    const raw = byAccount[code] ?? 0;
    if (raw === 0) continue;
    rows.push({
      kind: 'line',
      label: accountName(code),
      code: displayCode(code),
      amount: raw * sign === 0 ? 0 : raw * sign,
    });
  }
  return rows;
}

export function incomeStatementRows(s: IncomeStatement): StatementRow[] {
  const by = s.byAccount;
  const line = (code: AccountCode, want: string): boolean => incomeLineOf(code) === want;
  return [
    section('Revenue'),
    ...accountLines(by, (c) => line(c, 'revenue'), -1),
    total('subtotal', 'Total revenue', s.revenue),
    section('Cost of goods sold'),
    ...accountLines(by, (c) => line(c, 'cogs'), 1),
    total('subtotal', 'Total cost of goods sold', s.cogs),
    total('total', 'Gross profit', s.grossProfit),
    spacer(),
    section('Operating expenses'),
    ...accountLines(by, (c) => line(c, 'opex'), 1),
    total('subtotal', 'Total operating expenses', s.opex),
    total('total', 'Operating income', s.operatingIncome),
    spacer(),
    section('Other income and expense'),
    ...accountLines(by, (c) => line(c, 'other'), -1),
    total('subtotal', 'Net other income', s.otherIncome),
    total('total', 'Pre-tax income', s.pretaxIncome),
    section('Income tax'),
    ...accountLines(by, (c) => line(c, 'tax'), 1),
    total('subtotal', 'Total income tax', s.incomeTax),
    spacer(),
    total('total', 'Net income', s.netIncome),
  ];
}

export function balanceSheetRows(b: BalanceSheet): StatementRow[] {
  const by = b.byAccount;
  const type = (code: AccountCode, want: string): boolean => accountTypeOf(code) === want;
  const bookedEquity = codesOf(by)
    .filter((c) => type(c, 'equity'))
    .reduce((sum, c) => sum - (by[c] ?? 0), 0);
  // Equity on the sheet includes earnings not yet closed into retained earnings.
  const currentEarnings = b.equity - bookedEquity;
  const equityRows = accountLines(by, (c) => type(c, 'equity'), -1);
  if (currentEarnings !== 0) {
    equityRows.push({ kind: 'line', label: 'Current period earnings', amount: currentEarnings });
  }
  return [
    section('Assets'),
    ...accountLines(by, (c) => type(c, 'asset'), 1),
    total('total', 'Total assets', b.assets),
    spacer(),
    section('Liabilities'),
    ...accountLines(by, (c) => type(c, 'liability'), -1),
    total('subtotal', 'Total liabilities', b.liabilities),
    section('Equity'),
    ...equityRows,
    total('subtotal', 'Total equity', b.equity),
    total('total', 'Total liabilities and equity', b.liabilities + b.equity),
    {
      kind: 'check',
      label: 'Assets less liabilities and equity',
      amount: b.assets - b.liabilities - b.equity,
    },
  ];
}

export function cashFlowRows(c: CashFlowStatement): StatementRow[] {
  return [
    section('Operating activities'),
    { kind: 'line', label: 'Net income', amount: c.netIncome },
    {
      kind: 'line',
      label: 'Working capital and non-cash adjustments',
      amount: c.operating - c.netIncome,
    },
    total('subtotal', 'Net cash from operating activities', c.operating),
    section('Investing activities'),
    total('subtotal', 'Net cash from investing activities', c.investing),
    section('Financing activities'),
    total('subtotal', 'Net cash from financing activities', c.financing),
    spacer(),
    total('total', 'Net change in cash', c.netChange),
    { kind: 'line', label: 'Opening cash', amount: c.openingCash },
    total('total', 'Closing cash', c.closingCash),
  ];
}
