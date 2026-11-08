/**
 * Test-only helpers for the retail tests (not exported from the module barrel).
 */
import {
  M1_CONTENT_PACK,
  cityId,
  companyId,
  facilityId,
  marketId,
  money,
  productId,
  quantity,
  storeFormatId,
  storeId,
  type ShelfLine,
  type Store,
  type StoreFormat,
} from '../schema/index.js';
import { newShelfLine } from './store.js';

export const OWNER = companyId('co_000001');
export const OTHER = companyId('co_000002');
export const BREAD = productId('bread');
export const GRAIN = productId('grain');
export const SPRINGFIELD = cityId('springfield');
export const SPRINGFIELD_MARKET = marketId('springfield_market');
export const GROCERY = storeFormatId('grocery');
export const STORE_1 = storeId('st_000001');
export const FACILITY_1 = facilityId('fa_000001');

export const GROCERY_FORMAT: StoreFormat = {
  ...(M1_CONTENT_PACK.storeFormats[GROCERY] as StoreFormat),
  categories: ['consumer'],
};

/** An operating grocery store with a bread shelf line holding `stock` units worth `value`. */
export function makeStore(stock = 0, value = 0, overrides: Partial<Store> = {}): Store {
  const line: ShelfLine = newShelfLine();
  line.lot = {
    quantity: quantity(stock),
    value: money(value),
    received: quantity(stock),
    issued: quantity(0),
  };
  return {
    id: STORE_1,
    ownerId: OWNER,
    formatId: GROCERY,
    cityId: SPRINGFIELD,
    marketId: SPRINGFIELD_MARKET,
    status: 'operating',
    orderedTick: 0,
    completesTick: 0,
    shelves: { [BREAD]: line },
    cost: money(2_000_000),
    accumulatedDepreciation: money(0),
    brand: 0,
    ...overrides,
  };
}
