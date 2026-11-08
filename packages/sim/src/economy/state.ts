/**
 * Pure functions over the economy slice (docs/design/economy.md sections 3-5). The system and the
 * service are thin adapters around these; tests drive them directly.
 *
 * Content is read from the scenario's `ContentPack` (ADR-010) and never copied into the slice; the
 * slice stores authored ids only. All iteration is over `sortedKeys`; float sums over offers run in
 * array order (retail builds offers from `sortedKeys(stores)`). No RNG is used.
 */
import { scaleMoney } from '../accounting/index.js';
import { sortedKeys, type CalendarDate, type DeepReadonly } from '../engine/index.js';
import {
  InvariantError,
  mulMoney,
  quantity,
  type CityId,
  type CommodityState,
  type ContentPack,
  type EconomyState,
  type EventInput,
  type MacroState,
  type MarketDemand,
  type MarketId,
  type MarketState,
  type Money,
  type Product,
  type ProductId,
  type ProductMarketState,
  type Quantity,
} from '../schema/index.js';
import { clearOffers, type ClearingOffer } from './clearing.js';
import {
  captureFraction,
  imbalance,
  priceAtLevel,
  relaxLevel,
  updateImbalanceEma,
} from './pricing.js';

export type ReadonlyContent = DeepReadonly<ContentPack>;
export type ReadonlyEconomyState = DeepReadonly<EconomyState>;

/** What `init` and the `macro` phase need from the tick context. */
export interface EconomyEnv {
  readonly tick: number;
  emit(event: EventInput): void;
}

// -------------------------------------------------------------------------------------------------
// Lookups (InvariantError on unknown ids: callers pass authored ids that content has validated)
// -------------------------------------------------------------------------------------------------

export function productOf(content: ReadonlyContent, productId: ProductId): DeepReadonly<Product> {
  const product = content.products[productId];
  if (product === undefined) {
    throw new InvariantError('economy.unknown_product', `no product ${productId}`, { productId });
  }
  return product;
}

export function marketDemandOf(
  content: ReadonlyContent,
  marketId: MarketId,
  productId: ProductId,
): DeepReadonly<MarketDemand> {
  const market = content.markets[marketId];
  const demand = market?.demand.find((d) => d.product === productId);
  if (demand === undefined) {
    throw new InvariantError('economy.unknown_market', `no demand for ${productId} in ${marketId}`, {
      marketId,
      productId,
    });
  }
  return demand;
}

/** Throws `economy.unknown_market` when the market or the product in it is unknown. */
export function productMarketOf(
  state: EconomyState,
  marketId: MarketId,
  productId: ProductId,
): ProductMarketState;
export function productMarketOf(
  state: ReadonlyEconomyState,
  marketId: MarketId,
  productId: ProductId,
): DeepReadonly<ProductMarketState>;
export function productMarketOf(
  state: ReadonlyEconomyState,
  marketId: MarketId,
  productId: ProductId,
): DeepReadonly<ProductMarketState> {
  const pm = state.markets[marketId]?.products[productId];
  if (pm === undefined) {
    throw new InvariantError('economy.unknown_market', `no market ${marketId} / ${productId}`, {
      marketId,
      productId,
    });
  }
  return pm;
}

/** Throws `economy.unknown_commodity` when no commodity source exists for the product. */
export function commodityOf(state: EconomyState, productId: ProductId): CommodityState;
export function commodityOf(
  state: ReadonlyEconomyState,
  productId: ProductId,
): DeepReadonly<CommodityState>;
export function commodityOf(
  state: ReadonlyEconomyState,
  productId: ProductId,
): DeepReadonly<CommodityState> {
  const cs = state.commodities[productId];
  if (cs === undefined) {
    throw new InvariantError('economy.unknown_commodity', `no commodity source for ${productId}`, {
      productId,
    });
  }
  return cs;
}

// -------------------------------------------------------------------------------------------------
// Prices
// -------------------------------------------------------------------------------------------------

/** `scaleMoney(scaleMoney(basePrice, priceFactor), priceIndex)`: the inflation-adjusted anchor. */
export function anchorPrice(
  product: DeepReadonly<Product>,
  demand: DeepReadonly<MarketDemand>,
  macro: DeepReadonly<MacroState>,
): Money {
  return scaleMoney(scaleMoney(product.basePrice, demand.priceFactor), macro.priceIndex);
}

/** Barrel helper: the anchor for a (market, product) at the given macro state. */
export function anchorPriceOf(
  content: ReadonlyContent,
  macro: DeepReadonly<MacroState>,
  marketId: MarketId,
  productId: ProductId,
): Money {
  return anchorPrice(productOf(content, productId), marketDemandOf(content, marketId, productId), macro);
}

/** Today's baseline demand `floor(baseDailyDemand x demandIndex)`. */
export function baselineDemand(demand: DeepReadonly<MarketDemand>, demandIndex: number): Quantity {
  return quantity(Math.floor(demand.baseDailyDemand * demandIndex));
}

/** `floor(demandRemaining x g(price / referencePrice))`: preview of a single seller's capture. */
export function expectedCaptureFor(
  state: ReadonlyEconomyState,
  content: ReadonlyContent,
  marketId: MarketId,
  productId: ProductId,
  price: Money,
): Quantity {
  const pm = productMarketOf(state, marketId, productId);
  const g = captureFraction(
    price / pm.referencePrice,
    productOf(content, productId).elasticity,
    content.economy.pricing.maxCapture,
  );
  return quantity(Math.floor(pm.demandRemaining * g));
}

// -------------------------------------------------------------------------------------------------
// init
// -------------------------------------------------------------------------------------------------

/** Builds the tick-0 slice (economy.md section 3 `init`) and emits `market.opened` per market. */
export function createEconomyState(content: ReadonlyContent, env: EconomyEnv): EconomyState {
  const tunables = content.economy.macro;
  const macro: MacroState = {
    priceIndex: 1,
    policyRate: tunables.policyRate,
    demandIndex: tunables.demandIndex,
    lastMonthApplied: 0,
  };
  const markets: Record<MarketId, MarketState> = {};
  for (const marketId of sortedKeys(content.markets)) {
    const market = content.markets[marketId];
    if (market === undefined) continue;
    const city = content.cities[market.city];
    if (city === undefined) {
      throw new InvariantError('economy.unknown_city', `market ${marketId} in unknown city`, {
        marketId,
        cityId: market.city,
      });
    }
    const products: Record<ProductId, ProductMarketState> = {};
    for (const demand of market.demand) {
      const product = productOf(content, demand.product);
      const d0 = baselineDemand(demand, macro.demandIndex);
      products[demand.product] = {
        level: 1,
        imbalanceEma: 0,
        referencePrice: priceAtLevel(anchorPrice(product, demand, macro), 1),
        demandToday: d0,
        demandRemaining: d0,
        offeredToday: 0,
        soldToday: quantity(0),
        lastDemand: quantity(0),
        lastOffered: 0,
        lastSold: quantity(0),
      };
    }
    markets[marketId] = { id: marketId, city: market.city, region: city.region, products };
    env.emit({ type: 'market.opened', payload: { marketId, cityId: market.city } });
  }
  const commodities: Record<ProductId, CommodityState> = {};
  for (const productId of sortedKeys(content.economy.commodities)) {
    const product = productOf(content, productId);
    commodities[productId] = {
      level: 1,
      volumeEma: 0,
      unitPrice: priceAtLevel(scaleMoney(product.basePrice, macro.priceIndex), 1),
      purchasedToday: quantity(0),
      lastPurchased: quantity(0),
    };
  }
  return { macro, markets, commodities };
}

// -------------------------------------------------------------------------------------------------
// macro phase (economy.md section 4, in this order: 4.1 macro, 4.2 markets, 4.4 commodities)
// -------------------------------------------------------------------------------------------------

/** 4.1: monthly inflation step on month starts after tick 0; rate and demand index from content. */
export function applyMacro(
  state: EconomyState,
  content: ReadonlyContent,
  date: CalendarDate,
  env: EconomyEnv,
): void {
  const tunables = content.economy.macro;
  const macro = state.macro;
  if (date.isMonthStart && env.tick > 0) {
    macro.priceIndex = macro.priceIndex * (1 + tunables.inflationAnnual / 12);
    macro.lastMonthApplied = env.tick;
    env.emit({
      type: 'macro.month_applied',
      payload: { tick: env.tick, priceIndex: macro.priceIndex },
    });
  }
  macro.policyRate = tunables.policyRate;
  macro.demandIndex = tunables.demandIndex;
}

/** 4.2: relax one product market from yesterday's tallies, then close and reopen the day. */
export function advanceProductMarket(
  pm: ProductMarketState,
  product: DeepReadonly<Product>,
  demand: DeepReadonly<MarketDemand>,
  macro: DeepReadonly<MacroState>,
  pricing: DeepReadonly<ContentPack['economy']['pricing']>,
): void {
  const x = imbalance(pm.demandToday, pm.offeredToday);
  pm.imbalanceEma = updateImbalanceEma(pm.imbalanceEma, x, pricing.beta);
  pm.level = relaxLevel(pm.level, pm.imbalanceEma, pricing.alpha, pricing.kappa);
  pm.referencePrice = priceAtLevel(anchorPrice(product, demand, macro), pm.level);

  pm.lastDemand = pm.demandToday;
  pm.lastOffered = pm.offeredToday;
  pm.lastSold = pm.soldToday;
  const d = baselineDemand(demand, macro.demandIndex);
  pm.demandToday = d;
  pm.demandRemaining = d;
  pm.offeredToday = 0;
  pm.soldToday = quantity(0);
}

/** 4.4: relax one commodity from yesterday's purchased volume, then reset the tally. */
export function advanceCommodity(
  cs: CommodityState,
  product: DeepReadonly<Product>,
  source: DeepReadonly<ContentPack['economy']['commodities'][ProductId]>,
  macro: DeepReadonly<MacroState>,
  beta: number,
): void {
  const y = imbalance(cs.purchasedToday, source.referenceDailyVolume);
  cs.volumeEma = updateImbalanceEma(cs.volumeEma, y, beta);
  cs.level = relaxLevel(cs.level, cs.volumeEma, source.alpha, source.kappa);
  cs.unitPrice = priceAtLevel(scaleMoney(product.basePrice, macro.priceIndex), cs.level);
  cs.lastPurchased = cs.purchasedToday;
  cs.purchasedToday = quantity(0);
}

/** The whole `macro` phase for one tick. */
export function advanceDay(
  state: EconomyState,
  content: ReadonlyContent,
  date: CalendarDate,
  env: EconomyEnv,
): void {
  applyMacro(state, content, date, env);
  const pricing = content.economy.pricing;
  for (const marketId of sortedKeys(state.markets)) {
    const market = state.markets[marketId];
    if (market === undefined) continue;
    for (const productId of sortedKeys(market.products)) {
      const pm = market.products[productId];
      if (pm === undefined) continue;
      advanceProductMarket(
        pm,
        productOf(content, productId),
        marketDemandOf(content, marketId, productId),
        state.macro,
        pricing,
      );
    }
  }
  for (const productId of sortedKeys(state.commodities)) {
    const cs = state.commodities[productId];
    const source = content.economy.commodities[productId];
    if (cs === undefined) continue;
    if (source === undefined) {
      throw new InvariantError('economy.unknown_commodity', `no source for ${productId}`, {
        productId,
      });
    }
    advanceCommodity(cs, productOf(content, productId), source, state.macro, pricing.beta);
  }
}

// -------------------------------------------------------------------------------------------------
// Service writes (economy.md section 5)
// -------------------------------------------------------------------------------------------------

export interface ConsumerClearing {
  sold: readonly Quantity[];
  referencePrice: Money;
  demandBefore: Quantity;
  demandAfter: Quantity;
}

/**
 * `clearConsumerMarket` steps 1-4 against the slice: clears `offers` (array order) against the
 * remaining demand, adds to today's tallies and decrements `demandRemaining`. No events.
 */
export function clearConsumerMarketIn(
  state: EconomyState,
  content: ReadonlyContent,
  marketId: MarketId,
  productId: ProductId,
  offers: readonly (ClearingOffer & { readonly productId: ProductId })[],
): ConsumerClearing {
  const pm = productMarketOf(state, marketId, productId);
  offers.forEach((offer, i) => {
    if (offer.productId !== productId) {
      throw new InvariantError('economy.offer_product_mismatch', `offer ${i} is for another product`, {
        marketId,
        productId,
        offerProductId: offer.productId,
      });
    }
  });
  const demandBefore = pm.demandRemaining;
  const result = clearOffers(
    {
      demand: demandBefore,
      referencePrice: pm.referencePrice,
      elasticity: productOf(content, productId).elasticity,
      maxCapture: content.economy.pricing.maxCapture,
    },
    offers,
  );
  pm.offeredToday += result.effectiveSupply;
  pm.soldToday = quantity(pm.soldToday + result.totalSold);
  pm.demandRemaining = quantity(Math.max(0, demandBefore - result.totalSold));
  return {
    sold: result.sold,
    referencePrice: pm.referencePrice,
    demandBefore,
    demandAfter: pm.demandRemaining,
  };
}

export interface RawQuoteFor {
  productId: ProductId;
  quantity: Quantity;
  unitPrice: Money;
  total: Money;
}

/** Today's commodity quote: `total = mulMoney(unitPrice, quantity)`. Read-only. */
export function quoteRawFrom(
  state: ReadonlyEconomyState,
  productId: ProductId,
  qty: Quantity,
): RawQuoteFor {
  const unitPrice = commodityOf(state, productId).unitPrice;
  return { productId, quantity: qty, unitPrice, total: mulMoney(unitPrice, qty) };
}

/** Records a purchase in today's volume tally and returns the quote. The caller posts the money. */
export function recordRawPurchase(
  state: EconomyState,
  productId: ProductId,
  qty: Quantity,
): RawQuoteFor {
  const cs = commodityOf(state, productId);
  const quote = quoteRawFrom(state, productId, qty);
  cs.purchasedToday = quantity(cs.purchasedToday + qty);
  return quote;
}

/** The market of a city, or `null` (reads state; content guarantees at most one per city). */
export function marketOfCityIn(state: ReadonlyEconomyState, cityId: CityId): MarketId | null {
  for (const marketId of sortedKeys(state.markets)) {
    if (state.markets[marketId]?.city === cityId) return marketId;
  }
  return null;
}
