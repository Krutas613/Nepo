/**
 * Branded identifier types (ARCHITECTURE.md section 3).
 *
 * Runtime entity IDs (`co_000001`, ...) are issued only by the engine registry. Authored IDs
 * (products, recipes, ...) come from `data/` files and are validated by the zod schemas below.
 *
 * zod convention for the whole schema module: branded values are validated with a plain zod
 * primitive plus a check and then `.transform()`-ed to the brand (never `.brand()`, whose type is
 * zod-specific and not assignable to our `Brand`). Parsing therefore yields correctly branded values.
 */
import { z } from 'zod';

declare const brand: unique symbol;

/** Nominal brand: `T` tagged with the literal `B`. Purely type-level; no runtime cost. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Like `Omit`, but distributes over union members (keeps discriminated unions discriminated). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------------------------------------------------------------------------------------------
// Runtime-issued entity IDs
// ---------------------------------------------------------------------------------------------

export type CompanyId = Brand<string, 'CompanyId'>;
export type FacilityId = Brand<string, 'FacilityId'>;
export type StoreId = Brand<string, 'StoreId'>;
export type WarehouseId = Brand<string, 'WarehouseId'>;
export type LoanId = Brand<string, 'LoanId'>;
export type ContractId = Brand<string, 'ContractId'>;
export type ShipmentId = Brand<string, 'ShipmentId'>;
export type JournalEntryId = Brand<string, 'JournalEntryId'>;

// ---------------------------------------------------------------------------------------------
// Authored IDs (slugs from data/): ^[a-z][a-z0-9_]*$
// ---------------------------------------------------------------------------------------------

export type ProductId = Brand<string, 'ProductId'>;
export type RecipeId = Brand<string, 'RecipeId'>;
export type RegionId = Brand<string, 'RegionId'>;
export type CityId = Brand<string, 'CityId'>;
export type MarketId = Brand<string, 'MarketId'>;
export type StoreFormatId = Brand<string, 'StoreFormatId'>;
/** Authored facility type (e.g. `steel_mill`); identifies a content `Facility` definition. */
export type FacilityTypeId = Brand<string, 'FacilityTypeId'>;

/** Four-digit chart-of-accounts code, e.g. `'1000'` (section 8). */
export type AccountCode = Brand<string, 'AccountCode'>;

// ---------------------------------------------------------------------------------------------
// Entity kinds and the registry format
// ---------------------------------------------------------------------------------------------

export type EntityKind =
  | 'company'
  | 'facility'
  | 'store'
  | 'warehouse'
  | 'loan'
  | 'contract'
  | 'shipment'
  | 'journalEntry';

/** All entity kinds, in a fixed documented order. */
export const ENTITY_KINDS: readonly EntityKind[] = [
  'company',
  'facility',
  'store',
  'warehouse',
  'loan',
  'contract',
  'shipment',
  'journalEntry',
];

/** Registry prefix per kind: an issued ID is `${ID_PREFIX[kind]}_${String(n).padStart(6, '0')}`. */
export const ID_PREFIX: Readonly<Record<EntityKind, string>> = {
  company: 'co',
  facility: 'fa',
  store: 'st',
  warehouse: 'wh',
  loan: 'ln',
  contract: 'ct',
  shipment: 'sh',
  journalEntry: 'je',
};

/** Maps each entity kind to its ID brand. */
export interface EntityIdMap {
  company: CompanyId;
  facility: FacilityId;
  store: StoreId;
  warehouse: WarehouseId;
  loan: LoanId;
  contract: ContractId;
  shipment: ShipmentId;
  journalEntry: JournalEntryId;
}

export type IdOf<K extends EntityKind> = EntityIdMap[K];

// ---------------------------------------------------------------------------------------------
// Unchecked cast helpers. They do NOT validate; use the zod schemas for untrusted input.
// Intended for tests, fixtures and the engine registry (which formats IDs itself).
// ---------------------------------------------------------------------------------------------

export const companyId = (s: string): CompanyId => s as CompanyId;
export const facilityId = (s: string): FacilityId => s as FacilityId;
export const storeId = (s: string): StoreId => s as StoreId;
export const warehouseId = (s: string): WarehouseId => s as WarehouseId;
export const loanId = (s: string): LoanId => s as LoanId;
export const contractId = (s: string): ContractId => s as ContractId;
export const shipmentId = (s: string): ShipmentId => s as ShipmentId;
export const journalEntryId = (s: string): JournalEntryId => s as JournalEntryId;
export const productId = (s: string): ProductId => s as ProductId;
export const recipeId = (s: string): RecipeId => s as RecipeId;
export const regionId = (s: string): RegionId => s as RegionId;
export const cityId = (s: string): CityId => s as CityId;
export const marketId = (s: string): MarketId => s as MarketId;
export const storeFormatId = (s: string): StoreFormatId => s as StoreFormatId;
export const facilityTypeId = (s: string): FacilityTypeId => s as FacilityTypeId;
export const accountCode = (s: string): AccountCode => s as AccountCode;

// ---------------------------------------------------------------------------------------------
// Patterns and zod validators
// ---------------------------------------------------------------------------------------------

/** Authored slug pattern for content IDs. */
export const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Account code pattern: exactly four ASCII digits. */
export const ACCOUNT_CODE_PATTERN = /^[0-9]{4}$/;

/** Pattern for a registry-issued ID of `kind`: prefix, underscore, at least six digits. */
export function entityIdPattern(kind: EntityKind): RegExp {
  return new RegExp(`^${ID_PREFIX[kind]}_[0-9]{6,}$`);
}

function entityIdSchema<K extends EntityKind>(kind: K): z.ZodType<IdOf<K>, string> {
  return z
    .string()
    .regex(entityIdPattern(kind), `expected a ${kind} id like ${ID_PREFIX[kind]}_000001`)
    .transform((s) => s as IdOf<K>);
}

function slugSchema<T extends string>(): z.ZodType<T, string> {
  return z
    .string()
    .regex(SLUG_PATTERN, 'expected a lowercase slug matching ^[a-z][a-z0-9_]*$')
    .transform((s) => s as T);
}

export const CompanyIdSchema = entityIdSchema('company');
export const FacilityIdSchema = entityIdSchema('facility');
export const StoreIdSchema = entityIdSchema('store');
export const WarehouseIdSchema = entityIdSchema('warehouse');
export const LoanIdSchema = entityIdSchema('loan');
export const ContractIdSchema = entityIdSchema('contract');
export const ShipmentIdSchema = entityIdSchema('shipment');
export const JournalEntryIdSchema = entityIdSchema('journalEntry');

export const ProductIdSchema = slugSchema<ProductId>();
export const RecipeIdSchema = slugSchema<RecipeId>();
export const RegionIdSchema = slugSchema<RegionId>();
export const CityIdSchema = slugSchema<CityId>();
export const MarketIdSchema = slugSchema<MarketId>();
export const StoreFormatIdSchema = slugSchema<StoreFormatId>();
export const FacilityTypeIdSchema = slugSchema<FacilityTypeId>();

export const AccountCodeSchema: z.ZodType<AccountCode, string> = z
  .string()
  .regex(ACCOUNT_CODE_PATTERN, 'expected a four-digit account code')
  .transform((s) => s as AccountCode);

export const EntityKindSchema = z.enum([
  'company',
  'facility',
  'store',
  'warehouse',
  'loan',
  'contract',
  'shipment',
  'journalEntry',
]) satisfies z.ZodType<EntityKind>;
