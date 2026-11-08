/**
 * Economy slice (docs/design/economy.md section 3, ADR-011). Owned by the `economy` system.
 * Prices that no command sets and aggregate demand; holds no goods and no money.
 */
import { z } from 'zod';
import { deepFreeze } from './freeze.js';
import {
  CityIdSchema,
  MarketIdSchema,
  ProductIdSchema,
  RegionIdSchema,
  type CityId,
  type MarketId,
  type ProductId,
  type RegionId,
} from './ids.js';
import { checkKeyedBy } from './keyed.js';
import {
  FiniteNumberSchema,
  NonNegativeIntegerSchema,
  PositiveMoneySchema,
  QuantitySchema,
  type Money,
  type Quantity,
} from './money.js';

export interface MacroState {
  /** Cumulative price index; 1 at tick 0. */
  priceIndex: number;
  policyRate: number;
  demandIndex: number;
  /** Tick of the last monthly macro step (0 = never). */
  lastMonthApplied: number;
}

export interface ProductMarketState {
  /** Price level in [1 - kappa, 1 + kappa]. */
  level: number;
  /** Imbalance EMA (xbar) in [-1, 1]. */
  imbalanceEma: number;
  /** Today's reference price; >= 1. */
  referencePrice: Money;
  /** Baseline demand at the reference price, fixed when the day opens. */
  demandToday: Quantity;
  /** Decremented by clearings; <= `demandToday`. */
  demandRemaining: Quantity;
  /** Effective supply S (float; economy.md 4.2); >= 0. */
  offeredToday: number;
  soldToday: Quantity;
  /** Previous day's closed tallies (UI). */
  lastDemand: Quantity;
  /** >= 0. */
  lastOffered: number;
  lastSold: Quantity;
}

export interface MarketState {
  id: MarketId;
  city: CityId;
  region: RegionId;
  products: Record<ProductId, ProductMarketState>;
}

export interface CommodityState {
  level: number;
  volumeEma: number;
  /** Today's unit price; >= 1. */
  unitPrice: Money;
  purchasedToday: Quantity;
  lastPurchased: Quantity;
}

export interface EconomyState {
  macro: MacroState;
  markets: Record<MarketId, MarketState>;
  /** Keyed by the raw product. */
  commodities: Record<ProductId, CommodityState>;
}

/** Economy slice with no markets or commodities. Deep-frozen: install a copy. */
export const EMPTY_ECONOMY_STATE: EconomyState = deepFreeze({
  macro: { priceIndex: 1, policyRate: 0, demandIndex: 1, lastMonthApplied: 0 },
  markets: {},
  commodities: {},
});

// ---------------------------------------------------------------------------------------------
// zod validators
// ---------------------------------------------------------------------------------------------

const NonNegativeFloatSchema = FiniteNumberSchema.min(0);

export const MacroStateSchema = z.strictObject({
  priceIndex: FiniteNumberSchema.gt(0),
  policyRate: FiniteNumberSchema,
  demandIndex: FiniteNumberSchema,
  lastMonthApplied: NonNegativeIntegerSchema,
}) satisfies z.ZodType<MacroState>;

export const ProductMarketStateSchema = z
  .strictObject({
    level: FiniteNumberSchema,
    imbalanceEma: FiniteNumberSchema,
    referencePrice: PositiveMoneySchema,
    demandToday: QuantitySchema,
    demandRemaining: QuantitySchema,
    offeredToday: NonNegativeFloatSchema,
    soldToday: QuantitySchema,
    lastDemand: QuantitySchema,
    lastOffered: NonNegativeFloatSchema,
    lastSold: QuantitySchema,
  })
  .refine((s) => s.demandRemaining <= s.demandToday, {
    message: 'demandRemaining must not exceed demandToday',
    path: ['demandRemaining'],
  }) satisfies z.ZodType<ProductMarketState>;

export const MarketStateSchema = z.strictObject({
  id: MarketIdSchema,
  city: CityIdSchema,
  region: RegionIdSchema,
  products: z.record(ProductIdSchema, ProductMarketStateSchema),
}) satisfies z.ZodType<MarketState>;

export const CommodityStateSchema = z.strictObject({
  level: FiniteNumberSchema,
  volumeEma: FiniteNumberSchema,
  unitPrice: PositiveMoneySchema,
  purchasedToday: QuantitySchema,
  lastPurchased: QuantitySchema,
}) satisfies z.ZodType<CommodityState>;

export const EconomyStateSchema = z
  .strictObject({
    macro: MacroStateSchema,
    markets: z.record(MarketIdSchema, MarketStateSchema),
    commodities: z.record(ProductIdSchema, CommodityStateSchema),
  })
  .superRefine((state, ctx) => {
    checkKeyedBy(state.markets, 'id', (m) => m.id, ['markets'], ctx);
  }) satisfies z.ZodType<EconomyState>;
