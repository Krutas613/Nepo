/**
 * Pure store logic (docs/design/retail.md sections 3-5): construction, shelf lines, restock sizing,
 * offers, sale settlement, shrinkage and depreciation over plain inputs. Nothing here touches the
 * engine, accounting or other systems; `system.ts` wires these functions to the services.
 */
import type { MarketOffer } from '../economy/index.js';
import type { DeepReadonly } from '../engine/index.js';
import {
  InvariantError,
  minMoney,
  mulMoney,
  money,
  quantity,
  addMoney,
  subMoney,
  type CityId,
  type CompanyId,
  type Money,
  type MarketId,
  type ProductId,
  type Quantity,
  type ShelfLine,
  type Store,
  type StoreFormat,
  type StoreId,
} from '../schema/index.js';
import { emptyLot, issueFrom } from './lots.js';

export type ReadonlyStoreFormat = DeepReadonly<StoreFormat>;

/** A shelf line with an empty lot, reference-following price and no restocking. */
export function newShelfLine(): ShelfLine {
  return {
    lot: emptyLot(),
    price: null,
    restock: { sourceFacilityId: null, targetStock: quantity(0) },
    soldToday: quantity(0),
    revenueToday: money(0),
    unmetToday: quantity(0),
    shrunk: quantity(0),
  };
}

export interface NewStoreInput {
  id: StoreId;
  ownerId: CompanyId;
  format: ReadonlyStoreFormat;
  cityId: CityId;
  marketId: MarketId;
  tick: number;
}

/** A store under construction: `completesTick = tick + constructionTicks`, `cost = buildCost`. */
export function createStore(input: NewStoreInput): Store {
  const { format } = input;
  return {
    id: input.id,
    ownerId: input.ownerId,
    formatId: format.id,
    cityId: input.cityId,
    marketId: input.marketId,
    status: 'under_construction',
    orderedTick: input.tick,
    completesTick: input.tick + format.constructionTicks,
    shelves: {},
    cost: format.buildCost,
    accumulatedDepreciation: money(0),
    brand: 0,
  };
}

/** Total units across all shelf lines of the store. */
export function shelfUnits(store: DeepReadonly<Store>): number {
  let total = 0;
  for (const line of Object.values(store.shelves)) total += line.lot.quantity;
  return total;
}

/** Total carrying value across all shelf lines of the store. */
export function shelfValue(store: DeepReadonly<Store>): Money {
  let total = money(0);
  for (const line of Object.values(store.shelves)) total = addMoney(total, line.lot.value);
  return total;
}

/** Free shelf space in units (never negative). */
export function freeCapacity(store: DeepReadonly<Store>, format: ReadonlyStoreFormat): number {
  return Math.max(0, format.shelfCapacity - shelfUnits(store));
}

/**
 * Units to pull for one shelf line (retail.md 5.3):
 * `min(targetStock - onShelf, freeCapacity, available)`, never negative.
 */
export function restockQuantity(
  targetStock: number,
  onShelf: number,
  freeShelfCapacity: number,
  available: number,
): Quantity {
  const room = Math.min(targetStock - onShelf, freeShelfCapacity);
  return quantity(Math.max(0, Math.min(room, available)));
}

/** Resets today's per-line results (retail.md 5.2). */
export function resetDay(line: ShelfLine): void {
  line.soldToday = quantity(0);
  line.revenueToday = money(0);
  line.unmetToday = quantity(0);
}

/** The price a line charges today: its own price, or the reference price when it follows the market. */
export function effectivePrice(line: DeepReadonly<ShelfLine>, referencePrice: Money): Money {
  return line.price ?? referencePrice;
}

/** The offer a line makes to the consumer market (M1: quality and brand are placeholders). */
export function buildOffer(
  store: DeepReadonly<Store>,
  productId: ProductId,
  referencePrice: Money,
): MarketOffer {
  const line = store.shelves[productId];
  if (line === undefined) {
    throw new InvariantError('retail.no_shelf_line', `${store.id} has no shelf line ${productId}`);
  }
  return {
    sellerId: store.ownerId,
    storeId: store.id,
    productId,
    price: effectivePrice(line, referencePrice),
    quantity: line.lot.quantity,
    quality: 0,
    brand: store.brand,
  };
}

export interface SaleSettlement {
  quantity: Quantity;
  revenue: Money;
  cogs: Money;
}

/**
 * Settles `sold` units of a line at `price`: `revenue = price x sold`, `cogs` = the carrying cost the
 * lot releases (ADR-012 split, so `Σ cogs + lot.value` is conserved), `soldToday`/`revenueToday`
 * updated. Throws `InvariantError('retail.issue_exceeds_stock')` if `sold` exceeds the stock.
 */
export function settleSale(line: ShelfLine, sold: Quantity, price: Money): SaleSettlement {
  const cogs = issueFrom(line.lot, sold);
  const revenue = mulMoney(price, sold);
  line.soldToday = quantity(line.soldToday + sold);
  line.revenueToday = addMoney(line.revenueToday, revenue);
  return { quantity: sold, revenue, cogs };
}

/**
 * Stockout signal (retail.md 5.4): the store sold everything it offered and demand was left over;
 * `demandAfter` is the group's remaining demand after the clearing.
 */
export function unmetDemand(offered: number, sold: number, demandAfter: number): Quantity {
  return quantity(offered === sold ? Math.max(0, demandAfter) : 0);
}

/** Units lost to shrinkage today: `floor(stock x perMille / 1000)`. */
export function shrinkageUnits(stock: number, perMille: number): Quantity {
  return quantity(Math.floor((stock * perMille) / 1000));
}

export interface ShrinkResult {
  lost: Quantity;
  cost: Money;
}

/** Writes off shrinkage from a line (retail.md 5.5). `cost` is the value the caller posts (6900). */
export function applyShrinkage(line: ShelfLine, perMille: number): ShrinkResult {
  const lost = shrinkageUnits(line.lot.quantity, perMille);
  if (lost < 1) return { lost: quantity(0), cost: money(0) };
  const cost = issueFrom(line.lot, lost);
  line.shrunk = quantity(line.shrunk + lost);
  return { lost, cost };
}

/**
 * Straight-line charge for this month end (ADR-009): `min(ceil(cost / usefulLifeMonths), cost -
 * accumulated)`, never negative. Rounding the monthly charge UP (in exact integer arithmetic)
 * guarantees the asset is fully depreciated within `usefulLifeMonths` charges and never over; the
 * facilities' round-to-nearest rule can leave a residue (e.g. 1000 over 12 months charges 83 x 12 =
 * 996).
 */
export function depreciationCharge(
  cost: Money,
  accumulated: Money,
  usefulLifeMonths: number,
): Money {
  const remaining = subMoney(cost, accumulated);
  if (remaining <= 0) return money(0);
  const wholeMonths = (cost - (cost % usefulLifeMonths)) / usefulLifeMonths;
  const perMonth = money(wholeMonths + (cost % usefulLifeMonths > 0 ? 1 : 0));
  return minMoney(perMonth, remaining);
}
