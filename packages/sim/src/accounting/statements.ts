/**
 * Financial statements (docs/design/accounting.md section 3). Pure functions of a ledger and an
 * opening-balance snapshot; nothing here mutates state.
 *
 * `mv(code) = balance(code) - opening[code]` is an account's movement over the period (a code
 * missing from `opening` counts as 0). Revenue and other credit-normal amounts are negated so the
 * statements present them positive.
 *
 * Income statement:
 *   revenue = -Σ mv(4xxx); cogs = Σ mv(5xxx); grossProfit = revenue - cogs; opex = Σ mv(6xxx);
 *   operatingIncome = grossProfit - opex; otherIncome = -Σ mv(7000-7899);
 *   pretaxIncome = operatingIncome + otherIncome; incomeTax = Σ mv(7900-7999);
 *   netIncome = pretaxIncome - incomeTax (= -Σ mv(4-7xxx)). byAccount = mv per 4-7xxx account.
 * Balance sheet (current balances):
 *   assets = Σ 1xxx; liabilities = -Σ 2xxx; equity = -(Σ 3xxx + Σ 4-7xxx) (includes undistributed
 *   current-year earnings); byAccount = balance per 1-3xxx account (debit-normal signed).
 * Cash flow (indirect): cashEffect(code) = -mv(code) for every non-cash balance-sheet account;
 *   operating = netIncome + Σ cashEffect(operating accounts); investing = Σ cashEffect(investing);
 *   financing = Σ cashEffect(financing); netChange = operating + investing + financing;
 *   openingCash = opening[1000]; closingCash = balance(1000). Classification: `cashFlowSectionOf`.
 *   Because Σ mv over all accounts === 0, netChange === closingCash - openingCash exactly.
 */
import type { DeepReadonly } from '../engine/system.js';
import {
  InvariantError,
  ZERO_MONEY,
  addMoney,
  negMoney,
  subMoney,
  type AccountCode,
  type BalanceSheet,
  type CashFlowStatement,
  type EntityLedger,
  type IncomeStatement,
  type Money,
  type PeriodKind,
  type PeriodReport,
} from '../schema/index.js';
import { ACCOUNTS, accountTypeOf, cashFlowSectionOf, incomeLineOf } from './chart.js';
import { accountOf } from './ledger.js';

/** Opening balances for a period, keyed by code; a missing code counts as 0. */
export type OpeningBalances = Readonly<Partial<Record<AccountCode, Money>>>;

/**
 * Statements only read the ledger, so they accept the read-only view too (the service answers
 * `balanceSheet` queries from `handle.state()`, docs/design/accounting.md section 7).
 */
export type LedgerView = DeepReadonly<EntityLedger>;

function sortedCodes(ledger: LedgerView): AccountCode[] {
  return Object.keys(ledger.accounts).sort() as AccountCode[];
}

function balanceOf(ledger: LedgerView, code: AccountCode): Money {
  return accountOf(ledger, code).balance;
}

/** Movement of `code` since `opening`. */
export function accountMovement(
  ledger: LedgerView,
  opening: OpeningBalances,
  code: AccountCode,
): Money {
  return subMoney(balanceOf(ledger, code), opening[code] ?? ZERO_MONEY);
}

export function incomeStatement(ledger: LedgerView, opening: OpeningBalances): IncomeStatement {
  let revenueMv = ZERO_MONEY;
  let cogs = ZERO_MONEY;
  let opex = ZERO_MONEY;
  let otherMv = ZERO_MONEY;
  let incomeTax = ZERO_MONEY;
  const byAccount = {} as Record<AccountCode, Money>;
  for (const code of sortedCodes(ledger)) {
    const line = incomeLineOf(code);
    if (line === null) continue;
    const mv = accountMovement(ledger, opening, code);
    byAccount[code] = mv;
    switch (line) {
      case 'revenue':
        revenueMv = addMoney(revenueMv, mv);
        break;
      case 'cogs':
        cogs = addMoney(cogs, mv);
        break;
      case 'opex':
        opex = addMoney(opex, mv);
        break;
      case 'other':
        otherMv = addMoney(otherMv, mv);
        break;
      case 'tax':
        incomeTax = addMoney(incomeTax, mv);
        break;
    }
  }
  const revenue = negMoney(revenueMv);
  const grossProfit = subMoney(revenue, cogs);
  const operatingIncome = subMoney(grossProfit, opex);
  const otherIncome = negMoney(otherMv);
  const pretaxIncome = addMoney(operatingIncome, otherIncome);
  const netIncome = subMoney(pretaxIncome, incomeTax);
  return {
    revenue,
    cogs,
    grossProfit,
    opex,
    operatingIncome,
    otherIncome,
    pretaxIncome,
    incomeTax,
    netIncome,
    byAccount,
  };
}

/**
 * Balance sheet from the ledger's current balances. Pure; computing it at any moment (not only at a
 * close) is what `AccountingApi.balanceSheet` does.
 */
export function balanceSheet(ledger: LedgerView): BalanceSheet {
  let assets = ZERO_MONEY;
  let liabilitiesSigned = ZERO_MONEY;
  let equitySigned = ZERO_MONEY; // 3xxx and 4-7xxx
  const byAccount = {} as Record<AccountCode, Money>;
  for (const code of sortedCodes(ledger)) {
    const balance = balanceOf(ledger, code);
    const type = accountTypeOf(code);
    if (type === 'asset') assets = addMoney(assets, balance);
    else if (type === 'liability') liabilitiesSigned = addMoney(liabilitiesSigned, balance);
    else equitySigned = addMoney(equitySigned, balance);
    if (type === 'asset' || type === 'liability' || type === 'equity') byAccount[code] = balance;
  }
  return {
    assets,
    liabilities: negMoney(liabilitiesSigned),
    equity: negMoney(equitySigned),
    byAccount,
  };
}

export function cashFlowStatement(
  ledger: LedgerView,
  opening: OpeningBalances,
  netIncome: Money,
): CashFlowStatement {
  let operating = netIncome;
  let investing = ZERO_MONEY;
  let financing = ZERO_MONEY;
  for (const code of sortedCodes(ledger)) {
    const section = cashFlowSectionOf(code);
    if (section === null || section === 'cash') continue;
    const cashEffect = negMoney(accountMovement(ledger, opening, code));
    if (section === 'operating') operating = addMoney(operating, cashEffect);
    else if (section === 'investing') investing = addMoney(investing, cashEffect);
    else financing = addMoney(financing, cashEffect);
  }
  return {
    netIncome,
    operating,
    investing,
    financing,
    netChange: addMoney(addMoney(operating, investing), financing),
    openingCash: opening[ACCOUNTS.CASH] ?? ZERO_MONEY,
    closingCash: balanceOf(ledger, ACCOUNTS.CASH),
  };
}

/** Where a report sits in the calendar. `CalendarDate` satisfies it. */
export interface ReportDate {
  readonly tick: number;
  readonly year: number;
  readonly month: number;
}

/** A full report for the period since `opening`, ending now. */
export function buildReport(
  ledger: LedgerView,
  opening: OpeningBalances,
  kind: PeriodKind,
  date: ReportDate,
): PeriodReport {
  const income = incomeStatement(ledger, opening);
  return {
    kind,
    year: date.year,
    month: date.month,
    tick: date.tick,
    income,
    balance: balanceSheet(ledger),
    cashFlow: cashFlowStatement(ledger, opening, income.netIncome),
  };
}

function sumByAccount(
  a: Readonly<Record<AccountCode, Money>>,
  b: Readonly<Record<AccountCode, Money>>,
): Record<AccountCode, Money> {
  const out = {} as Record<AccountCode, Money>;
  const codes = new Set([...Object.keys(a), ...Object.keys(b)] as AccountCode[]);
  for (const code of [...codes].sort()) {
    out[code] = addMoney(a[code] ?? ZERO_MONEY, b[code] ?? ZERO_MONEY);
  }
  return out;
}

/**
 * Combines consecutive reports (chronological, non-empty) into one covering their union: flow
 * figures are summed (every statement line is linear in the movements), `openingCash` comes from the
 * first, `closingCash` and the balance sheet from the last. Used for quarter reports, which are the
 * sum of the quarter's month reports (see close.ts).
 */
export function combineReports(
  kind: PeriodKind,
  reports: readonly PeriodReport[],
  date: ReportDate,
): PeriodReport {
  const first = reports[0];
  const last = reports[reports.length - 1];
  if (first === undefined || last === undefined) {
    throw new InvariantError('accounting.no_reports', 'combineReports needs at least one report');
  }
  let income = first.income;
  let cash = first.cashFlow;
  for (const r of reports.slice(1)) {
    const i = r.income;
    income = {
      revenue: addMoney(income.revenue, i.revenue),
      cogs: addMoney(income.cogs, i.cogs),
      grossProfit: addMoney(income.grossProfit, i.grossProfit),
      opex: addMoney(income.opex, i.opex),
      operatingIncome: addMoney(income.operatingIncome, i.operatingIncome),
      otherIncome: addMoney(income.otherIncome, i.otherIncome),
      pretaxIncome: addMoney(income.pretaxIncome, i.pretaxIncome),
      incomeTax: addMoney(income.incomeTax, i.incomeTax),
      netIncome: addMoney(income.netIncome, i.netIncome),
      byAccount: sumByAccount(income.byAccount, i.byAccount),
    };
    const c = r.cashFlow;
    cash = {
      netIncome: addMoney(cash.netIncome, c.netIncome),
      operating: addMoney(cash.operating, c.operating),
      investing: addMoney(cash.investing, c.investing),
      financing: addMoney(cash.financing, c.financing),
      netChange: addMoney(cash.netChange, c.netChange),
      openingCash: cash.openingCash,
      closingCash: c.closingCash,
    };
  }
  return {
    kind,
    year: date.year,
    month: date.month,
    tick: date.tick,
    income: { ...income, byAccount: { ...income.byAccount } },
    balance: { ...last.balance, byAccount: { ...last.balance.byAccount } },
    cashFlow: { ...cash },
  };
}

/** A deep copy of a report, detached from the ledger (reports in state must never be aliased). */
function copyReport(r: DeepReadonly<PeriodReport>): PeriodReport {
  return {
    ...r,
    income: { ...r.income, byAccount: { ...r.income.byAccount } },
    balance: { ...r.balance, byAccount: { ...r.balance.byAccount } },
    cashFlow: { ...r.cashFlow },
  };
}

/**
 * The last appended report of `kind` (reports are appended in close order, so this is the most
 * recently closed period of that kind), as a detached copy; `null` if none exists.
 */
export function latestReport(ledger: LedgerView, kind: PeriodKind): PeriodReport | null {
  for (let i = ledger.reports.length - 1; i >= 0; i--) {
    const r = ledger.reports[i];
    if (r?.kind === kind) return copyReport(r);
  }
  return null;
}
