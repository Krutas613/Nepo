/** Unit tests for the slice-level functions (economy.md sections 3-5) without the engine. */
import { describe, expect, it } from 'vitest';
import { calendarFromTick } from '../engine/index.js';
import {
  EMPTY_CONTENT_PACK,
  EMPTY_ECONOMY_STATE,
  M1_CONTENT_PACK,
  cityId,
  marketId,
  money,
  productId,
  quantity,
  type ContentPack,
  type EventInput,
} from '../schema/index.js';
import { checkEconomyInvariants } from './invariants.js';
import { priceAtLevel } from './pricing.js';
import {
  advanceDay,
  anchorPriceOf,
  applyMacro,
  clearConsumerMarketIn,
  createEconomyState,
  expectedCaptureFor,
  marketOfCityIn,
  productMarketOf,
  quoteRawFrom,
  recordRawPurchase,
  type EconomyEnv,
} from './state.js';
import {
  BREAD,
  BREAD_BASE_PRICE,
  BREAD_DEMAND,
  BREAD_ELASTICITY,
  GRAIN,
  GRAIN_BASE_PRICE,
  GRAIN_SOURCE,
  MARKET,
  PRICING,
  offer,
} from './test-helpers.js';

function env(tick = 0): EconomyEnv & { events: EventInput[] } {
  const events: EventInput[] = [];
  return {
    tick,
    events,
    emit: (e) => {
      events.push(e);
    },
  };
}

const SPRINGFIELD = cityId('springfield');

describe('createEconomyState', () => {
  it('builds one market per content market and one commodity per source, emitting market.opened', () => {
    const e = env();
    const state = createEconomyState(M1_CONTENT_PACK, e);
    expect(state.macro).toEqual({
      priceIndex: 1,
      policyRate: 0.04,
      demandIndex: 1,
      lastMonthApplied: 0,
    });
    expect(Object.keys(state.markets)).toEqual([MARKET]);
    const market = state.markets[MARKET]!;
    expect(market).toMatchObject({ id: MARKET, city: SPRINGFIELD, region: 'heartland' });
    expect(market.products[BREAD]).toEqual({
      level: 1,
      imbalanceEma: 0,
      referencePrice: BREAD_BASE_PRICE,
      demandToday: BREAD_DEMAND,
      demandRemaining: BREAD_DEMAND,
      offeredToday: 0,
      soldToday: 0,
      lastDemand: 0,
      lastOffered: 0,
      lastSold: 0,
    });
    expect(state.commodities[GRAIN]).toEqual({
      level: 1,
      volumeEma: 0,
      unitPrice: GRAIN_BASE_PRICE,
      purchasedToday: 0,
      lastPurchased: 0,
    });
    expect(e.events).toEqual([
      { type: 'market.opened', payload: { marketId: MARKET, cityId: SPRINGFIELD } },
    ]);
    expect(checkEconomyInvariants({ economy: state }, M1_CONTENT_PACK)).toEqual([]);
  });

  it('with EMPTY_CONTENT_PACK is EMPTY_ECONOMY_STATE plus the macro tunables', () => {
    const e = env();
    const state = createEconomyState(EMPTY_CONTENT_PACK, e);
    expect(state).toEqual({
      ...EMPTY_ECONOMY_STATE,
      macro: { ...EMPTY_ECONOMY_STATE.macro, policyRate: 0.04, demandIndex: 1 },
    });
    expect(e.events).toEqual([]);
  });

  it('applies priceFactor and demandIndex to the opening reference price and demand', () => {
    const content: ContentPack = {
      ...M1_CONTENT_PACK,
      markets: {
        [MARKET]: {
          ...M1_CONTENT_PACK.markets[MARKET]!,
          demand: [{ product: BREAD, baseDailyDemand: quantity(1000), priceFactor: 1.2 }],
        },
      },
      economy: {
        ...M1_CONTENT_PACK.economy,
        macro: { inflationAnnual: 0, policyRate: 0.05, demandIndex: 0.75 },
      },
    };
    const pm = productMarketOf(createEconomyState(content, env()), MARKET, BREAD);
    expect(pm.referencePrice).toBe(300);
    expect(pm.demandToday).toBe(750);
    expect(
      anchorPriceOf(
        content,
        { priceIndex: 1, policyRate: 0, demandIndex: 1, lastMonthApplied: 0 },
        MARKET,
        BREAD,
      ),
    ).toBe(300);
  });
});

describe('applyMacro', () => {
  it('applies monthly inflation on month starts after tick 0 and copies the rate and index', () => {
    const content: ContentPack = {
      ...M1_CONTENT_PACK,
      economy: {
        ...M1_CONTENT_PACK.economy,
        macro: { inflationAnnual: 0.12, policyRate: 0.07, demandIndex: 2 },
      },
    };
    const state = createEconomyState(content, env());
    state.macro.policyRate = 0.5; // drift to prove it is re-copied

    const t0 = env(0);
    applyMacro(state, content, calendarFromTick(0, 2000), t0);
    expect(state.macro.priceIndex).toBe(1);
    expect(state.macro.lastMonthApplied).toBe(0);
    expect(state.macro.policyRate).toBe(0.07);
    expect(state.macro.demandIndex).toBe(2);
    expect(t0.events).toEqual([]);

    const t29 = env(29);
    applyMacro(state, content, calendarFromTick(29, 2000), t29);
    expect(t29.events).toEqual([]);

    const t30 = env(30);
    applyMacro(state, content, calendarFromTick(30, 2000), t30);
    expect(state.macro.priceIndex).toBe(1.01);
    expect(state.macro.lastMonthApplied).toBe(30);
    expect(t30.events).toEqual([
      { type: 'macro.month_applied', payload: { tick: 30, priceIndex: 1.01 } },
    ]);

    const t60 = env(60);
    applyMacro(state, content, calendarFromTick(60, 2000), t60);
    expect(state.macro.priceIndex).toBe(1.01 * 1.01);
  });
});

describe('advanceDay', () => {
  it('at tick 0 leaves the day that init opened untouched (there is no day -1 to close)', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    const before = JSON.stringify(state);
    advanceDay(state, M1_CONTENT_PACK, calendarFromTick(0, 2000), env(0));
    expect(JSON.stringify(state)).toBe(before);
  });

  it('relaxes from yesterday’s tallies, closes the day into last*, and reopens baseline demand', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    // Yesterday: nobody offered anything -> x = +1.
    clearConsumerMarketIn(state, M1_CONTENT_PACK, MARKET, BREAD, []);
    const pmBefore = { ...productMarketOf(state, MARKET, BREAD) };
    advanceDay(state, M1_CONTENT_PACK, calendarFromTick(1, 2000), env(1));
    const pm = productMarketOf(state, MARKET, BREAD);
    expect(pm.imbalanceEma).toBe(PRICING.beta * 1);
    expect(pm.level).toBe(1 + PRICING.alpha * PRICING.kappa * PRICING.beta);
    expect(pm.referencePrice).toBe(priceAtLevel(BREAD_BASE_PRICE, pm.level));
    expect(pm.lastDemand).toBe(pmBefore.demandToday);
    expect(pm.lastOffered).toBe(0);
    expect(pm.lastSold).toBe(0);
    expect(pm.demandToday).toBe(BREAD_DEMAND);
    expect(pm.demandRemaining).toBe(BREAD_DEMAND);
    expect(pm.offeredToday).toBe(0);
    expect(pm.soldToday).toBe(0);
  });

  it('a balanced day leaves the level at exactly 1 and the reference price at the anchor', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    for (let t = 1; t <= 50; t++) {
      clearConsumerMarketIn(state, M1_CONTENT_PACK, MARKET, BREAD, [
        offer(productMarketOf(state, MARKET, BREAD).referencePrice, BREAD_DEMAND),
      ]);
      advanceDay(state, M1_CONTENT_PACK, calendarFromTick(t, 2000), env(t));
      const pm = productMarketOf(state, MARKET, BREAD);
      expect(pm.level).toBe(1);
      expect(pm.referencePrice).toBe(BREAD_BASE_PRICE);
      expect(pm.lastSold).toBe(BREAD_DEMAND);
      expect(pm.lastOffered).toBe(BREAD_DEMAND);
    }
  });

  it('commodity: buying 2 x V0 for 30 days raises unitPrice monotonically, bounded by the band', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    const prices: number[] = [state.commodities[GRAIN]!.unitPrice];
    for (let t = 1; t <= 30; t++) {
      recordRawPurchase(state, GRAIN, quantity(2 * GRAIN_SOURCE.referenceDailyVolume));
      advanceDay(state, M1_CONTENT_PACK, calendarFromTick(t, 2000), env(t));
      const cs = state.commodities[GRAIN]!;
      prices.push(cs.unitPrice);
      expect(cs.lastPurchased).toBe(2 * GRAIN_SOURCE.referenceDailyVolume);
      expect(cs.purchasedToday).toBe(0);
      expect(cs.level).toBeLessThanOrEqual(1 + GRAIN_SOURCE.kappa);
    }
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]!).toBeGreaterThanOrEqual(prices[i - 1]!);
    }
    expect(prices[30]!).toBeGreaterThan(prices[0]!);
    expect(prices[30]!).toBeLessThanOrEqual(priceAtLevel(GRAIN_BASE_PRICE, 1 + GRAIN_SOURCE.kappa));
    // y = (2V0 - V0) / 2V0 = 0.5, so the target is 1 + 0.5 kappa_c and the level never passes it.
    expect(state.commodities[GRAIN]!.level).toBeLessThanOrEqual(1 + 0.5 * GRAIN_SOURCE.kappa);
    expect(checkEconomyInvariants({ economy: state }, M1_CONTENT_PACK)).toEqual([]);
  });

  it('inflation moves the anchor and therefore the reference price', () => {
    const content: ContentPack = {
      ...M1_CONTENT_PACK,
      economy: {
        ...M1_CONTENT_PACK.economy,
        macro: { inflationAnnual: 0.12, policyRate: 0.04, demandIndex: 1 },
      },
    };
    const state = createEconomyState(content, env());
    for (let t = 1; t <= 30; t++) {
      clearConsumerMarketIn(state, content, MARKET, BREAD, [
        offer(productMarketOf(state, MARKET, BREAD).referencePrice, BREAD_DEMAND),
      ]);
      recordRawPurchase(state, GRAIN, GRAIN_SOURCE.referenceDailyVolume); // balanced: level 1
      advanceDay(state, content, calendarFromTick(t, 2000), env(t));
    }
    expect(state.macro.priceIndex).toBe(1.01);
    // Both levels stay at 1 under balanced volumes, so only the anchor moves:
    // bread scaleMoney(250, 1.01) = 253 (252.5 rounds half away from zero); grain 30.3 -> 30.
    expect(productMarketOf(state, MARKET, BREAD).level).toBe(1);
    expect(productMarketOf(state, MARKET, BREAD).referencePrice).toBe(253);
    expect(state.commodities[GRAIN]!.level).toBe(1);
    expect(state.commodities[GRAIN]!.unitPrice).toBe(30);
  });
});

describe('clearConsumerMarketIn', () => {
  it('at reference sells min(stock, D) and tallies supply and demand', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    const r = clearConsumerMarketIn(state, M1_CONTENT_PACK, MARKET, BREAD, [
      offer(BREAD_BASE_PRICE, 1000),
    ]);
    expect(r).toEqual({
      sold: [BREAD_DEMAND],
      referencePrice: BREAD_BASE_PRICE,
      demandBefore: BREAD_DEMAND,
      demandAfter: 0,
    });
    const pm = productMarketOf(state, MARKET, BREAD);
    expect(pm.offeredToday).toBe(1000);
    expect(pm.soldToday).toBe(BREAD_DEMAND);
    expect(pm.demandRemaining).toBe(0);
  });

  it('a second clearing the same day sees the reduced demand', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    const first = clearConsumerMarketIn(state, M1_CONTENT_PACK, MARKET, BREAD, [
      offer(BREAD_BASE_PRICE, 100),
    ]);
    expect(first.sold).toEqual([100]);
    expect(first.demandAfter).toBe(BREAD_DEMAND - 100);
    const second = clearConsumerMarketIn(state, M1_CONTENT_PACK, MARKET, BREAD, [
      offer(BREAD_BASE_PRICE, 1000),
    ]);
    expect(second.demandBefore).toBe(BREAD_DEMAND - 100);
    expect(second.sold).toEqual([BREAD_DEMAND - 100]);
    expect(second.demandAfter).toBe(0);
    const pm = productMarketOf(state, MARKET, BREAD);
    expect(pm.soldToday).toBe(BREAD_DEMAND);
    expect(pm.offeredToday).toBe(1100);
  });

  it('a seller at 1 + 1/eps of reference sells nothing; a cheaper seller sells more than D (demandRemaining floors at 0)', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    const dead = money(Math.ceil(BREAD_BASE_PRICE * (1 + 1 / BREAD_ELASTICITY)));
    expect(
      clearConsumerMarketIn(state, M1_CONTENT_PACK, MARKET, BREAD, [offer(dead, 1000)]).sold,
    ).toEqual([0]);
    expect(productMarketOf(state, MARKET, BREAD).demandRemaining).toBe(BREAD_DEMAND);
    const cheap = clearConsumerMarketIn(state, M1_CONTENT_PACK, MARKET, BREAD, [
      offer(money(BREAD_BASE_PRICE / 2), 10_000),
    ]);
    expect(cheap.sold).toEqual([Math.floor(BREAD_DEMAND * PRICING.maxCapture)]);
    expect(cheap.demandAfter).toBe(0);
    expect(checkEconomyInvariants({ economy: state }, M1_CONTENT_PACK)).toEqual([]);
  });

  it('expectedCaptureFor matches a single-seller clearing', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    for (const p of [125, 200, 250, 300, 400, 500]) {
      const price = money(p);
      const preview = expectedCaptureFor(state, M1_CONTENT_PACK, MARKET, BREAD, price);
      const fresh = createEconomyState(M1_CONTENT_PACK, env());
      const actual = clearConsumerMarketIn(fresh, M1_CONTENT_PACK, MARKET, BREAD, [
        offer(price, 100_000),
      ]);
      expect(preview).toBe(actual.sold[0]);
    }
  });

  it('throws InvariantError codes for unknown ids and mismatched offers', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    expect(() =>
      clearConsumerMarketIn(state, M1_CONTENT_PACK, marketId('nowhere'), BREAD, []),
    ).toThrow(/economy.unknown_market/);
    expect(() =>
      clearConsumerMarketIn(state, M1_CONTENT_PACK, MARKET, productId('grain'), []),
    ).toThrow(/economy.unknown_market/);
    expect(() =>
      clearConsumerMarketIn(state, M1_CONTENT_PACK, MARKET, BREAD, [offer(money(1), 1, GRAIN)]),
    ).toThrow(/economy.offer_product_mismatch/);
    expect(() => quoteRawFrom(state, BREAD, quantity(1))).toThrow(/economy.unknown_commodity/);
    expect(() => recordRawPurchase(state, productId('oil'), quantity(1))).toThrow(
      /economy.unknown_commodity/,
    );
    expect(() => expectedCaptureFor(state, M1_CONTENT_PACK, MARKET, GRAIN, money(1))).toThrow(
      /economy.unknown_market/,
    );
  });
});

describe('quotes and lookups', () => {
  it('quoteRaw total === mulMoney(unitPrice, q); recordRawPurchase tallies the volume', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    const q = quoteRawFrom(state, GRAIN, quantity(123));
    expect(q).toEqual({
      productId: GRAIN,
      quantity: 123,
      unitPrice: GRAIN_BASE_PRICE,
      total: 123 * GRAIN_BASE_PRICE,
    });
    expect(recordRawPurchase(state, GRAIN, quantity(10))).toEqual({
      productId: GRAIN,
      quantity: 10,
      unitPrice: GRAIN_BASE_PRICE,
      total: 10 * GRAIN_BASE_PRICE,
    });
    recordRawPurchase(state, GRAIN, quantity(5));
    expect(state.commodities[GRAIN]!.purchasedToday).toBe(15);
    // The price for the day is fixed: intra-day purchases do not move it.
    expect(quoteRawFrom(state, GRAIN, quantity(1)).unitPrice).toBe(GRAIN_BASE_PRICE);
  });

  it('marketOfCityIn', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    expect(marketOfCityIn(state, SPRINGFIELD)).toBe(MARKET);
    expect(marketOfCityIn(state, cityId('shelbyville'))).toBeNull();
  });
});

describe('checkEconomyInvariants', () => {
  it('reports each violation with a stable code', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    const pm = productMarketOf(state, MARKET, BREAD);
    pm.level = 1.4;
    pm.imbalanceEma = 1.5;
    pm.referencePrice = money(0);
    pm.demandRemaining = quantity(pm.demandToday + 1);
    pm.soldToday = quantity(10_000);
    state.commodities[GRAIN]!.level = 0.1;
    state.commodities[GRAIN]!.unitPrice = money(0);
    state.macro.priceIndex = 0;
    state.macro.policyRate = 2;
    state.macro.demandIndex = -1;
    const codes = checkEconomyInvariants({ economy: state }, M1_CONTENT_PACK).map((v) => v.code);
    expect(codes).toEqual([
      'macro.price_index',
      'macro.policy_rate',
      'macro.demand_index',
      'market.level_out_of_band',
      'market.ema_out_of_range',
      'market.reference_price',
      'market.demand_remaining',
      'market.sold_exceeds_demand',
      'commodity.level_out_of_band',
      'commodity.unit_price',
    ]);
    // Without content the band is the widest admissible one (kappa 0.5), so 1.4 passes but 0.1 fails.
    const loose = checkEconomyInvariants({ economy: state }).map((v) => v.code);
    expect(loose).not.toContain('market.level_out_of_band');
    expect(loose).toContain('commodity.level_out_of_band');
  });

  it('flags NaN', () => {
    const state = createEconomyState(M1_CONTENT_PACK, env());
    productMarketOf(state, MARKET, BREAD).level = NaN;
    expect(checkEconomyInvariants({ economy: state }, M1_CONTENT_PACK).map((v) => v.code)).toEqual([
      'economy.non_finite',
    ]);
  });
});
