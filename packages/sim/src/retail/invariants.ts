/**
 * Retail invariant checker for tests and sim-tests (docs/design/retail.md section 9). Read-only.
 *
 * `state` needs only the `retail` and `accounting` slices, so qa can pass `world.state`. Pass the
 * scenario `content` to enable the capacity checks (shelf capacity and depreciation are format data);
 * without it those checks are skipped.
 *
 * For qa (invariant 3, per entity, exact): `Σ shelf lot.value === balance(1230)`. This checker
 * reports it as `shelf.value_mismatch`; the PP&E check (item 4) combines manufacturing and retail
 * records and is qa's: use `Σ store.cost` / `Σ store.accumulatedDepreciation` per owner next to the
 * facilities' (`ppeOfStores`).
 */
import { ACCOUNTS, getBalance, hasEntity } from '../accounting/index.js';
import { sortedKeys, type DeepReadonly } from '../engine/index.js';
import {
  money,
  type AccountingState,
  type CompanyId,
  type ContentPack,
  type Money,
  type ProductId,
  type RetailState,
  type StoreId,
} from '../schema/index.js';
import { lotInvariantErrors } from './lots.js';

export type RetailInvariantCode =
  | 'lot.invalid'
  | 'shelf.exceeds_capacity'
  | 'shelf.price_invalid'
  | 'shelf.restock_target_exceeds_capacity'
  | 'shelf.shrunk_exceeds_issued'
  | 'shelf.sold_exceeds_received'
  | 'store.depreciation_out_of_range'
  | 'store.unknown_format'
  | 'store.owner_has_no_ledger'
  | 'shelf.value_mismatch';

export interface RetailInvariantViolation {
  code: RetailInvariantCode;
  storeId?: StoreId;
  productId?: ProductId;
  ownerId?: CompanyId;
  message: string;
}

export interface RetailInvariantState {
  readonly retail: DeepReadonly<RetailState>;
  readonly accounting: DeepReadonly<AccountingState>;
}

export function checkRetailInvariants(
  state: RetailInvariantState,
  content?: DeepReadonly<ContentPack>,
): RetailInvariantViolation[] {
  const out: RetailInvariantViolation[] = [];
  const valueByOwner = new Map<CompanyId, Money>();

  for (const storeId of sortedKeys(state.retail.stores)) {
    const store = state.retail.stores[storeId];
    if (store === undefined) continue;
    const format = content?.storeFormats[store.formatId];
    if (content !== undefined && format === undefined) {
      out.push({
        code: 'store.unknown_format',
        storeId,
        message: `${storeId} has unknown format ${store.formatId}`,
      });
    }

    let units = 0;
    let value = money(0);
    for (const productId of sortedKeys(store.shelves)) {
      const line = store.shelves[productId];
      if (line === undefined) continue;
      for (const problem of lotInvariantErrors(line.lot)) {
        out.push({ code: 'lot.invalid', storeId, productId, message: `${storeId}/${productId}: ${problem}` });
      }
      if (line.shrunk > line.lot.issued) {
        out.push({
          code: 'shelf.shrunk_exceeds_issued',
          storeId,
          productId,
          message: `shrunk ${line.shrunk} > issued ${line.lot.issued}`,
        });
      }
      if (line.soldToday > line.lot.received) {
        out.push({
          code: 'shelf.sold_exceeds_received',
          storeId,
          productId,
          message: `soldToday ${line.soldToday} > received ${line.lot.received}`,
        });
      }
      if (line.price !== null && !(Number.isSafeInteger(line.price) && line.price >= 1)) {
        out.push({
          code: 'shelf.price_invalid',
          storeId,
          productId,
          message: `price ${String(line.price)} is neither null nor an integer >= 1`,
        });
      }
      if (format !== undefined && line.restock.targetStock > format.shelfCapacity) {
        out.push({
          code: 'shelf.restock_target_exceeds_capacity',
          storeId,
          productId,
          message: `target ${line.restock.targetStock} > capacity ${format.shelfCapacity}`,
        });
      }
      units += line.lot.quantity;
      value = money(value + line.lot.value);
    }

    if (format !== undefined && units > format.shelfCapacity) {
      out.push({
        code: 'shelf.exceeds_capacity',
        storeId,
        message: `${units} units on shelves > capacity ${format.shelfCapacity}`,
      });
    }
    if (
      !(store.accumulatedDepreciation >= 0) ||
      store.accumulatedDepreciation > store.cost
    ) {
      out.push({
        code: 'store.depreciation_out_of_range',
        storeId,
        message: `accumulatedDepreciation ${store.accumulatedDepreciation} outside 0..${store.cost}`,
      });
    }
    valueByOwner.set(store.ownerId, money((valueByOwner.get(store.ownerId) ?? 0) + value));
  }

  // Per entity: Σ shelf lot values === balance(1230), for every ledger (including store-less ones).
  const owners = new Set<CompanyId>([
    ...valueByOwner.keys(),
    ...sortedKeys(state.accounting.entities),
  ]);
  for (const ownerId of [...owners].sort()) {
    if (!hasEntity(state.accounting, ownerId)) {
      out.push({
        code: 'store.owner_has_no_ledger',
        ownerId,
        message: `${ownerId} owns stores but has no ledger`,
      });
      continue;
    }
    const shelves = valueByOwner.get(ownerId) ?? money(0);
    const balance = getBalance(state.accounting, ownerId, ACCOUNTS.INVENTORY_MERCHANDISE);
    if (shelves !== balance) {
      out.push({
        code: 'shelf.value_mismatch',
        ownerId,
        message: `${ownerId}: Σ shelf value ${shelves} !== balance(1230) ${balance}`,
      });
    }
  }
  return out;
}

/** Σ `cost` and Σ `accumulatedDepreciation` of an owner's stores, for qa's combined PP&E check. */
export function ppeOfStores(
  state: { readonly retail: DeepReadonly<RetailState> },
  ownerId: CompanyId,
): { cost: Money; accumulatedDepreciation: Money } {
  let cost = money(0);
  let accumulated = money(0);
  for (const storeId of sortedKeys(state.retail.stores)) {
    const store = state.retail.stores[storeId];
    if (store === undefined || store.ownerId !== ownerId) continue;
    cost = money(cost + store.cost);
    accumulated = money(accumulated + store.accumulatedDepreciation);
  }
  return { cost, accumulatedDepreciation: accumulated };
}
