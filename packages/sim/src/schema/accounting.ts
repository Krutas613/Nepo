/**
 * Accounting slice types (ARCHITECTURE.md section 8.1). Owned at runtime by the `accounting`
 * system; the chart template, `ACCOUNTS` constants and the posting API live in `accounting/`.
 *
 * Account codes are stored letter-prefixed (`'a1000'`, schema v2); docs write `1000`.
 *
 * Balances are debit-normal signed for every account type: debits increase, credits decrease.
 * Liability/equity/revenue accounts therefore carry negative balances; Σ balance per entity === 0.
 */
import { z } from 'zod';
import { deepFreeze } from './freeze.js';
import { checkKeyedBy } from './keyed.js';
import {
  AccountCodeSchema,
  CompanyIdSchema,
  JournalEntryIdSchema,
  type AccountCode,
  type CompanyId,
  type JournalEntryId,
} from './ids.js';
import { MoneySchema, NonNegativeIntegerSchema, SafeIntegerSchema, type Money } from './money.js';
import { SystemIdSchema, type SystemId } from './system.js';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type PeriodKind = 'month' | 'quarter' | 'year';

export interface LedgerAccount {
  code: AccountCode;
  name: string;
  type: AccountType;
  /** Debit-normal signed balance. */
  balance: Money;
}

/** Exactly one of `debit`/`credit` is > 0, the other === 0 (checked by `post`). */
export interface JournalLine {
  account: AccountCode;
  debit: Money;
  credit: Money;
}

/** Optional back-reference from an entry to the domain object that caused it. */
export interface JournalEntryRef {
  kind: string;
  id: string;
}

export interface JournalEntryInput {
  memo: string;
  lines: JournalLine[];
  source: SystemId;
  ref?: JournalEntryRef;
}

export interface JournalEntry extends JournalEntryInput {
  id: JournalEntryId;
  entityId: CompanyId;
  tick: number;
}

export interface IncomeStatement {
  revenue: Money;
  cogs: Money;
  grossProfit: Money;
  opex: Money;
  operatingIncome: Money;
  otherIncome: Money;
  pretaxIncome: Money;
  incomeTax: Money;
  netIncome: Money;
  /** Period movement per 4-7xxx account. */
  byAccount: Record<AccountCode, Money>;
}

/** `equity` includes current-period earnings; `assets === liabilities + equity`. */
export interface BalanceSheet {
  assets: Money;
  liabilities: Money;
  equity: Money;
  byAccount: Record<AccountCode, Money>;
}

export interface CashFlowStatement {
  netIncome: Money;
  operating: Money;
  investing: Money;
  financing: Money;
  netChange: Money;
  openingCash: Money;
  closingCash: Money;
}

export interface PeriodReport {
  kind: PeriodKind;
  year: number;
  month: number;
  tick: number;
  income: IncomeStatement;
  balance: BalanceSheet;
  cashFlow: CashFlowStatement;
}

export interface EntityLedger {
  entityId: CompanyId;
  /** Consolidation parent (used from M2). */
  parentId: CompanyId | null;
  accounts: Record<AccountCode, LedgerAccount>;
  /** Balances at the start of the current month. */
  monthOpening: Record<AccountCode, Money>;
  /** Balances at the start of the current fiscal year. */
  yearOpening: Record<AccountCode, Money>;
  /** Append-only, chronological. */
  reports: PeriodReport[];
}

export interface AccountingState {
  entities: Record<CompanyId, EntityLedger>;
  /** All entities, in posting order. */
  journal: JournalEntry[];
}

/**
 * Empty accounting slice: the value the engine installs at `state.accounting` when the accounting
 * system is not registered (ARCHITECTURE.md section 2), so no module hand-writes a slice shape.
 * Deep-frozen: install a copy (e.g. `structuredClone`), never this object itself.
 *
 * Convention: every typed slice gets an `EMPTY_<SLICE>` constant like this one, declared next to
 * its slice type and validated against its slice schema in schema's tests.
 */
export const EMPTY_ACCOUNTING_STATE: AccountingState = deepFreeze({ entities: {}, journal: [] });

// ---------------------------------------------------------------------------------------------
// zod validators
// ---------------------------------------------------------------------------------------------

export const AccountTypeSchema = z.enum([
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
]) satisfies z.ZodType<AccountType>;

export const PeriodKindSchema = z.enum([
  'month',
  'quarter',
  'year',
]) satisfies z.ZodType<PeriodKind>;

export const LedgerAccountSchema = z.strictObject({
  code: AccountCodeSchema,
  name: z.string(),
  type: AccountTypeSchema,
  balance: MoneySchema,
}) satisfies z.ZodType<LedgerAccount>;

export const JournalLineSchema = z.strictObject({
  account: AccountCodeSchema,
  debit: MoneySchema,
  credit: MoneySchema,
}) satisfies z.ZodType<JournalLine>;

export const JournalEntryRefSchema = z.strictObject({
  kind: z.string(),
  id: z.string(),
}) satisfies z.ZodType<JournalEntryRef>;

const journalEntryInputShape = {
  memo: z.string(),
  lines: z.array(JournalLineSchema),
  source: SystemIdSchema,
  ref: JournalEntryRefSchema.exactOptional(),
};

export const JournalEntryInputSchema = z.strictObject(
  journalEntryInputShape,
) satisfies z.ZodType<JournalEntryInput>;

export const JournalEntrySchema = z.strictObject({
  ...journalEntryInputShape,
  id: JournalEntryIdSchema,
  entityId: CompanyIdSchema,
  tick: NonNegativeIntegerSchema,
}) satisfies z.ZodType<JournalEntry>;

const moneyByAccount = z.record(AccountCodeSchema, MoneySchema);

export const IncomeStatementSchema = z.strictObject({
  revenue: MoneySchema,
  cogs: MoneySchema,
  grossProfit: MoneySchema,
  opex: MoneySchema,
  operatingIncome: MoneySchema,
  otherIncome: MoneySchema,
  pretaxIncome: MoneySchema,
  incomeTax: MoneySchema,
  netIncome: MoneySchema,
  byAccount: moneyByAccount,
}) satisfies z.ZodType<IncomeStatement>;

export const BalanceSheetSchema = z.strictObject({
  assets: MoneySchema,
  liabilities: MoneySchema,
  equity: MoneySchema,
  byAccount: moneyByAccount,
}) satisfies z.ZodType<BalanceSheet>;

export const CashFlowStatementSchema = z.strictObject({
  netIncome: MoneySchema,
  operating: MoneySchema,
  investing: MoneySchema,
  financing: MoneySchema,
  netChange: MoneySchema,
  openingCash: MoneySchema,
  closingCash: MoneySchema,
}) satisfies z.ZodType<CashFlowStatement>;

export const PeriodReportSchema = z.strictObject({
  kind: PeriodKindSchema,
  year: SafeIntegerSchema,
  month: z.int().min(1).max(12),
  tick: NonNegativeIntegerSchema,
  income: IncomeStatementSchema,
  balance: BalanceSheetSchema,
  cashFlow: CashFlowStatementSchema,
}) satisfies z.ZodType<PeriodReport>;

export const EntityLedgerSchema = z
  .strictObject({
    entityId: CompanyIdSchema,
    parentId: CompanyIdSchema.nullable(),
    accounts: z.record(AccountCodeSchema, LedgerAccountSchema),
    monthOpening: moneyByAccount,
    yearOpening: moneyByAccount,
    reports: z.array(PeriodReportSchema),
  })
  .superRefine((ledger, ctx) => {
    checkKeyedBy(ledger.accounts, 'code', (a) => a.code, ['accounts'], ctx);
  }) satisfies z.ZodType<EntityLedger>;

export const AccountingStateSchema = z
  .strictObject({
    entities: z.record(CompanyIdSchema, EntityLedgerSchema),
    journal: z.array(JournalEntrySchema),
  })
  .superRefine((state, ctx) => {
    checkKeyedBy(state.entities, 'entityId', (l) => l.entityId, ['entities'], ctx);
  }) satisfies z.ZodType<AccountingState>;
