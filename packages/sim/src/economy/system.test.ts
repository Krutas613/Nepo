/**
 * Integration with the real engine (economy.md section 9): init, the `macro` phase, the service
 * used by scripted retail/manufacturing stand-ins, stability under steady state / shock / no
 * supply, commodity dynamics, ownership rules, determinism and snapshot/restore.
 */
import { describe, expect, it } from 'vitest';
import { accountingSystem } from '../accounting/index.js';
import {
  createWorld,
  findNonFinite,
  hashState,
  restore,
  snapshot,
  step,
  type AnySystem,
  type System,
  type World,
} from '../engine/index.js';
import {
  EMPTY_ECONOMY_STATE,
  EconomyStateSchema,
  InvariantError,
  M1_CONTENT_PACK,
  SMOKE_SCENARIO,
  WorldStateSchema,
  cityId,
  money,
  quantity,
  type EconomyState,
  type Event,
  type RetailState,
  type Scenario,
} from '../schema/index.js';
import { checkEconomyInvariants } from './invariants.js';
import { levelBounds, maxLevelStep, priceAtLevel } from './pricing.js';
import { ECONOMY_SERVICE } from './service.js';
import { productMarketOf } from './state.js';
import { economySystem } from './system.js';
import {
  BREAD,
  BREAD_BASE_PRICE,
  BREAD_DEMAND,
  GRAIN,
  GRAIN_BASE_PRICE,
  GRAIN_SOURCE,
  MARKET,
  PLAYER,
  PRICING,
  SCENARIO,
  idleFinance,
  isMonotone,
  offer,
  scriptedManufacturing,
  scriptedRetail,
  signChanges,
  type RetailScript,
} from './test-helpers.js';

const KAPPA = PRICING.kappa;
const { lo: LO, hi: HI } = levelBounds(KAPPA);
const MAX_STEP = maxLevelStep(PRICING.alpha, KAPPA);

function newWorld(extra: readonly AnySystem[] = [], scenario: Scenario = SCENARIO, seed = 7): World {
  return createWorld({
    seed,
    scenario,
    systems: [accountingSystem, economySystem, idleFinance, ...extra],
  });
}

function bread(world: World) {
  return productMarketOf(world.state.economy, MARKET, BREAD);
}

/** Steps `ticks` times, checking invariants every tick and recording the bread level per tick. */
function runLevels(world: World, ticks: number, ownershipTicks = 5): number[] {
  const levels: number[] = [bread(world).level];
  for (let i = 0; i < ticks; i++) {
    const before = bread(world).level;
    step(world, { checkSliceOwnership: i < ownershipTicks, checkFinite: i % 60 === 0 });
    const after = bread(world).level;
    expect(checkEconomyInvariants(world.state, world.scenario.content)).toEqual([]);
    expect(after).toBeGreaterThanOrEqual(LO);
    expect(after).toBeLessThanOrEqual(HI);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(MAX_STEP + 1e-12);
    levels.push(after);
  }
  return levels;
}

const sellAtReference =
  (units: (tick: number) => number | null): RetailScript =>
  (tick, api) => {
    const u = units(tick);
    return u === null ? null : [offer(api.referencePrice(MARKET, BREAD), u)];
  };

describe('economySystem init', () => {
  it('opens the vertical-slice market and commodity and emits market.opened', () => {
    const world = newWorld();
    expect(world.state.economy.markets[MARKET]).toMatchObject({
      id: MARKET,
      city: 'springfield',
      region: 'heartland',
    });
    expect(bread(world)).toMatchObject({
      level: 1,
      referencePrice: BREAD_BASE_PRICE,
      demandToday: BREAD_DEMAND,
      demandRemaining: BREAD_DEMAND,
    });
    expect(world.state.economy.commodities[GRAIN]?.unitPrice).toBe(GRAIN_BASE_PRICE);
    const opened = world.lastEvents.filter((e) => e.type === 'market.opened');
    expect(opened.map((e) => [e.source, e.payload])).toEqual([
      ['economy', { marketId: MARKET, cityId: 'springfield' }],
    ]);
    expect(EconomyStateSchema.safeParse(world.state.economy).success).toBe(true);
  });

  it('with SMOKE_SCENARIO (empty content) the slice is EMPTY_ECONOMY_STATE plus the tunables and 720 ticks are a no-op', () => {
    const world = newWorld([], SMOKE_SCENARIO);
    expect(world.state.economy).toEqual({
      ...EMPTY_ECONOMY_STATE,
      macro: { ...EMPTY_ECONOMY_STATE.macro, policyRate: 0.04, demandIndex: 1 },
    });
    for (let i = 0; i < 720; i++) step(world, { checkSliceOwnership: i < 3 });
    expect(world.state.economy.markets).toEqual({});
    expect(checkEconomyInvariants(world.state)).toEqual([]);
    expect(world.state.rng['economy']).toBeUndefined(); // the economy stream is never drawn from
  });

  it('registers only the macro phase and no commands', () => {
    expect(Object.keys(economySystem.phases)).toEqual(['macro']);
    expect(economySystem.handles).toEqual([]);
    expect(economySystem.serviceKey).toBe(ECONOMY_SERVICE);
  });
});

describe('stability with a scripted retail stand-in (economy.md section 9)', () => {
  it('convergence: exactly D at reference every tick for 720 ticks keeps the level at 1 (no oscillation)', () => {
    const retail = scriptedRetail(sellAtReference(() => BREAD_DEMAND));
    const world = newWorld([retail]);
    const levels = runLevels(world, 720);
    expect(Math.abs((levels[720] ?? 0) - 1)).toBeLessThan(1e-3);
    expect(signChanges(levels.slice(60))).toBeLessThanOrEqual(1);
    expect(levels.every((l) => l === 1)).toBe(true);
    expect(bread(world).referencePrice).toBe(BREAD_BASE_PRICE);
    expect(retail.log.clearings).toHaveLength(720);
    expect(retail.log.clearings.every((c) => c.clearing.sold[0] === BREAD_DEMAND)).toBe(true);
    expect(bread(world).lastSold).toBe(BREAD_DEMAND);
  });

  it('shock and recovery: 2D for ticks 100-199 lowers the level monotonically, never below 1 - kappa, then recovers', () => {
    const retail = scriptedRetail(
      sellAtReference((t) => (t >= 100 && t < 200 ? 2 * BREAD_DEMAND : BREAD_DEMAND)),
    );
    const world = newWorld([retail]);
    const levels = runLevels(world, 720);
    // Levels index by tick-after: levels[t + 1] is the level set by macro of tick t + 1, i.e. from
    // tick t's tallies. The flood is tallied on ticks 100..199 and priced on ticks 101..200.
    const during = levels.slice(100, 202);
    expect(isMonotone(during, 'down')).toBe(true);
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(LO);
    expect(Math.min(...levels)).toBeGreaterThan(1 - 0.5 * KAPPA - 1e-12); // x = -0.5 floor
    const after = levels.slice(201);
    expect(signChanges(after)).toBeLessThanOrEqual(1);
    expect(Math.max(...after)).toBeLessThanOrEqual(1); // no overshoot above 1 on recovery
    expect(Math.abs((levels[720] ?? 0) - 1)).toBeLessThan(1e-3);
    // Sales never exceed demand at reference, even during the flood.
    expect(retail.log.clearings.every((c) => c.clearing.sold[0] === BREAD_DEMAND)).toBe(true);
  });

  it('unserved market: no offers for 360 ticks drives the level monotonically to 1 + kappa', () => {
    const retail = scriptedRetail(() => null);
    const world = newWorld([retail]);
    const levels = runLevels(world, 360);
    expect(isMonotone(levels, 'up')).toBe(true);
    expect(Math.abs((levels[360] ?? 0) - HI)).toBeLessThan(1e-3);
    expect(bread(world).referencePrice).toBe(priceAtLevel(BREAD_BASE_PRICE, bread(world).level));
    expect(bread(world).referencePrice).toBe(325); // 250 x 1.3 (within rounding of 1e-3)
    expect(bread(world).lastOffered).toBe(0);
    expect(bread(world).lastSold).toBe(0);
  });

  it('a persistent undercutter floods the market: the level falls monotonically and sales cap at floor(D maxCapture)', () => {
    // Half-price seller with plenty of stock: g = 1.5, S = qty x min(1, g) = qty, which exceeds D ->
    // flooded market, level falls toward 1 - 0.75 kappa. Sells floor(D x 1.5) per day.
    const retail = scriptedRetail((_t, api) => [
      offer(money(Math.max(1, Math.floor(api.referencePrice(MARKET, BREAD) / 2))), 4 * BREAD_DEMAND),
    ]);
    const world = newWorld([retail]);
    const levels = runLevels(world, 200);
    expect(isMonotone(levels, 'down')).toBe(true);
    expect(retail.log.clearings.every((c) => c.clearing.sold[0] === Math.floor(BREAD_DEMAND * 1.5))).toBe(true);
    expect(bread(world).lastSold).toBe(Math.floor(BREAD_DEMAND * PRICING.maxCapture));
  });
});

describe('commodity source through the service', () => {
  it('buyRaw records volume and emits commodity.purchased; 30 days of 2 x V0 raise the price monotonically within the band', () => {
    const mfg = scriptedManufacturing(() => 2 * GRAIN_SOURCE.referenceDailyVolume);
    const world = newWorld([mfg]);
    const prices: number[] = [];
    const purchased: Event[] = [];
    for (let i = 0; i < 30; i++) {
      const result = step(world, { checkSliceOwnership: i < 5 });
      purchased.push(...result.events.filter((e) => e.type === 'commodity.purchased'));
      prices.push(world.state.economy.commodities[GRAIN]?.unitPrice ?? NaN);
      expect(checkEconomyInvariants(world.state, world.scenario.content)).toEqual([]);
    }
    expect(isMonotone(prices, 'up')).toBe(true);
    expect(prices[29]).toBeGreaterThan(GRAIN_BASE_PRICE);
    expect(prices[29]).toBeLessThanOrEqual(priceAtLevel(GRAIN_BASE_PRICE, 1 + GRAIN_SOURCE.kappa));
    expect(purchased).toHaveLength(30);
    expect(purchased[0]).toMatchObject({
      source: 'economy',
      payload: {
        companyId: PLAYER,
        productId: GRAIN,
        quantity: 2 * GRAIN_SOURCE.referenceDailyVolume,
        unitPrice: GRAIN_BASE_PRICE,
        total: 2 * GRAIN_SOURCE.referenceDailyVolume * GRAIN_BASE_PRICE,
      },
    });
    // The log's quote total always equals unitPrice x quantity and matches the event.
    mfg.log.purchases.forEach((p, i) => {
      expect(p.total).toBe(p.unitPrice * 2 * GRAIN_SOURCE.referenceDailyVolume);
      const e = purchased[i];
      expect(e?.type === 'commodity.purchased' && e.payload.unitPrice).toBe(p.unitPrice);
    });
    // Economy holds no money: nothing was posted to the ledger by economy.
    expect(world.state.accounting.journal.every((j) => j.source !== 'economy')).toBe(true);
  });

  it('quoteRaw is consistent with buyRaw within a tick (the day price is fixed)', () => {
    let checked = 0;
    const probe: System<Record<string, never>> = {
      id: 'logistics',
      handles: [],
      init: () => ({}),
      phases: {
        production(ctx) {
          const api = ctx.services.get(ECONOMY_SERVICE);
          const q1 = api.quoteRaw(GRAIN, quantity(7));
          const bought = api.buyRaw(PLAYER, GRAIN, quantity(7));
          const q2 = api.quoteRaw(GRAIN, quantity(7));
          expect(bought).toEqual(q1);
          expect(q2).toEqual(q1);
          expect(q1.total).toBe(q1.unitPrice * 7);
          checked += 1;
        },
      },
    };
    const world = newWorld([probe]);
    for (let i = 0; i < 10; i++) step(world);
    expect(checked).toBe(10);
  });
});

describe('service rules (ARCHITECTURE.md section 6.2)', () => {
  function reader(writeIllegally: boolean): System<RetailState> {
    return {
      id: 'retail',
      handles: [],
      init: () => ({ stores: {} }),
      phases: {
        market(ctx) {
          const api = ctx.services.get(ECONOMY_SERVICE);
          expect(api.policyRate()).toBe(0.04);
          expect(api.priceIndex()).toBe(1);
          expect(api.marketOfCity(cityId('springfield'))).toBe(MARKET);
          expect(api.marketOfCity(cityId('nowhere'))).toBeNull();
          const ref = api.referencePrice(MARKET, BREAD);
          expect(api.demandRemaining(MARKET, BREAD)).toBe(BREAD_DEMAND);
          expect(api.expectedCapture(MARKET, BREAD, ref)).toBe(BREAD_DEMAND);
          expect(api.expectedCapture(MARKET, BREAD, money(ref * 2))).toBe(0);
          const unit = api.quoteRaw(GRAIN, quantity(1)).unitPrice;
          expect(api.quoteRaw(GRAIN, quantity(3)).total).toBe(3 * unit);
          if (ctx.tick === 0) {
            expect(ref).toBe(BREAD_BASE_PRICE);
            expect(unit).toBe(GRAIN_BASE_PRICE);
          }
          if (writeIllegally) {
            const foreign = ctx.state.economy as unknown as EconomyState;
            productMarketOf(foreign, MARKET, BREAD).level = 1.1;
          }
        },
      },
    };
  }

  it('read methods do not declare a mutation: a direct foreign write after reads is caught', () => {
    const world = newWorld([reader(true)]);
    let error: unknown;
    try {
      step(world, { checkSliceOwnership: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvariantError);
    expect(error).toMatchObject({
      code: 'slice.foreign_write',
      details: { system: 'retail', phase: 'market', slice: 'economy' },
    });
  });

  it('a system that only reads passes the ownership check', () => {
    const world = newWorld([reader(false)]);
    for (let i = 0; i < 3; i++) step(world, { checkSliceOwnership: true });
  });

  it('clearConsumerMarket from market and buyRaw from production pass the ownership check', () => {
    const world = newWorld([
      scriptedRetail(sellAtReference(() => BREAD_DEMAND)),
      scriptedManufacturing(() => 50),
    ]);
    for (let i = 0; i < 5; i++) step(world, { checkSliceOwnership: true });
    expect(bread(world).lastSold).toBe(BREAD_DEMAND);
    expect(world.state.economy.commodities[GRAIN]?.lastPurchased).toBe(50);
  });

  it('unknown ids throw stable InvariantError codes through the service', () => {
    const probe: System<Record<string, never>> = {
      id: 'logistics',
      handles: [],
      init: () => ({}),
      phases: {
        market(ctx) {
          const api = ctx.services.get(ECONOMY_SERVICE);
          expect(() => api.referencePrice(MARKET, GRAIN)).toThrow(/economy.unknown_market/);
          expect(() => api.quoteRaw(BREAD, quantity(1))).toThrow(/economy.unknown_commodity/);
          expect(() => api.buyRaw(PLAYER, BREAD, quantity(1))).toThrow(/economy.unknown_commodity/);
        },
      },
    };
    step(newWorld([probe]));
  });

  it('content-dependent writes before the first macro phase throw economy.content_unbound', () => {
    const early: System<Record<string, never>> = {
      id: 'logistics',
      handles: [],
      init: () => ({}),
      phases: {
        apply(ctx) {
          if (ctx.tick > 0) return;
          const api = ctx.services.get(ECONOMY_SERVICE);
          expect(api.referencePrice(MARKET, BREAD)).toBe(BREAD_BASE_PRICE); // reads work
          expect(() => api.clearConsumerMarket(MARKET, BREAD, [])).toThrow(
            /economy.content_unbound/,
          );
        },
      },
    };
    const world = newWorld([early]);
    expect(() => step(world)).not.toThrow();
  });
});

describe('determinism and persistence', () => {
  const systems = (): AnySystem[] => [
    scriptedRetail(sellAtReference((t) => (t % 7 === 0 ? null : (t % 50) * 10))),
    scriptedManufacturing((t) => (t % 3) * 400),
  ];

  it('two worlds with the same seed and script hash identically every tick', () => {
    const a = newWorld(systems());
    const b = newWorld(systems());
    for (let i = 0; i < 200; i++) {
      step(a);
      step(b);
      expect(hashState(a.state)).toBe(hashState(b.state));
    }
    expect(checkEconomyInvariants(a.state, a.scenario.content)).toEqual([]);
  });

  it('snapshot at tick 50, restore, run to 200: equal hash to the uninterrupted run', () => {
    const a = newWorld(systems());
    for (let i = 0; i < 50; i++) step(a);
    expect(WorldStateSchema.safeParse(a.state).success).toBe(true);
    const restored = restore(snapshot(a), [accountingSystem, economySystem, idleFinance, ...systems()]);
    expect(hashState(restored.state)).toBe(hashState(a.state));
    for (let i = 50; i < 200; i++) {
      step(a);
      step(restored);
      expect(hashState(restored.state)).toBe(hashState(a.state));
    }
    expect(bread(restored)).toEqual(bread(a));
  });

  it('720 ticks with monthly inflation: priceIndex compounds, month_applied fires on month starts, no NaN', () => {
    const scenario: Scenario = {
      ...SCENARIO,
      content: {
        ...M1_CONTENT_PACK,
        economy: {
          ...M1_CONTENT_PACK.economy,
          macro: { inflationAnnual: 0.06, policyRate: 0.04, demandIndex: 1 },
        },
      },
    };
    const world = newWorld(systems(), scenario);
    let applied = 0;
    for (let i = 0; i < 720; i++) {
      const result = step(world, { checkFinite: true });
      const events = result.events.filter((e) => e.type === 'macro.month_applied');
      if (result.date.isMonthStart && i > 0) {
        expect(events).toHaveLength(1);
        applied += 1;
      } else {
        expect(events).toHaveLength(0);
      }
      expect(checkEconomyInvariants(world.state, scenario.content)).toEqual([]);
    }
    expect(applied).toBe(23);
    expect(world.state.economy.macro.lastMonthApplied).toBe(690);
    expect(world.state.economy.macro.priceIndex).toBeCloseTo(1.005 ** 23, 12);
    expect(findNonFinite(world.state)).toEqual([]);
    expect(EconomyStateSchema.safeParse(world.state.economy).success).toBe(true);
  });
});
