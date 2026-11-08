/**
 * Finance slice (docs/design/finance.md section 3, ADR-014). Owned by the `finance` system: loans
 * and per-company credit status. Balances are never copied here; they are read from accounting.
 */
import { z } from 'zod';
import { deepFreeze } from './freeze.js';
import {
  BankIdSchema,
  CompanyIdSchema,
  LoanIdSchema,
  type BankId,
  type CompanyId,
  type LoanId,
} from './ids.js';
import { checkKeyedBy } from './keyed.js';
import {
  FiniteNumberSchema,
  NonNegativeIntegerSchema,
  NonNegativeMoneySchema,
  type Money,
} from './money.js';

export type LoanStatus = 'active' | 'defaulted' | 'closed';

export interface Loan {
  id: LoanId;
  borrowerId: CompanyId;
  bankId: BankId;
  principal: Money;
  /** Reconciles (over non-closed loans) to 2500. */
  outstanding: Money;
  /** Unpaid accrued interest; with overdraft interest reconciles to 2100. */
  accruedInterest: Money;
  /** Fixed at issue: policy rate + tier spread. */
  annualRate: number;
  termMonths: number;
  monthsRemaining: number;
  drawnTick: number;
  lastAccrualTick: number;
  missedPayments: number;
  consecutiveMissed: number;
  status: LoanStatus;
}

export interface CreditState {
  companyId: CompanyId;
  overdrawnSince: number | null;
  insolventSince: number | null;
  /** Unpaid overdraft interest (part of 2100). */
  overdraftAccrued: Money;
}

export interface FinanceState {
  loans: Record<LoanId, Loan>;
  /** Keyed by `companyId`. */
  credit: Record<CompanyId, CreditState>;
}

/** Finance slice with no loans and no credit records. Deep-frozen: install a copy. */
export const EMPTY_FINANCE_STATE: FinanceState = deepFreeze({ loans: {}, credit: {} });

// ---------------------------------------------------------------------------------------------
// zod validators
// ---------------------------------------------------------------------------------------------

export const LoanStatusSchema = z.enum([
  'active',
  'defaulted',
  'closed',
]) satisfies z.ZodType<LoanStatus>;

export const LoanSchema = z.strictObject({
  id: LoanIdSchema,
  borrowerId: CompanyIdSchema,
  bankId: BankIdSchema,
  principal: NonNegativeMoneySchema,
  outstanding: NonNegativeMoneySchema,
  accruedInterest: NonNegativeMoneySchema,
  annualRate: FiniteNumberSchema,
  termMonths: z.int().min(1),
  monthsRemaining: NonNegativeIntegerSchema,
  drawnTick: NonNegativeIntegerSchema,
  lastAccrualTick: NonNegativeIntegerSchema,
  missedPayments: NonNegativeIntegerSchema,
  consecutiveMissed: NonNegativeIntegerSchema,
  status: LoanStatusSchema,
}) satisfies z.ZodType<Loan>;

export const CreditStateSchema = z.strictObject({
  companyId: CompanyIdSchema,
  overdrawnSince: NonNegativeIntegerSchema.nullable(),
  insolventSince: NonNegativeIntegerSchema.nullable(),
  overdraftAccrued: NonNegativeMoneySchema,
}) satisfies z.ZodType<CreditState>;

export const FinanceStateSchema = z
  .strictObject({
    loans: z.record(LoanIdSchema, LoanSchema),
    credit: z.record(CompanyIdSchema, CreditStateSchema),
  })
  .superRefine((state, ctx) => {
    checkKeyedBy(state.loans, 'id', (l) => l.id, ['loans'], ctx);
    checkKeyedBy(state.credit, 'companyId', (c) => c.companyId, ['credit'], ctx);
  }) satisfies z.ZodType<FinanceState>;
