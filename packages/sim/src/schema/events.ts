/**
 * Events (ARCHITECTURE.md section 7.2). An append-only log per tick, numbered by `seq` in emission
 * order. Events are NOT part of `WorldState` and are not hashed (ADR-007).
 */
import { z } from 'zod';
import { PeriodKindSchema, type PeriodKind } from './accounting.js';
import { CommandTypeSchema, type CommandType } from './commands.js';
import {
  CityIdSchema,
  CompanyIdSchema,
  FacilityIdSchema,
  FacilityTypeIdSchema,
  JournalEntryIdSchema,
  LoanIdSchema,
  MarketIdSchema,
  ProductIdSchema,
  RecipeIdSchema,
  StoreFormatIdSchema,
  StoreIdSchema,
  type CityId,
  type CompanyId,
  type DistributiveOmit,
  type FacilityId,
  type FacilityTypeId,
  type JournalEntryId,
  type LoanId,
  type MarketId,
  type ProductId,
  type RecipeId,
  type StoreFormatId,
  type StoreId,
} from './ids.js';
import { StarvedReasonSchema, type StarvedReason } from './manufacturing.js';
import {
  FiniteNumberSchema,
  MoneySchema,
  NonNegativeIntegerSchema,
  QuantitySchema,
  SafeIntegerSchema,
  type Money,
  type Quantity,
} from './money.js';
import { SystemIdSchema, type SystemId } from './system.js';

export interface EventBase {
  tick: number;
  /** 0.. within the tick, in emission order. */
  seq: number;
  source: SystemId;
}

export interface CommandRejectedPayload {
  commandSeq: number;
  commandType: CommandType;
  issuer: CompanyId;
  /** Stable machine code, e.g. `unknown_issuer`, `no_handler`, `not_owner`, `invalid_name`. */
  code: string;
  reason: string;
}

export interface CommandRejectedEvent extends EventBase {
  type: 'command.rejected';
  payload: CommandRejectedPayload;
}

export interface CompanyFoundedPayload {
  companyId: CompanyId;
  name: string;
}

export interface CompanyFoundedEvent extends EventBase {
  type: 'company.founded';
  payload: CompanyFoundedPayload;
}

export interface CompanyRenamedPayload {
  companyId: CompanyId;
  name: string;
}

export interface CompanyRenamedEvent extends EventBase {
  type: 'company.renamed';
  payload: CompanyRenamedPayload;
}

export interface LedgerPostedPayload {
  entryId: JournalEntryId;
  entityId: CompanyId;
  memo: string;
}

export interface LedgerPostedEvent extends EventBase {
  type: 'ledger.posted';
  payload: LedgerPostedPayload;
}

export interface PeriodClosedPayload {
  entityId: CompanyId;
  kind: PeriodKind;
  year: number;
  month: number;
}

export interface PeriodClosedEvent extends EventBase {
  type: 'period.closed';
  payload: PeriodClosedPayload;
}

// ---------------------------------------------------------------------------------------------
// economy (docs/design/economy.md section 6)
// ---------------------------------------------------------------------------------------------

export interface MarketOpenedPayload {
  marketId: MarketId;
  cityId: CityId;
}

export interface MarketOpenedEvent extends EventBase {
  type: 'market.opened';
  payload: MarketOpenedPayload;
}

export interface MacroMonthAppliedPayload {
  tick: number;
  priceIndex: number;
}

export interface MacroMonthAppliedEvent extends EventBase {
  type: 'macro.month_applied';
  payload: MacroMonthAppliedPayload;
}

export interface CommodityPurchasedPayload {
  companyId: CompanyId;
  productId: ProductId;
  quantity: Quantity;
  unitPrice: Money;
  total: Money;
}

export interface CommodityPurchasedEvent extends EventBase {
  type: 'commodity.purchased';
  payload: CommodityPurchasedPayload;
}

// ---------------------------------------------------------------------------------------------
// manufacturing (docs/design/manufacturing.md section 7)
// ---------------------------------------------------------------------------------------------

/** One output line of a completed production batch. */
export interface ProductionOutput {
  productId: ProductId;
  quantity: Quantity;
  cost: Money;
}

export interface FacilityOrderedPayload {
  facilityId: FacilityId;
  companyId: CompanyId;
  facilityTypeId: FacilityTypeId;
  cityId: CityId;
  completesTick: number;
}

export interface FacilityOrderedEvent extends EventBase {
  type: 'facility.ordered';
  payload: FacilityOrderedPayload;
}

export interface FacilityCompletedPayload {
  facilityId: FacilityId;
}

export interface FacilityCompletedEvent extends EventBase {
  type: 'facility.completed';
  payload: FacilityCompletedPayload;
}

export interface FacilityRecipeSetPayload {
  facilityId: FacilityId;
  recipeId: RecipeId | null;
}

export interface FacilityRecipeSetEvent extends EventBase {
  type: 'facility.recipe_set';
  payload: FacilityRecipeSetPayload;
}

export interface FacilityProductionSetPayload {
  facilityId: FacilityId;
  targetBatches: Quantity;
}

export interface FacilityProductionSetEvent extends EventBase {
  type: 'facility.production_set';
  payload: FacilityProductionSetPayload;
}

export interface ProductionCompletedPayload {
  facilityId: FacilityId;
  recipeId: RecipeId;
  batches: Quantity;
  outputs: ProductionOutput[];
}

export interface ProductionCompletedEvent extends EventBase {
  type: 'production.completed';
  payload: ProductionCompletedPayload;
}

export interface ProductionStarvedPayload {
  facilityId: FacilityId;
  reason: StarvedReason;
  wanted: Quantity;
  started: Quantity;
}

export interface ProductionStarvedEvent extends EventBase {
  type: 'production.starved';
  payload: ProductionStarvedPayload;
}

// ---------------------------------------------------------------------------------------------
// retail (docs/design/retail.md section 7)
// ---------------------------------------------------------------------------------------------

export interface StoreOrderedPayload {
  storeId: StoreId;
  companyId: CompanyId;
  storeFormatId: StoreFormatId;
  cityId: CityId;
  completesTick: number;
}

export interface StoreOrderedEvent extends EventBase {
  type: 'store.ordered';
  payload: StoreOrderedPayload;
}

export interface StoreOpenedPayload {
  storeId: StoreId;
}

export interface StoreOpenedEvent extends EventBase {
  type: 'store.opened';
  payload: StoreOpenedPayload;
}

export interface StorePriceSetPayload {
  storeId: StoreId;
  productId: ProductId;
  price: Money | null;
}

export interface StorePriceSetEvent extends EventBase {
  type: 'store.price_set';
  payload: StorePriceSetPayload;
}

export interface StoreRestockPolicySetPayload {
  storeId: StoreId;
  productId: ProductId;
  sourceFacilityId: FacilityId | null;
  targetStock: Quantity;
}

export interface StoreRestockPolicySetEvent extends EventBase {
  type: 'store.restock_policy_set';
  payload: StoreRestockPolicySetPayload;
}

export interface StoreRestockedPayload {
  storeId: StoreId;
  facilityId: FacilityId;
  productId: ProductId;
  quantity: Quantity;
  cost: Money;
}

export interface StoreRestockedEvent extends EventBase {
  type: 'store.restocked';
  payload: StoreRestockedPayload;
}

export interface StoreRestockFailedPayload {
  storeId: StoreId;
  productId: ProductId;
  code: string;
}

export interface StoreRestockFailedEvent extends EventBase {
  type: 'store.restock_failed';
  payload: StoreRestockFailedPayload;
}

export interface StoreSoldPayload {
  storeId: StoreId;
  productId: ProductId;
  quantity: Quantity;
  revenue: Money;
  cogs: Money;
  price: Money;
  referencePrice: Money;
  stockout: boolean;
}

export interface StoreSoldEvent extends EventBase {
  type: 'store.sold';
  payload: StoreSoldPayload;
}

// ---------------------------------------------------------------------------------------------
// finance (docs/design/finance.md section 9)
// ---------------------------------------------------------------------------------------------

export interface LoanIssuedPayload {
  loanId: LoanId;
  companyId: CompanyId;
  principal: Money;
  termMonths: number;
  annualRate: number;
}

export interface LoanIssuedEvent extends EventBase {
  type: 'loan.issued';
  payload: LoanIssuedPayload;
}

export interface LoanPaymentPayload {
  loanId: LoanId;
  principal: Money;
  interest: Money;
  outstanding: Money;
}

export interface LoanPaymentEvent extends EventBase {
  type: 'loan.payment';
  payload: LoanPaymentPayload;
}

export interface LoanPaymentMissedPayload {
  loanId: LoanId;
  due: Money;
  cash: Money;
}

export interface LoanPaymentMissedEvent extends EventBase {
  type: 'loan.payment_missed';
  payload: LoanPaymentMissedPayload;
}

export interface LoanDefaultedPayload {
  loanId: LoanId;
}

export interface LoanDefaultedEvent extends EventBase {
  type: 'loan.defaulted';
  payload: LoanDefaultedPayload;
}

export interface LoanRepaidPayload {
  loanId: LoanId;
  principal: Money;
  interest: Money;
}

export interface LoanRepaidEvent extends EventBase {
  type: 'loan.repaid';
  payload: LoanRepaidPayload;
}

export interface LoanClosedPayload {
  loanId: LoanId;
}

export interface LoanClosedEvent extends EventBase {
  type: 'loan.closed';
  payload: LoanClosedPayload;
}

export interface CreditOverdrawnPayload {
  companyId: CompanyId;
  cash: Money;
}

export interface CreditOverdrawnEvent extends EventBase {
  type: 'credit.overdrawn';
  payload: CreditOverdrawnPayload;
}

export interface CreditInsolventPayload {
  companyId: CompanyId;
  cash: Money;
  limit: Money;
}

export interface CreditInsolventEvent extends EventBase {
  type: 'credit.insolvent';
  payload: CreditInsolventPayload;
}

export interface CreditRestoredPayload {
  companyId: CompanyId;
}

export interface CreditRestoredEvent extends EventBase {
  type: 'credit.restored';
  payload: CreditRestoredPayload;
}

/** Every event. */
export type Event =
  | CommandRejectedEvent
  | CompanyFoundedEvent
  | CompanyRenamedEvent
  | LedgerPostedEvent
  | PeriodClosedEvent
  | MarketOpenedEvent
  | MacroMonthAppliedEvent
  | CommodityPurchasedEvent
  | FacilityOrderedEvent
  | FacilityCompletedEvent
  | FacilityRecipeSetEvent
  | FacilityProductionSetEvent
  | ProductionCompletedEvent
  | ProductionStarvedEvent
  | StoreOrderedEvent
  | StoreOpenedEvent
  | StorePriceSetEvent
  | StoreRestockPolicySetEvent
  | StoreRestockedEvent
  | StoreRestockFailedEvent
  | StoreSoldEvent
  | LoanIssuedEvent
  | LoanPaymentEvent
  | LoanPaymentMissedEvent
  | LoanDefaultedEvent
  | LoanRepaidEvent
  | LoanClosedEvent
  | CreditOverdrawnEvent
  | CreditInsolventEvent
  | CreditRestoredEvent;

export type EventType = Event['type'];

/** What `emit()` takes: the engine stamps `tick`, `seq` and `source`. */
export type EventInput = DistributiveOmit<Event, 'tick' | 'seq' | 'source'>;

/** Event payload by event type. */
export type EventPayload<T extends EventType> = Extract<Event, { type: T }>['payload'];

export const EVENT_TYPES: readonly EventType[] = [
  'command.rejected',
  'company.founded',
  'company.renamed',
  'ledger.posted',
  'period.closed',
  'market.opened',
  'macro.month_applied',
  'commodity.purchased',
  'facility.ordered',
  'facility.completed',
  'facility.recipe_set',
  'facility.production_set',
  'production.completed',
  'production.starved',
  'store.ordered',
  'store.opened',
  'store.price_set',
  'store.restock_policy_set',
  'store.restocked',
  'store.restock_failed',
  'store.sold',
  'loan.issued',
  'loan.payment',
  'loan.payment_missed',
  'loan.defaulted',
  'loan.repaid',
  'loan.closed',
  'credit.overdrawn',
  'credit.insolvent',
  'credit.restored',
];

// ---------------------------------------------------------------------------------------------
// zod validators (events are not in state; these serve tests, tools and the UI)
// ---------------------------------------------------------------------------------------------

const eventBaseShape = {
  tick: NonNegativeIntegerSchema,
  seq: NonNegativeIntegerSchema,
  source: SystemIdSchema,
};

export const CommandRejectedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('command.rejected'),
  payload: z.strictObject({
    commandSeq: NonNegativeIntegerSchema,
    commandType: CommandTypeSchema,
    issuer: CompanyIdSchema,
    code: z.string(),
    reason: z.string(),
  }),
}) satisfies z.ZodType<CommandRejectedEvent>;

export const CompanyFoundedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('company.founded'),
  payload: z.strictObject({ companyId: CompanyIdSchema, name: z.string() }),
}) satisfies z.ZodType<CompanyFoundedEvent>;

export const CompanyRenamedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('company.renamed'),
  payload: z.strictObject({ companyId: CompanyIdSchema, name: z.string() }),
}) satisfies z.ZodType<CompanyRenamedEvent>;

export const LedgerPostedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('ledger.posted'),
  payload: z.strictObject({
    entryId: JournalEntryIdSchema,
    entityId: CompanyIdSchema,
    memo: z.string(),
  }),
}) satisfies z.ZodType<LedgerPostedEvent>;

export const PeriodClosedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('period.closed'),
  payload: z.strictObject({
    entityId: CompanyIdSchema,
    kind: PeriodKindSchema,
    year: SafeIntegerSchema,
    month: z.int().min(1).max(12),
  }),
}) satisfies z.ZodType<PeriodClosedEvent>;

// economy

export const MarketOpenedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('market.opened'),
  payload: z.strictObject({
    marketId: MarketIdSchema,
    cityId: CityIdSchema,
  }),
}) satisfies z.ZodType<MarketOpenedEvent>;

export const MacroMonthAppliedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('macro.month_applied'),
  payload: z.strictObject({
    tick: NonNegativeIntegerSchema,
    priceIndex: FiniteNumberSchema,
  }),
}) satisfies z.ZodType<MacroMonthAppliedEvent>;

export const CommodityPurchasedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('commodity.purchased'),
  payload: z.strictObject({
    companyId: CompanyIdSchema,
    productId: ProductIdSchema,
    quantity: QuantitySchema,
    unitPrice: MoneySchema,
    total: MoneySchema,
  }),
}) satisfies z.ZodType<CommodityPurchasedEvent>;

// manufacturing

export const ProductionOutputSchema = z.strictObject({
  productId: ProductIdSchema,
  quantity: QuantitySchema,
  cost: MoneySchema,
}) satisfies z.ZodType<ProductionOutput>;

export const FacilityOrderedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('facility.ordered'),
  payload: z.strictObject({
    facilityId: FacilityIdSchema,
    companyId: CompanyIdSchema,
    facilityTypeId: FacilityTypeIdSchema,
    cityId: CityIdSchema,
    completesTick: NonNegativeIntegerSchema,
  }),
}) satisfies z.ZodType<FacilityOrderedEvent>;

export const FacilityCompletedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('facility.completed'),
  payload: z.strictObject({
    facilityId: FacilityIdSchema,
  }),
}) satisfies z.ZodType<FacilityCompletedEvent>;

export const FacilityRecipeSetEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('facility.recipe_set'),
  payload: z.strictObject({
    facilityId: FacilityIdSchema,
    recipeId: RecipeIdSchema.nullable(),
  }),
}) satisfies z.ZodType<FacilityRecipeSetEvent>;

export const FacilityProductionSetEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('facility.production_set'),
  payload: z.strictObject({
    facilityId: FacilityIdSchema,
    targetBatches: QuantitySchema,
  }),
}) satisfies z.ZodType<FacilityProductionSetEvent>;

export const ProductionCompletedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('production.completed'),
  payload: z.strictObject({
    facilityId: FacilityIdSchema,
    recipeId: RecipeIdSchema,
    batches: QuantitySchema,
    outputs: z.array(ProductionOutputSchema),
  }),
}) satisfies z.ZodType<ProductionCompletedEvent>;

export const ProductionStarvedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('production.starved'),
  payload: z.strictObject({
    facilityId: FacilityIdSchema,
    reason: StarvedReasonSchema,
    wanted: QuantitySchema,
    started: QuantitySchema,
  }),
}) satisfies z.ZodType<ProductionStarvedEvent>;

// retail

export const StoreOrderedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('store.ordered'),
  payload: z.strictObject({
    storeId: StoreIdSchema,
    companyId: CompanyIdSchema,
    storeFormatId: StoreFormatIdSchema,
    cityId: CityIdSchema,
    completesTick: NonNegativeIntegerSchema,
  }),
}) satisfies z.ZodType<StoreOrderedEvent>;

export const StoreOpenedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('store.opened'),
  payload: z.strictObject({
    storeId: StoreIdSchema,
  }),
}) satisfies z.ZodType<StoreOpenedEvent>;

export const StorePriceSetEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('store.price_set'),
  payload: z.strictObject({
    storeId: StoreIdSchema,
    productId: ProductIdSchema,
    price: MoneySchema.nullable(),
  }),
}) satisfies z.ZodType<StorePriceSetEvent>;

export const StoreRestockPolicySetEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('store.restock_policy_set'),
  payload: z.strictObject({
    storeId: StoreIdSchema,
    productId: ProductIdSchema,
    sourceFacilityId: FacilityIdSchema.nullable(),
    targetStock: QuantitySchema,
  }),
}) satisfies z.ZodType<StoreRestockPolicySetEvent>;

export const StoreRestockedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('store.restocked'),
  payload: z.strictObject({
    storeId: StoreIdSchema,
    facilityId: FacilityIdSchema,
    productId: ProductIdSchema,
    quantity: QuantitySchema,
    cost: MoneySchema,
  }),
}) satisfies z.ZodType<StoreRestockedEvent>;

export const StoreRestockFailedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('store.restock_failed'),
  payload: z.strictObject({
    storeId: StoreIdSchema,
    productId: ProductIdSchema,
    code: z.string(),
  }),
}) satisfies z.ZodType<StoreRestockFailedEvent>;

export const StoreSoldEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('store.sold'),
  payload: z.strictObject({
    storeId: StoreIdSchema,
    productId: ProductIdSchema,
    quantity: QuantitySchema,
    revenue: MoneySchema,
    cogs: MoneySchema,
    price: MoneySchema,
    referencePrice: MoneySchema,
    stockout: z.boolean(),
  }),
}) satisfies z.ZodType<StoreSoldEvent>;

// finance

export const LoanIssuedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('loan.issued'),
  payload: z.strictObject({
    loanId: LoanIdSchema,
    companyId: CompanyIdSchema,
    principal: MoneySchema,
    termMonths: z.int().min(1),
    annualRate: FiniteNumberSchema,
  }),
}) satisfies z.ZodType<LoanIssuedEvent>;

export const LoanPaymentEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('loan.payment'),
  payload: z.strictObject({
    loanId: LoanIdSchema,
    principal: MoneySchema,
    interest: MoneySchema,
    outstanding: MoneySchema,
  }),
}) satisfies z.ZodType<LoanPaymentEvent>;

export const LoanPaymentMissedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('loan.payment_missed'),
  payload: z.strictObject({
    loanId: LoanIdSchema,
    due: MoneySchema,
    cash: MoneySchema,
  }),
}) satisfies z.ZodType<LoanPaymentMissedEvent>;

export const LoanDefaultedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('loan.defaulted'),
  payload: z.strictObject({
    loanId: LoanIdSchema,
  }),
}) satisfies z.ZodType<LoanDefaultedEvent>;

export const LoanRepaidEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('loan.repaid'),
  payload: z.strictObject({
    loanId: LoanIdSchema,
    principal: MoneySchema,
    interest: MoneySchema,
  }),
}) satisfies z.ZodType<LoanRepaidEvent>;

export const LoanClosedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('loan.closed'),
  payload: z.strictObject({
    loanId: LoanIdSchema,
  }),
}) satisfies z.ZodType<LoanClosedEvent>;

export const CreditOverdrawnEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('credit.overdrawn'),
  payload: z.strictObject({
    companyId: CompanyIdSchema,
    cash: MoneySchema,
  }),
}) satisfies z.ZodType<CreditOverdrawnEvent>;

export const CreditInsolventEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('credit.insolvent'),
  payload: z.strictObject({
    companyId: CompanyIdSchema,
    cash: MoneySchema,
    limit: MoneySchema,
  }),
}) satisfies z.ZodType<CreditInsolventEvent>;

export const CreditRestoredEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('credit.restored'),
  payload: z.strictObject({
    companyId: CompanyIdSchema,
  }),
}) satisfies z.ZodType<CreditRestoredEvent>;

export const EventSchema = z.discriminatedUnion('type', [
  CommandRejectedEventSchema,
  CompanyFoundedEventSchema,
  CompanyRenamedEventSchema,
  LedgerPostedEventSchema,
  PeriodClosedEventSchema,
  MarketOpenedEventSchema,
  MacroMonthAppliedEventSchema,
  CommodityPurchasedEventSchema,
  FacilityOrderedEventSchema,
  FacilityCompletedEventSchema,
  FacilityRecipeSetEventSchema,
  FacilityProductionSetEventSchema,
  ProductionCompletedEventSchema,
  ProductionStarvedEventSchema,
  StoreOrderedEventSchema,
  StoreOpenedEventSchema,
  StorePriceSetEventSchema,
  StoreRestockPolicySetEventSchema,
  StoreRestockedEventSchema,
  StoreRestockFailedEventSchema,
  StoreSoldEventSchema,
  LoanIssuedEventSchema,
  LoanPaymentEventSchema,
  LoanPaymentMissedEventSchema,
  LoanDefaultedEventSchema,
  LoanRepaidEventSchema,
  LoanClosedEventSchema,
  CreditOverdrawnEventSchema,
  CreditInsolventEventSchema,
  CreditRestoredEventSchema,
]) satisfies z.ZodType<Event>;
