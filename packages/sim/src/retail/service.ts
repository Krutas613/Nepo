/**
 * `RetailApi` (docs/design/retail.md section 6, ADR-007), registered under `RETAIL_SERVICE`.
 *
 * Ownership rule (ARCHITECTURE.md section 6.2): `handle.slice()` is a mutation declaration, so only
 * `receive` calls it; every read goes through `handle.state().retail`.
 *
 * Content binding: `receive` needs the store format's shelf capacity, and `ServiceHandle` has no
 * scenario accessor. Like the economy service, the retail system binds the immutable content at the
 * start of every `apply` phase (which precedes `logistics` and `market` on every tick, on fresh and
 * restored worlds alike) through the internal `bindContent`. `receive` before the first `apply`
 * throws `InvariantError('retail.content_unbound')`.
 */
import {
  createServiceKey,
  sortedKeys,
  type DeepReadonly,
  type ServiceHandle,
  type ServiceKey,
} from '../engine/index.js';
import {
  InvariantError,
  err,
  ok,
  quantity,
  type CityId,
  type CompanyId,
  type ContentPack,
  type Money,
  type ProductId,
  type Quantity,
  type Result,
  type RetailState,
  type Store,
  type StoreId,
} from '../schema/index.js';
import { receiveInto } from './lots.js';
import { freeCapacity, type ReadonlyStoreFormat } from './store.js';

export type ReceiveErrorCode =
  'unknown_store' | 'no_shelf_line' | 'over_capacity' | 'not_operating';

export interface ReceiveError {
  code: ReceiveErrorCode;
  message: string;
}

export interface ReceiveSource {
  kind: 'facility' | 'shipment';
  id: string;
}

export interface RetailApi {
  /** The store, or `null`. */
  store(storeId: StoreId): DeepReadonly<Store> | null;
  /** Ids of the owner's stores (optionally in one city), ascending. */
  storesOf(ownerId: CompanyId, cityId?: CityId): readonly StoreId[];
  /** Units of `productId` on the store's shelf; 0 for an unknown store or product. */
  shelfQuantity(storeId: StoreId, productId: ProductId): Quantity;
  /**
   * Lands goods on a shelf (M2 logistics arrivals; M1 restock uses it too). The caller has already
   * posted the credit side; retail posts nothing. Returns the accepted quantity (all of it):
   * `over_capacity` is an error, never a partial accept.
   */
  receive(
    storeId: StoreId,
    productId: ProductId,
    quantity: Quantity,
    cost: Money,
    source: ReceiveSource,
  ): Result<Quantity, ReceiveError>;
}

/** Internal surface the retail system uses on its own service; not exported from the barrel. */
export interface RetailApiInternal extends RetailApi {
  bindContent(content: DeepReadonly<ContentPack>): void;
}

export const RETAIL_SERVICE: ServiceKey<RetailApi> = createServiceKey<RetailApi>('retail');

/**
 * Pure core of `receive`: validates in the documented order (`unknown_store`, `not_operating`,
 * `no_shelf_line`, `over_capacity`) and lands the goods on the shelf line. Mutates `state` only on `ok`.
 */
export function receiveGoods(
  state: RetailState,
  format: (store: Store) => ReadonlyStoreFormat,
  storeId: StoreId,
  productId: ProductId,
  qty: Quantity,
  cost: Money,
): Result<Quantity, ReceiveError> {
  const store = state.stores[storeId];
  if (store === undefined) return err({ code: 'unknown_store', message: `no store ${storeId}` });
  if (store.status !== 'operating') {
    return err({ code: 'not_operating', message: `${storeId} is ${store.status}` });
  }
  const line = store.shelves[productId];
  if (line === undefined) {
    return err({ code: 'no_shelf_line', message: `${storeId} has no shelf line for ${productId}` });
  }
  const free = freeCapacity(store, format(store));
  if (qty > free) {
    return err({
      code: 'over_capacity',
      message: `receiving ${qty} exceeds free shelf capacity ${free}`,
    });
  }
  receiveInto(line.lot, qty, cost);
  return ok(quantity(qty));
}

export function createRetailApi(handle: ServiceHandle<RetailState>): RetailApiInternal {
  let bound: DeepReadonly<ContentPack> | null = null;
  const view = (): DeepReadonly<RetailState> => handle.state().retail;
  const formatOf = (store: DeepReadonly<Store>): ReadonlyStoreFormat => {
    if (bound === null) {
      throw new InvariantError(
        'retail.content_unbound',
        'RetailApi.receive used before the first apply phase bound the scenario content',
      );
    }
    const format = bound.storeFormats[store.formatId];
    if (format === undefined) {
      throw new InvariantError('retail.unknown_format', `no store format ${store.formatId}`);
    }
    return format;
  };

  return {
    bindContent(content) {
      bound = content;
    },
    store(storeId) {
      return view().stores[storeId] ?? null;
    },
    storesOf(ownerId, cityId) {
      const stores = view().stores;
      return sortedKeys(stores).filter((id) => {
        const s = stores[id];
        return s?.ownerId === ownerId && (cityId === undefined || s.cityId === cityId);
      });
    },
    shelfQuantity(storeId, productId) {
      return view().stores[storeId]?.shelves[productId]?.lot.quantity ?? quantity(0);
    },
    receive(storeId, productId, qty, cost) {
      // Cheap read-only rejection first, so it does not declare a mutation.
      const store = view().stores[storeId];
      if (store === undefined)
        return err({ code: 'unknown_store', message: `no store ${storeId}` });
      formatOf(store);
      return receiveGoods(handle.slice(), (s) => formatOf(s), storeId, productId, qty, cost);
    },
  };
}
