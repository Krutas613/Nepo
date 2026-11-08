/**
 * Content: authored definitions from `data/` (ARCHITECTURE.md section 15, ADR-010). Schema v2
 * (docs/design/schema-m1.md section 3).
 *
 * Content is not state. It travels in `Scenario.content` (a `ContentPack`), is assembled from the
 * parsed `data/` files by `assembleContentPack` (the single content validator), and is read by
 * systems through `ctx.scenario.content`. Definitions are templates: `FacilityType` and
 * `StoreFormat` describe what can be built; runtime instances (`Facility`, `Store`) live in the
 * manufacturing and retail slices.
 */
import { z } from 'zod';
import { formatSchemaIssues } from './commands.js';
import { deepFreeze } from './freeze.js';
import {
  BankIdSchema,
  CityIdSchema,
  FacilityTypeIdSchema,
  MarketIdSchema,
  ProductIdSchema,
  RecipeIdSchema,
  RegionIdSchema,
  StoreFormatIdSchema,
  type BankId,
  type CityId,
  type FacilityTypeId,
  type MarketId,
  type ProductId,
  type RecipeId,
  type RegionId,
  type StoreFormatId,
} from './ids.js';
import { checkKeyedBy } from './keyed.js';
import {
  FiniteNumberSchema,
  MoneySchema,
  NonNegativeMoneySchema,
  PositiveMoneySchema,
  PositiveQuantitySchema,
  QuantitySchema,
  type Money,
  type Quantity,
} from './money.js';
import { err, ok, type Result } from './result.js';

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

export type ProductCategory = 'raw' | 'intermediate' | 'consumer';

export interface Product {
  id: ProductId;
  name: string;
  category: ProductCategory;
  /** Unit the price and quantities refer to (e.g. `kg`, `unit`). */
  unit: string;
  /** Reference price per unit in minor units; >= 1 (ARCHITECTURE.md section 4). */
  basePrice: Money;
  /** Price elasticity `epsilon` of the demand response (economy.md 4.3); 0..5. */
  elasticity: number;
}

export interface RecipeLine {
  product: ProductId;
  /** Units per batch; >= 1. */
  quantity: Quantity;
}

export interface Recipe {
  id: RecipeId;
  name: string;
  /** Facility type that runs this recipe. */
  facilityType: FacilityTypeId;
  /** Empty for raw extraction. */
  inputs: RecipeLine[];
  /** At least one; `outputs[0]` is the primary output (storage planning). */
  outputs: RecipeLine[];
  /** Ticks per batch; int >= 1. */
  durationTicks: number;
  /** Direct labour per batch, capitalised into WIP; >= 0. */
  laborCostPerBatch: Money;
}

export type FacilityKind = 'farm' | 'mine' | 'factory';

export interface FacilityType {
  id: FacilityTypeId;
  name: string;
  kind: FacilityKind;
  /** >= 0; capitalised to PP&E (1500). */
  buildCost: Money;
  /** int >= 0; 0 = operating from the same tick's production phase. */
  constructionTicks: number;
  /** >= 0; period expense (6000). */
  dailyOperatingCost: Money;
  /** Maximum batches in progress; >= 1. */
  capacity: Quantity;
  /** Finished units the facility can hold (primary output); >= 1. */
  storageCapacity: Quantity;
  /** Straight-line depreciation life; int >= 1. */
  usefulLifeMonths: number;
}

export interface StoreFormat {
  id: StoreFormatId;
  name: string;
  /** >= 0. */
  buildCost: Money;
  /** int >= 0. */
  constructionTicks: number;
  /** >= 0. */
  dailyOperatingCost: Money;
  /** Total units across all products; >= 1. */
  shelfCapacity: Quantity;
  /** int >= 1. */
  usefulLifeMonths: number;
  /** Categories this format may sell; >= 1 entry. */
  categories: ProductCategory[];
  /** Units lost per day = floor(stock x this / 1000); int 0..100. */
  shrinkagePerMille: number;
}

export interface Region {
  id: RegionId;
  name: string;
}

export interface City {
  id: CityId;
  name: string;
  region: RegionId;
  population: Quantity;
}

export interface MarketDemand {
  /** Must exist and not be `raw`. Unique within a market. */
  product: ProductId;
  /** Baseline units per day at the reference price. */
  baseDailyDemand: Quantity;
  /** Multiplies `Product.basePrice` into this market's price anchor; 0.1..10. */
  priceFactor: number;
}

/** A consumer market; at most one per city. */
export interface Market {
  id: MarketId;
  name: string;
  city: CityId;
  demand: MarketDemand[];
}

/** Reference-price relaxation (ADR-011). */
export interface PricingTunables {
  /** Level relaxation rate; (0,1). */
  alpha: number;
  /** Imbalance EMA rate; (0,1). */
  beta: number;
  /** Maximum relative deviation of the level from 1; (0,0.5]. */
  kappa: number;
  /** Upper clamp of the demand response `g`; [1,3]. */
  maxCapture: number;
}

export interface MacroTunables {
  /** [-0.5,1]. */
  inflationAnnual: number;
  /** [0,1]. */
  policyRate: number;
  /** (0,10]. */
  demandIndex: number;
}

/** NPC supplier of a raw product (economy.md 4.4). Keyed by `product`. */
export interface CommoditySource {
  /** Must exist and be `raw`. */
  product: ProductId;
  /** >= 1. */
  referenceDailyVolume: Quantity;
  /** (0,1). */
  alpha: number;
  /** (0,0.5]. */
  kappa: number;
}

export interface SpreadTier {
  /** Leverage after the loan up to which this tier applies; > 0. */
  maxLeverage: number;
  /** Annual spread over the policy rate; >= 0. */
  spread: number;
}

export interface Bank {
  id: BankId;
  name: string;
  /** >= 1 tier, strictly ascending `maxLeverage`; beyond the last tier a loan is rejected. */
  spreadTiers: SpreadTier[];
  /** Equity must be >= this after the draw. */
  minEquity: Money;
  /** int 1..120, <= `maxTermMonths`. */
  minTermMonths: number;
  /** int 1..120. */
  maxTermMonths: number;
  /** >= 1. */
  minPrincipal: Money;
  /** principal <= equity x this; > 0. */
  maxPrincipalToEquity: number;
  /** Added to `annualRate` while payments are missed; >= 0. */
  latePenaltySpread: number;
  /** Consecutive missed payments before default; int >= 1. */
  defaultAfterMissed: number;
  /** >= 0 (ADR-014). */
  overdraftLimit: Money;
  /** [0,1]. */
  overdraftAnnualRate: number;
}

export interface EconomyContent {
  pricing: PricingTunables;
  macro: MacroTunables;
  /** Keyed by `CommoditySource.product`. */
  commodities: Record<ProductId, CommoditySource>;
}

export interface FinanceContent {
  banks: Record<BankId, Bank>;
}

/** Everything authored, keyed by id. Travels in `Scenario.content` (ADR-010). */
export interface ContentPack {
  products: Record<ProductId, Product>;
  recipes: Record<RecipeId, Recipe>;
  facilityTypes: Record<FacilityTypeId, FacilityType>;
  storeFormats: Record<StoreFormatId, StoreFormat>;
  regions: Record<RegionId, Region>;
  cities: Record<CityId, City>;
  markets: Record<MarketId, Market>;
  economy: EconomyContent;
  finance: FinanceContent;
}

/**
 * Empty content (no products, places or banks) with the suggested M1 tunables. What
 * `ScenarioSchema` supplies when a scenario omits `content`. Deep-frozen.
 */
export const EMPTY_CONTENT_PACK: ContentPack = deepFreeze({
  products: {},
  recipes: {},
  facilityTypes: {},
  storeFormats: {},
  regions: {},
  cities: {},
  markets: {},
  economy: {
    pricing: { alpha: 0.05, beta: 0.25, kappa: 0.3, maxCapture: 1.5 },
    macro: { inflationAnnual: 0, policyRate: 0.04, demandIndex: 1 },
    commodities: {},
  },
  finance: { banks: {} },
});

// ---------------------------------------------------------------------------------------------
// zod validators (single definitions)
// ---------------------------------------------------------------------------------------------

const NameSchema = z.string().min(1);
const OpenUnitSchema = FiniteNumberSchema.gt(0).lt(1);
const KappaSchema = FiniteNumberSchema.gt(0).max(0.5);
const TermMonthsSchema = z.int().min(1).max(120);

export const ProductCategorySchema = z.enum([
  'raw',
  'intermediate',
  'consumer',
]) satisfies z.ZodType<ProductCategory>;

export const FacilityKindSchema = z.enum([
  'farm',
  'mine',
  'factory',
]) satisfies z.ZodType<FacilityKind>;

export const ProductSchema = z.strictObject({
  id: ProductIdSchema,
  name: NameSchema,
  category: ProductCategorySchema,
  unit: NameSchema,
  basePrice: PositiveMoneySchema,
  elasticity: FiniteNumberSchema.min(0).max(5),
}) satisfies z.ZodType<Product>;

export const RecipeLineSchema = z.strictObject({
  product: ProductIdSchema,
  quantity: PositiveQuantitySchema,
}) satisfies z.ZodType<RecipeLine>;

export const RecipeSchema = z.strictObject({
  id: RecipeIdSchema,
  name: NameSchema,
  facilityType: FacilityTypeIdSchema,
  inputs: z.array(RecipeLineSchema),
  outputs: z.array(RecipeLineSchema).min(1),
  durationTicks: z.int().min(1),
  laborCostPerBatch: NonNegativeMoneySchema,
}) satisfies z.ZodType<Recipe>;

export const FacilityTypeSchema = z.strictObject({
  id: FacilityTypeIdSchema,
  name: NameSchema,
  kind: FacilityKindSchema,
  buildCost: NonNegativeMoneySchema,
  constructionTicks: z.int().min(0),
  dailyOperatingCost: NonNegativeMoneySchema,
  capacity: PositiveQuantitySchema,
  storageCapacity: PositiveQuantitySchema,
  usefulLifeMonths: z.int().min(1),
}) satisfies z.ZodType<FacilityType>;

export const StoreFormatSchema = z.strictObject({
  id: StoreFormatIdSchema,
  name: NameSchema,
  buildCost: NonNegativeMoneySchema,
  constructionTicks: z.int().min(0),
  dailyOperatingCost: NonNegativeMoneySchema,
  shelfCapacity: PositiveQuantitySchema,
  usefulLifeMonths: z.int().min(1),
  categories: z.array(ProductCategorySchema).min(1),
  shrinkagePerMille: z.int().min(0).max(100),
}) satisfies z.ZodType<StoreFormat>;

export const RegionSchema = z.strictObject({
  id: RegionIdSchema,
  name: NameSchema,
}) satisfies z.ZodType<Region>;

export const CitySchema = z.strictObject({
  id: CityIdSchema,
  name: NameSchema,
  region: RegionIdSchema,
  population: QuantitySchema,
}) satisfies z.ZodType<City>;

export const MarketDemandSchema = z.strictObject({
  product: ProductIdSchema,
  baseDailyDemand: QuantitySchema,
  priceFactor: FiniteNumberSchema.min(0.1).max(10),
}) satisfies z.ZodType<MarketDemand>;

export const MarketSchema = z.strictObject({
  id: MarketIdSchema,
  name: NameSchema,
  city: CityIdSchema,
  demand: z.array(MarketDemandSchema),
}) satisfies z.ZodType<Market>;

export const PricingTunablesSchema = z.strictObject({
  alpha: OpenUnitSchema,
  beta: OpenUnitSchema,
  kappa: KappaSchema,
  maxCapture: FiniteNumberSchema.min(1).max(3),
}) satisfies z.ZodType<PricingTunables>;

export const MacroTunablesSchema = z.strictObject({
  inflationAnnual: FiniteNumberSchema.min(-0.5).max(1),
  policyRate: FiniteNumberSchema.min(0).max(1),
  demandIndex: FiniteNumberSchema.gt(0).max(10),
}) satisfies z.ZodType<MacroTunables>;

export const CommoditySourceSchema = z.strictObject({
  product: ProductIdSchema,
  referenceDailyVolume: PositiveQuantitySchema,
  alpha: OpenUnitSchema,
  kappa: KappaSchema,
}) satisfies z.ZodType<CommoditySource>;

export const SpreadTierSchema = z.strictObject({
  maxLeverage: FiniteNumberSchema.gt(0),
  spread: FiniteNumberSchema.min(0),
}) satisfies z.ZodType<SpreadTier>;

/** Single-bank rules (tiers strictly ascending, `minTermMonths <= maxTermMonths`) live here. */
export const BankSchema = z
  .strictObject({
    id: BankIdSchema,
    name: NameSchema,
    spreadTiers: z.array(SpreadTierSchema).min(1),
    minEquity: MoneySchema,
    minTermMonths: TermMonthsSchema,
    maxTermMonths: TermMonthsSchema,
    minPrincipal: PositiveMoneySchema,
    maxPrincipalToEquity: FiniteNumberSchema.gt(0),
    latePenaltySpread: FiniteNumberSchema.min(0),
    defaultAfterMissed: z.int().min(1),
    overdraftLimit: NonNegativeMoneySchema,
    overdraftAnnualRate: FiniteNumberSchema.min(0).max(1),
  })
  .superRefine((bank, ctx) => {
    for (let i = 1; i < bank.spreadTiers.length; i++) {
      const prev = bank.spreadTiers[i - 1];
      const tier = bank.spreadTiers[i];
      if (prev !== undefined && tier !== undefined && tier.maxLeverage <= prev.maxLeverage) {
        ctx.addIssue({
          code: 'custom',
          path: ['spreadTiers', i, 'maxLeverage'],
          message: 'spreadTiers must have strictly ascending maxLeverage',
        });
      }
    }
    if (bank.minTermMonths > bank.maxTermMonths) {
      ctx.addIssue({
        code: 'custom',
        path: ['minTermMonths'],
        message: `minTermMonths ${bank.minTermMonths} exceeds maxTermMonths ${bank.maxTermMonths}`,
      });
    }
  }) satisfies z.ZodType<Bank>;

export const EconomyContentSchema = z.strictObject({
  pricing: PricingTunablesSchema,
  macro: MacroTunablesSchema,
  commodities: z.record(ProductIdSchema, CommoditySourceSchema),
}) satisfies z.ZodType<EconomyContent>;

export const FinanceContentSchema = z.strictObject({
  banks: z.record(BankIdSchema, BankSchema),
}) satisfies z.ZodType<FinanceContent>;

// ---------------------------------------------------------------------------------------------
// ContentPack: keys and cross-references
// ---------------------------------------------------------------------------------------------

/** Keyed-by-id and cross-reference rules (docs/design/schema-m1.md section 3). */
function checkContentPack(pack: ContentPack, ctx: z.RefinementCtx): void {
  const byId = (item: { id: string }): string => item.id;
  checkKeyedBy(pack.products, 'id', byId, ['products'], ctx);
  checkKeyedBy(pack.recipes, 'id', byId, ['recipes'], ctx);
  checkKeyedBy(pack.facilityTypes, 'id', byId, ['facilityTypes'], ctx);
  checkKeyedBy(pack.storeFormats, 'id', byId, ['storeFormats'], ctx);
  checkKeyedBy(pack.regions, 'id', byId, ['regions'], ctx);
  checkKeyedBy(pack.cities, 'id', byId, ['cities'], ctx);
  checkKeyedBy(pack.markets, 'id', byId, ['markets'], ctx);
  checkKeyedBy(pack.finance.banks, 'id', byId, ['finance', 'banks'], ctx);
  checkKeyedBy(
    pack.economy.commodities,
    'product',
    (s) => s.product,
    ['economy', 'commodities'],
    ctx,
  );

  const issue = (path: PropertyKey[], message: string): void => {
    ctx.addIssue({ code: 'custom', path, message });
  };
  const product = (id: ProductId): Product | undefined => pack.products[id];

  for (const key of Object.keys(pack.recipes).sort()) {
    const recipe = pack.recipes[key as RecipeId];
    if (recipe === undefined) continue;
    if (pack.facilityTypes[recipe.facilityType] === undefined) {
      issue(['recipes', key, 'facilityType'], `unknown facility type '${recipe.facilityType}'`);
    }
    for (const side of ['inputs', 'outputs'] as const) {
      recipe[side].forEach((line, i) => {
        if (product(line.product) === undefined) {
          issue(['recipes', key, side, i, 'product'], `unknown product '${line.product}'`);
        }
      });
    }
  }

  for (const key of Object.keys(pack.cities).sort()) {
    const city = pack.cities[key as CityId];
    if (city !== undefined && pack.regions[city.region] === undefined) {
      issue(['cities', key, 'region'], `unknown region '${city.region}'`);
    }
  }

  const marketOfCity: Partial<Record<string, string>> = {};
  for (const key of Object.keys(pack.markets).sort()) {
    const market = pack.markets[key as MarketId];
    if (market === undefined) continue;
    if (pack.cities[market.city] === undefined) {
      issue(['markets', key, 'city'], `unknown city '${market.city}'`);
    }
    const first = marketOfCity[market.city];
    if (first !== undefined) {
      issue(['markets', key, 'city'], `city '${market.city}' already has market '${first}'`);
    } else {
      marketOfCity[market.city] = key;
    }
    const seen: Partial<Record<string, true>> = {};
    market.demand.forEach((d, i) => {
      const path = ['markets', key, 'demand', i, 'product'];
      const p = product(d.product);
      if (p === undefined) issue(path, `unknown product '${d.product}'`);
      else if (p.category === 'raw')
        issue(path, `raw product '${d.product}' has no consumer demand`);
      if (seen[d.product] === true) issue(path, `duplicate demand for product '${d.product}'`);
      seen[d.product] = true;
    });
  }

  for (const key of Object.keys(pack.economy.commodities).sort()) {
    const source = pack.economy.commodities[key as ProductId];
    if (source === undefined) continue;
    const p = product(source.product);
    const path = ['economy', 'commodities', key, 'product'];
    if (p === undefined) issue(path, `unknown product '${source.product}'`);
    else if (p.category !== 'raw') issue(path, `commodity product '${source.product}' is not raw`);
  }

  for (const key of Object.keys(pack.products).sort()) {
    const p = pack.products[key as ProductId];
    if (p?.category === 'raw' && pack.economy.commodities[p.id] === undefined) {
      issue(['products', key], `raw product '${key}' has no commodity source`);
    }
  }
}

export const ContentPackSchema = z
  .strictObject({
    products: z.record(ProductIdSchema, ProductSchema),
    recipes: z.record(RecipeIdSchema, RecipeSchema),
    facilityTypes: z.record(FacilityTypeIdSchema, FacilityTypeSchema),
    storeFormats: z.record(StoreFormatIdSchema, StoreFormatSchema),
    regions: z.record(RegionIdSchema, RegionSchema),
    cities: z.record(CityIdSchema, CitySchema),
    markets: z.record(MarketIdSchema, MarketSchema),
    economy: EconomyContentSchema,
    finance: FinanceContentSchema,
  })
  .superRefine(checkContentPack) satisfies z.ZodType<ContentPack>;

// ---------------------------------------------------------------------------------------------
// Assembly from data/ files
// ---------------------------------------------------------------------------------------------

/**
 * Raw parsed JSON of each `data/` file, as authored: arrays for the id-keyed files
 * (`products.json`, ..., `economy/commodities.json`, `finance/banks.json`), objects for
 * `economy/pricing.json` and `economy/macro.json`.
 */
export interface ContentFiles {
  products: unknown;
  recipes: unknown;
  facilityTypes: unknown;
  storeFormats: unknown;
  regions: unknown;
  cities: unknown;
  markets: unknown;
  pricing: unknown;
  macro: unknown;
  commodities: unknown;
  banks: unknown;
}

export interface ContentValidationError {
  /**
   * `invalid_shape`: a file failed its item validator (single-item rules included);
   * `duplicate_id`: two items of one file share an id (commodities: a product);
   * `cross_reference`: a `ContentPackSchema` cross-reference rule failed.
   */
  code: 'invalid_shape' | 'duplicate_id' | 'cross_reference';
  /** `path: message` strings; paths start with the `ContentFiles` / `ContentPack` key. */
  issues: string[];
}

function parseFile<T>(
  name: keyof ContentFiles,
  schema: z.ZodType<T>,
  raw: unknown,
  issues: string[],
): T | undefined {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  for (const message of formatSchemaIssues(parsed.error)) issues.push(`${name}.${message}`);
  return undefined;
}

/** Keys `items` by `idOf` in ascending id order; records duplicates in `issues`. */
function keyBy<T>(
  name: keyof ContentFiles,
  items: readonly T[],
  idOf: (item: T) => string,
  issues: string[],
): Record<string, T> {
  const firstIndex: Partial<Record<string, number>> = {};
  items.forEach((item, i) => {
    const id = idOf(item);
    const first = firstIndex[id];
    if (first === undefined) firstIndex[id] = i;
    else issues.push(`${name}.${i}: duplicate id '${id}' (first at index ${first})`);
  });
  const record: Record<string, T> = {};
  for (const id of Object.keys(firstIndex).sort()) {
    const index = firstIndex[id];
    const item = index === undefined ? undefined : items[index];
    if (item !== undefined) record[id] = item;
  }
  return record;
}

/**
 * Builds and validates a `ContentPack` from the parsed `data/` files (ADR-010). Pure. Stages, each
 * reported only if every earlier stage passed: shape of every file (`invalid_shape`, all files
 * checked), duplicate ids within a file (`duplicate_id`), then `ContentPackSchema` cross-references
 * (`cross_reference`).
 */
export function assembleContentPack(
  files: ContentFiles,
): Result<ContentPack, ContentValidationError> {
  const shape: string[] = [];
  const products = parseFile('products', z.array(ProductSchema), files.products, shape);
  const recipes = parseFile('recipes', z.array(RecipeSchema), files.recipes, shape);
  const facilityTypes = parseFile(
    'facilityTypes',
    z.array(FacilityTypeSchema),
    files.facilityTypes,
    shape,
  );
  const storeFormats = parseFile(
    'storeFormats',
    z.array(StoreFormatSchema),
    files.storeFormats,
    shape,
  );
  const regions = parseFile('regions', z.array(RegionSchema), files.regions, shape);
  const cities = parseFile('cities', z.array(CitySchema), files.cities, shape);
  const markets = parseFile('markets', z.array(MarketSchema), files.markets, shape);
  const pricing = parseFile('pricing', PricingTunablesSchema, files.pricing, shape);
  const macro = parseFile('macro', MacroTunablesSchema, files.macro, shape);
  const commodities = parseFile(
    'commodities',
    z.array(CommoditySourceSchema),
    files.commodities,
    shape,
  );
  const banks = parseFile('banks', z.array(BankSchema), files.banks, shape);
  if (
    shape.length > 0 ||
    products === undefined ||
    recipes === undefined ||
    facilityTypes === undefined ||
    storeFormats === undefined ||
    regions === undefined ||
    cities === undefined ||
    markets === undefined ||
    pricing === undefined ||
    macro === undefined ||
    commodities === undefined ||
    banks === undefined
  ) {
    return err({ code: 'invalid_shape', issues: shape });
  }

  const dup: string[] = [];
  const byId = (item: { id: string }): string => item.id;
  const pack: ContentPack = {
    products: keyBy('products', products, byId, dup),
    recipes: keyBy('recipes', recipes, byId, dup),
    facilityTypes: keyBy('facilityTypes', facilityTypes, byId, dup),
    storeFormats: keyBy('storeFormats', storeFormats, byId, dup),
    regions: keyBy('regions', regions, byId, dup),
    cities: keyBy('cities', cities, byId, dup),
    markets: keyBy('markets', markets, byId, dup),
    economy: {
      pricing,
      macro,
      commodities: keyBy('commodities', commodities, (s) => s.product, dup),
    },
    finance: { banks: keyBy('banks', banks, byId, dup) },
  };
  if (dup.length > 0) return err({ code: 'duplicate_id', issues: dup });

  const parsed = ContentPackSchema.safeParse(pack);
  if (!parsed.success) {
    return err({ code: 'cross_reference', issues: formatSchemaIssues(parsed.error) });
  }
  return ok(parsed.data);
}
