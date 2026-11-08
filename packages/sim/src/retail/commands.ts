/**
 * Pure validation of the three retail commands (retail.md section 4). Each validator takes the facts
 * the system looked up (content, ownership, cash, facility) and returns the first rejection in the
 * documented order, or the resolved values. No state, no services.
 */
import { SPEND_CLASS, canSpend } from '../accounting/index.js';
import type { DeepReadonly } from '../engine/index.js';
import {
  err,
  ok,
  type City,
  type CompanyId,
  type Facility,
  type FacilityId,
  type MarketId,
  type Money,
  type Product,
  type Quantity,
  type Result,
  type Store,
} from '../schema/index.js';
import type { ReadonlyStoreFormat } from './store.js';

export type RetailRejectionCode =
  | 'not_owner'
  | 'unknown_store_format'
  | 'unknown_city'
  | 'no_market'
  | 'insufficient_cash'
  | 'unknown_store'
  | 'unknown_product'
  | 'category_not_allowed'
  | 'invalid_price'
  | 'unknown_facility'
  | 'facility_not_owner'
  | 'not_same_city'
  | 'target_exceeds_capacity';

export interface Rejection {
  code: RetailRejectionCode;
  message: string;
}

function reject(code: RetailRejectionCode, message: string): Result<never, Rejection> {
  return err({ code, message });
}

// ---------------------------------------------------------------------------------------------
// store.build
// ---------------------------------------------------------------------------------------------

export interface BuildFacts {
  issuer: CompanyId;
  companyId: CompanyId;
  /** `content.storeFormats[storeFormatId]`. */
  format: ReadonlyStoreFormat | undefined;
  /** `content.cities[cityId]`. */
  city: DeepReadonly<City> | undefined;
  /** `economy.marketOfCity(cityId)`; evaluated only when the city exists. */
  marketId: MarketId | null;
  cash: Money;
}

export interface BuildPlan {
  format: ReadonlyStoreFormat;
  marketId: MarketId;
}

/** Rejections in order: `not_owner`, `unknown_store_format`, `unknown_city`, `no_market`, `insufficient_cash`. */
export function validateBuild(facts: BuildFacts): Result<BuildPlan, Rejection> {
  if (facts.companyId !== facts.issuer) {
    return reject('not_owner', `${facts.issuer} cannot build for ${facts.companyId}`);
  }
  if (facts.format === undefined) return reject('unknown_store_format', 'no such store format');
  if (facts.city === undefined) return reject('unknown_city', 'no such city');
  if (facts.marketId === null) return reject('no_market', `${facts.city.id} has no market`);
  if (!canSpend(SPEND_CLASS.capex, facts.cash, facts.format.buildCost)) {
    return reject(
      'insufficient_cash',
      `build cost ${facts.format.buildCost} exceeds cash ${facts.cash}`,
    );
  }
  return ok({ format: facts.format, marketId: facts.marketId });
}

// ---------------------------------------------------------------------------------------------
// store.set_price / store.set_restock_policy
// ---------------------------------------------------------------------------------------------

export interface StoreProductFacts {
  issuer: CompanyId;
  store: DeepReadonly<Store> | undefined;
  format: ReadonlyStoreFormat | undefined;
  product: DeepReadonly<Product> | undefined;
}

function checkStoreProduct(facts: StoreProductFacts): Result<ReadonlyStoreFormat, Rejection> {
  if (facts.store === undefined || facts.format === undefined) {
    return reject('unknown_store', 'no such store');
  }
  if (facts.store.ownerId !== facts.issuer) {
    return reject('not_owner', `${facts.issuer} does not own ${facts.store.id}`);
  }
  if (facts.product === undefined) return reject('unknown_product', 'no such product');
  if (!facts.format.categories.includes(facts.product.category)) {
    return reject(
      'category_not_allowed',
      `${facts.format.id} does not sell ${facts.product.category} goods`,
    );
  }
  return ok(facts.format);
}

/** Rejections in order: `unknown_store`, `not_owner`, `unknown_product`, `category_not_allowed`, `invalid_price`. */
export function validateSetPrice(
  facts: StoreProductFacts,
  price: Money | null,
): Result<null, Rejection> {
  const base = checkStoreProduct(facts);
  if (!base.ok) return base;
  if (price !== null && !(price >= 1)) {
    return reject('invalid_price', `price must be null or >= 1, got ${price}`);
  }
  return ok(null);
}

export interface RestockFacts extends StoreProductFacts {
  sourceFacilityId: FacilityId | null;
  /** `manufacturing.facility(sourceFacilityId)`; only consulted when `sourceFacilityId !== null`. */
  facility: DeepReadonly<Facility> | null;
  targetStock: Quantity;
}

/**
 * Rejections in order: `unknown_store`, `not_owner`, `unknown_product`, `category_not_allowed`,
 * `unknown_facility`, `facility_not_owner`, `not_same_city`, `target_exceeds_capacity`.
 */
export function validateSetRestockPolicy(facts: RestockFacts): Result<null, Rejection> {
  const base = checkStoreProduct(facts);
  if (!base.ok) return base;
  const format = base.value;
  if (facts.sourceFacilityId !== null) {
    const facility = facts.facility;
    if (facility === null) return reject('unknown_facility', `no facility ${facts.sourceFacilityId}`);
    if (facility.ownerId !== facts.issuer) {
      return reject('facility_not_owner', `${facility.id} belongs to ${facility.ownerId}`);
    }
    // `facts.store` is defined here (checkStoreProduct succeeded).
    if (facts.store !== undefined && facility.cityId !== facts.store.cityId) {
      return reject('not_same_city', `${facility.id} is not in ${facts.store.cityId}`);
    }
  }
  if (facts.targetStock > format.shelfCapacity) {
    return reject(
      'target_exceeds_capacity',
      `target ${facts.targetStock} exceeds shelf capacity ${format.shelfCapacity}`,
    );
  }
  return ok(null);
}
