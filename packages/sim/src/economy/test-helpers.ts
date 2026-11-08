/**
 * Test-only helpers for the economy tests. Not exported from the barrel.
 *
 * The scripted stand-ins play the parts of retail (sells into the market in `market`) and
 * manufacturing (buys raw material in `production`) through the real `EconomyApi`, the way the real
 * systems will. They use the real slice ids with the schema's `EMPTY_*` slices so a world composed
 * of `[accountingSystem, economySystem, ...stand-ins]` satisfies the strict `WorldStateSchema` and
 * survives snapshot/restore even before the engine installs the typed slices itself.
 */
import { canonicalJson, type System, type TickContext } from '../engine/index.js';
import {
  EMPTY_FINANCE_STATE,
  EMPTY_MANUFACTURING_STATE,
  EMPTY_RETAIL_STATE,
  M1_CONTENT_PACK,
  VERTICAL_SLICE_SCENARIO,
  companyId,
  marketId,
  productId,
  quantity,
  storeId,
  type CompanyId,
  type FinanceState,
  type ManufacturingState,
  type Money,
  type ProductId,
  type Quantity,
  type RetailState,
  type Scenario,
} from '../schema/index.js';
import {
  ECONOMY_SERVICE,
  type EconomyApi,
  type MarketClearing,
  type MarketOffer,
} from './service.js';

export const PLAYER: CompanyId = companyId('co_000001');
export const BREAD: ProductId = productId('bread');
export const GRAIN: ProductId = productId('grain');
export const MARKET = marketId('springfield_market');
export const STORE = storeId('st_000001');

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`M1_CONTENT_PACK lacks ${what}`);
  return value;
}

/** `M1_CONTENT_PACK` numbers the tests rely on. */
export const PRICING = M1_CONTENT_PACK.economy.pricing;
export const BREAD_BASE_PRICE: Money = must(M1_CONTENT_PACK.products[BREAD], 'bread').basePrice;
export const BREAD_ELASTICITY: number = must(M1_CONTENT_PACK.products[BREAD], 'bread').elasticity;
export const BREAD_DEMAND: Quantity = must(
  must(M1_CONTENT_PACK.markets[MARKET], 'market').demand[0],
  'bread demand',
).baseDailyDemand;
export const GRAIN_BASE_PRICE: Money = must(M1_CONTENT_PACK.products[GRAIN], 'grain').basePrice;
export const GRAIN_SOURCE = must(M1_CONTENT_PACK.economy.commodities[GRAIN], 'grain source');

export const SCENARIO: Scenario = VERTICAL_SLICE_SCENARIO;

function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function offer(price: Money, qty: number, product: ProductId = BREAD): MarketOffer {
  return {
    sellerId: PLAYER,
    storeId: STORE,
    productId: product,
    price,
    quantity: quantity(qty),
    quality: 0,
    brand: 0,
  };
}

/** What a scripted retail stand-in does each tick; `null` means "do not go to market today". */
export type RetailScript = (
  tick: number,
  api: EconomyApi,
  ctx: TickContext<RetailState>,
) => readonly MarketOffer[] | null;

export interface RetailLog {
  clearings: { tick: number; clearing: MarketClearing }[];
}

/** Retail stand-in: calls `clearConsumerMarket(MARKET, BREAD, offers)` once per tick in `market`. */
export function scriptedRetail(
  script: RetailScript,
  log: RetailLog = { clearings: [] },
): System<RetailState> & { log: RetailLog } {
  return {
    id: 'retail',
    handles: [],
    init: () => copy(EMPTY_RETAIL_STATE),
    phases: {
      market(ctx) {
        const api = ctx.services.get(ECONOMY_SERVICE);
        const offers = script(ctx.tick, api, ctx);
        if (offers === null) return;
        log.clearings.push({
          tick: ctx.tick,
          clearing: api.clearConsumerMarket(MARKET, BREAD, offers),
        });
      },
    },
    log,
  };
}

export interface PurchaseLog {
  purchases: { tick: number; unitPrice: Money; total: Money }[];
}

/** Manufacturing stand-in: buys `buy(tick)` units of grain in `production` (0 = none). */
export function scriptedManufacturing(
  buy: (tick: number) => number,
  log: PurchaseLog = { purchases: [] },
): System<ManufacturingState> & { log: PurchaseLog } {
  return {
    id: 'manufacturing',
    handles: [],
    init: () => copy(EMPTY_MANUFACTURING_STATE),
    phases: {
      production(ctx) {
        const qty = buy(ctx.tick);
        if (qty <= 0) return;
        const api = ctx.services.get(ECONOMY_SERVICE);
        const quote = api.buyRaw(PLAYER, GRAIN, quantity(qty));
        log.purchases.push({ tick: ctx.tick, unitPrice: quote.unitPrice, total: quote.total });
      },
    },
    log,
  };
}

/** Finance stand-in: supplies the typed slice, does nothing. */
export const idleFinance: System<FinanceState> = {
  id: 'finance',
  handles: [],
  init: () => copy(EMPTY_FINANCE_STATE),
  phases: {},
};

/** Number of direction changes of a series, ignoring sub-1e-12 float noise. */
export function signChanges(series: readonly number[]): number {
  let changes = 0;
  let last = 0;
  for (let i = 1; i < series.length; i++) {
    const d = (series[i] ?? 0) - (series[i - 1] ?? 0);
    if (Math.abs(d) < 1e-12) continue;
    const sign = d > 0 ? 1 : -1;
    if (last !== 0 && sign !== last) changes += 1;
    last = sign;
  }
  return changes;
}

export function isMonotone(series: readonly number[], direction: 'up' | 'down'): boolean {
  for (let i = 1; i < series.length; i++) {
    const d = (series[i] ?? 0) - (series[i - 1] ?? 0);
    if (direction === 'up' ? d < 0 : d > 0) return false;
  }
  return true;
}
