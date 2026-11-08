/**
 * Read-only helpers for the UI (docs/design/player-flow.md): derived store and shelf views and a
 * what-if for a price. Pure; floats appear only in display fields (`unitCost`, `marginPct`), never
 * in anything the sim stores.
 */
import { allocateMoney } from '../accounting/index.js';
import type { DeepReadonly } from '../engine/index.js';
import {
  InvariantError,
  money,
  mulMoney,
  type FacilityId,
  type InventoryLot,
  type Money,
  type ProductId,
  type Quantity,
  type Store,
  type StoreStatus,
} from '../schema/index.js';
import type { ReadonlyStoreFormat } from './store.js';
import { effectivePrice, shelfUnits, shelfValue } from './store.js';

/** Carrying cost per unit on the shelf (display only); `null` when the shelf is empty. */
export function shelfUnitCost(lot: DeepReadonly<InventoryLot>): number | null {
  return lot.quantity > 0 ? lot.value / lot.quantity : null;
}

export interface ShelfLineSummary {
  productId: ProductId;
  stock: Quantity;
  /** Carrying value of the stock. */
  value: Money;
  unitCost: number | null;
  /** The line's own price, or `null` when it follows the reference price. */
  price: Money | null;
  /** What the line charges at `referencePrice` (its own price, else the reference). */
  effectivePrice: Money | null;
  sourceFacilityId: FacilityId | null;
  targetStock: Quantity;
  soldToday: Quantity;
  revenueToday: Money;
  unmetToday: Quantity;
  /** Demand was left over after this line sold out today. */
  stockout: boolean;
}

export interface StoreSummary {
  storeId: Store['id'];
  status: StoreStatus;
  /** Ticks until the store opens (0 once operating). */
  ticksToOpen: number;
  unitsOnShelves: number;
  shelfCapacity: number;
  /** Σ shelf lot values. */
  inventoryValue: Money;
  revenueToday: Money;
  lines: ShelfLineSummary[];
}

/**
 * Summarises a store for the UI. `referencePrices` maps products to today's reference price
 * (`EconomyApi.referencePrice`) so followers of the market show an effective price; omit for `null`.
 */
export function storeSummary(
  store: DeepReadonly<Store>,
  format: ReadonlyStoreFormat,
  tick: number,
  referencePrices: Readonly<Partial<Record<ProductId, Money>>> = {},
): StoreSummary {
  const lines: ShelfLineSummary[] = Object.keys(store.shelves)
    .sort()
    .map((key) => {
      const productId = key as ProductId;
      const line = store.shelves[productId];
      if (line === undefined) throw new InvariantError('retail.no_shelf_line', productId);
      const reference = referencePrices[productId];
      return {
        productId,
        stock: line.lot.quantity,
        value: line.lot.value,
        unitCost: shelfUnitCost(line.lot),
        price: line.price,
        effectivePrice: reference === undefined ? line.price : effectivePrice(line, reference),
        sourceFacilityId: line.restock.sourceFacilityId,
        targetStock: line.restock.targetStock,
        soldToday: line.soldToday,
        revenueToday: line.revenueToday,
        unmetToday: line.unmetToday,
        stockout: line.unmetToday > 0,
      };
    });
  return {
    storeId: store.id,
    status: store.status,
    ticksToOpen: store.status === 'operating' ? 0 : Math.max(0, store.completesTick - tick),
    unitsOnShelves: shelfUnits(store),
    shelfCapacity: format.shelfCapacity,
    inventoryValue: shelfValue(store),
    revenueToday: lines.reduce((sum, l) => money(sum + l.revenueToday), money(0)),
    lines,
  };
}

export interface StoreDayPreview {
  /** `min(stock, expectedCapture)`. */
  units: Quantity;
  revenue: Money;
  /** Carrying cost the sale would release (ADR-012 split). */
  cogs: Money;
  grossProfit: Money;
  /** Gross margin on revenue, percent; `null` when nothing sells. */
  marginPct: number | null;
  /** True when stock, not demand, limits the sale. */
  stockLimited: boolean;
}

/**
 * What-if for one shelf line at `price`: pass `EconomyApi.expectedCapture(market, product, price)` (or
 * the pure `expectedCaptureFor`) as `expectedCapture`. Exact for a lone store; with rivals the real
 * split depends on the clearing.
 */
export function storeDayPreview(
  lot: DeepReadonly<InventoryLot>,
  price: Money,
  expectedCapture: number,
): StoreDayPreview {
  const units = Math.max(0, Math.min(lot.quantity, expectedCapture)) as Quantity;
  const revenue = mulMoney(price, units);
  const cogs =
    units > 0 ? (allocateMoney(lot.value, [units, lot.quantity - units])[0] ?? money(0)) : money(0);
  const grossProfit = money(revenue - cogs);
  return {
    units,
    revenue,
    cogs,
    grossProfit,
    marginPct: revenue > 0 ? (grossProfit / revenue) * 100 : null,
    stockLimited: lot.quantity <= expectedCapture,
  };
}
