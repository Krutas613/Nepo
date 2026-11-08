/**
 * Retail slice (docs/design/retail.md section 3, ADR-012/013). Owned by the `retail` system:
 * stores, shelf lots, prices and restock policies.
 */
import { z } from 'zod';
import { deepFreeze } from './freeze.js';
import {
  CityIdSchema,
  CompanyIdSchema,
  FacilityIdSchema,
  MarketIdSchema,
  ProductIdSchema,
  StoreFormatIdSchema,
  StoreIdSchema,
  type CityId,
  type CompanyId,
  type FacilityId,
  type MarketId,
  type ProductId,
  type StoreFormatId,
  type StoreId,
} from './ids.js';
import { InventoryLotSchema, type InventoryLot } from './inventory.js';
import { checkKeyedBy } from './keyed.js';
import {
  FiniteNumberSchema,
  NonNegativeIntegerSchema,
  NonNegativeMoneySchema,
  PositiveMoneySchema,
  QuantitySchema,
  type Money,
  type Quantity,
} from './money.js';

export type StoreStatus = 'under_construction' | 'operating';

export interface RestockPolicy {
  /** `null` = no restocking. */
  sourceFacilityId: FacilityId | null;
  targetStock: Quantity;
}

export interface ShelfLine {
  /** Merchandise on the shelf (1230). */
  lot: InventoryLot;
  /** `null` = sell at today's reference price; otherwise >= 1. */
  price: Money | null;
  restock: RestockPolicy;
  /** Today's results, reset at the start of the store's market step. */
  soldToday: Quantity;
  revenueToday: Money;
  unmetToday: Quantity;
  /** Cumulative units written off (part of `lot.issued`). */
  shrunk: Quantity;
}

/** A store instance (its definition is the content `StoreFormat` named by `formatId`). */
export interface Store {
  id: StoreId;
  ownerId: CompanyId;
  formatId: StoreFormatId;
  cityId: CityId;
  marketId: MarketId;
  status: StoreStatus;
  orderedTick: number;
  completesTick: number;
  shelves: Record<ProductId, ShelfLine>;
  cost: Money;
  accumulatedDepreciation: Money;
  /** Placeholder (0 in M1), passed to `MarketOffer.brand`. */
  brand: number;
}

export interface RetailState {
  stores: Record<StoreId, Store>;
}

/** Retail slice with no stores. Deep-frozen: install a copy. */
export const EMPTY_RETAIL_STATE: RetailState = deepFreeze({ stores: {} });

// ---------------------------------------------------------------------------------------------
// zod validators
// ---------------------------------------------------------------------------------------------

export const StoreStatusSchema = z.enum([
  'under_construction',
  'operating',
]) satisfies z.ZodType<StoreStatus>;

export const RestockPolicySchema = z.strictObject({
  sourceFacilityId: FacilityIdSchema.nullable(),
  targetStock: QuantitySchema,
}) satisfies z.ZodType<RestockPolicy>;

export const ShelfLineSchema = z.strictObject({
  lot: InventoryLotSchema,
  price: PositiveMoneySchema.nullable(),
  restock: RestockPolicySchema,
  soldToday: QuantitySchema,
  revenueToday: NonNegativeMoneySchema,
  unmetToday: QuantitySchema,
  shrunk: QuantitySchema,
}) satisfies z.ZodType<ShelfLine>;

export const StoreSchema = z.strictObject({
  id: StoreIdSchema,
  ownerId: CompanyIdSchema,
  formatId: StoreFormatIdSchema,
  cityId: CityIdSchema,
  marketId: MarketIdSchema,
  status: StoreStatusSchema,
  orderedTick: NonNegativeIntegerSchema,
  completesTick: NonNegativeIntegerSchema,
  shelves: z.record(ProductIdSchema, ShelfLineSchema),
  cost: NonNegativeMoneySchema,
  accumulatedDepreciation: NonNegativeMoneySchema,
  brand: FiniteNumberSchema,
}) satisfies z.ZodType<Store>;

export const RetailStateSchema = z
  .strictObject({
    stores: z.record(StoreIdSchema, StoreSchema),
  })
  .superRefine((state, ctx) => {
    checkKeyedBy(state.stores, 'id', (s) => s.id, ['stores'], ctx);
  }) satisfies z.ZodType<RetailState>;
