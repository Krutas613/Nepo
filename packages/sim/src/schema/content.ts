/**
 * Content definitions authored in `data/` (ARCHITECTURE.md section 15). Minimal M0 shapes; they will
 * be revised by M1 requests and are NOT yet part of `WorldState`.
 *
 * These are definitions (templates), not runtime instances: `Facility` describes a facility type
 * (keyed by `FacilityTypeId`), `Store` describes a store format (keyed by `StoreFormatId`). Runtime
 * instances with registry IDs (`FacilityId`, `StoreId`) arrive with the M1 slices.
 *
 * Validators check shape only; cross-references between files (e.g. a recipe's product exists)
 * are checked by the M1 content loader.
 */
import { z } from 'zod';
import {
  CityIdSchema,
  FacilityTypeIdSchema,
  MarketIdSchema,
  ProductIdSchema,
  RecipeIdSchema,
  RegionIdSchema,
  StoreFormatIdSchema,
  type CityId,
  type FacilityTypeId,
  type MarketId,
  type ProductId,
  type RecipeId,
  type RegionId,
  type StoreFormatId,
} from './ids.js';
import { MoneySchema, QuantitySchema, type Money, type Quantity } from './money.js';

export type ProductCategory = 'raw' | 'intermediate' | 'consumer';

export interface Product {
  id: ProductId;
  name: string;
  category: ProductCategory;
  /** Unit the price and quantities refer to (e.g. `tonne`, `unit`). */
  unit: string;
  /** Reference price per unit in minor units; at least 1 (section 4). */
  basePrice: Money;
}

export interface RecipeLine {
  product: ProductId;
  /** Units per production batch; at least 1. */
  quantity: Quantity;
}

export interface Recipe {
  id: RecipeId;
  name: string;
  /** Facility type that can run this recipe. */
  facility: FacilityTypeId;
  /** Empty for raw extraction (farms, mines). */
  inputs: RecipeLine[];
  /** At least one output. */
  outputs: RecipeLine[];
  /** Ticks per batch; at least 1. */
  durationTicks: number;
}

export type FacilityKind = 'farm' | 'mine' | 'factory' | 'warehouse';

/** A facility type definition. */
export interface Facility {
  id: FacilityTypeId;
  name: string;
  kind: FacilityKind;
  buildCost: Money;
  dailyOperatingCost: Money;
  /** Concurrent production batches (or storage units for warehouses). */
  capacity: Quantity;
}

/** A store format definition. */
export interface Store {
  id: StoreFormatId;
  name: string;
  buildCost: Money;
  dailyOperatingCost: Money;
  /** Total units the shelves hold. */
  shelfCapacity: Quantity;
  /** Product categories this format may sell. */
  categories: ProductCategory[];
}

export interface MarketDemand {
  product: ProductId;
  /** Baseline units demanded per day at `referencePrice`. */
  baseDailyDemand: Quantity;
  referencePrice: Money;
}

/** A consumer market in a city. */
export interface Market {
  id: MarketId;
  name: string;
  city: CityId;
  region: RegionId;
  population: Quantity;
  demand: MarketDemand[];
}

// ---------------------------------------------------------------------------------------------
// zod validators
// ---------------------------------------------------------------------------------------------

const PositiveMoneySchema = MoneySchema.refine((m) => m >= 1, 'must be at least 1 minor unit');
const NonNegativeMoneySchema = MoneySchema.refine((m) => m >= 0, 'must not be negative');
const PositiveQuantitySchema = QuantitySchema.refine((q) => q >= 1, 'must be at least 1');
const NameSchema = z.string().min(1);

export const ProductCategorySchema = z.enum([
  'raw',
  'intermediate',
  'consumer',
]) satisfies z.ZodType<ProductCategory>;

export const FacilityKindSchema = z.enum([
  'farm',
  'mine',
  'factory',
  'warehouse',
]) satisfies z.ZodType<FacilityKind>;

export const ProductSchema = z.strictObject({
  id: ProductIdSchema,
  name: NameSchema,
  category: ProductCategorySchema,
  unit: NameSchema,
  basePrice: PositiveMoneySchema,
}) satisfies z.ZodType<Product>;

export const RecipeLineSchema = z.strictObject({
  product: ProductIdSchema,
  quantity: PositiveQuantitySchema,
}) satisfies z.ZodType<RecipeLine>;

export const RecipeSchema = z.strictObject({
  id: RecipeIdSchema,
  name: NameSchema,
  facility: FacilityTypeIdSchema,
  inputs: z.array(RecipeLineSchema),
  outputs: z.array(RecipeLineSchema).min(1),
  durationTicks: z.int().min(1),
}) satisfies z.ZodType<Recipe>;

export const FacilitySchema = z.strictObject({
  id: FacilityTypeIdSchema,
  name: NameSchema,
  kind: FacilityKindSchema,
  buildCost: NonNegativeMoneySchema,
  dailyOperatingCost: NonNegativeMoneySchema,
  capacity: PositiveQuantitySchema,
}) satisfies z.ZodType<Facility>;

export const StoreSchema = z.strictObject({
  id: StoreFormatIdSchema,
  name: NameSchema,
  buildCost: NonNegativeMoneySchema,
  dailyOperatingCost: NonNegativeMoneySchema,
  shelfCapacity: PositiveQuantitySchema,
  categories: z.array(ProductCategorySchema).min(1),
}) satisfies z.ZodType<Store>;

export const MarketDemandSchema = z.strictObject({
  product: ProductIdSchema,
  baseDailyDemand: QuantitySchema,
  referencePrice: PositiveMoneySchema,
}) satisfies z.ZodType<MarketDemand>;

export const MarketSchema = z.strictObject({
  id: MarketIdSchema,
  name: NameSchema,
  city: CityIdSchema,
  region: RegionIdSchema,
  population: QuantitySchema,
  demand: z.array(MarketDemandSchema),
}) satisfies z.ZodType<Market>;
