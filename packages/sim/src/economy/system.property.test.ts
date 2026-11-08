/**
 * Sweep-style property (economy.md section 9): for random offer books (quantities, prices in
 * [1, 5 x anchor]) and random raw purchases, every tick keeps the section-8 invariants and
 * |Δlevel| <= 2 alpha kappa, for both the consumer market and the commodity. Drives the slice-level
 * functions directly (the same ones the system and service call) for speed.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calendarFromTick } from '../engine/index.js';
import { M1_CONTENT_PACK, money, quantity, type ContentPack } from '../schema/index.js';
import { checkEconomyInvariants } from './invariants.js';
import { maxLevelStep } from './pricing.js';
import {
  advanceDay,
  clearConsumerMarketIn,
  createEconomyState,
  productMarketOf,
  recordRawPurchase,
} from './state.js';
import { BREAD, BREAD_BASE_PRICE, GRAIN, GRAIN_SOURCE, MARKET, offer } from './test-helpers.js';

interface Day {
  offers: { price: number; quantity: number }[];
  clearTwice: boolean;
  rawPurchase: number;
}

const dayArb: fc.Arbitrary<Day> = fc.record({
  offers: fc.array(
    fc.record({
      price: fc.integer({ min: 1, max: 5 * BREAD_BASE_PRICE }),
      quantity: fc.integer({ min: 0, max: 5_000 }),
    }),
    { maxLength: 4 },
  ),
  clearTwice: fc.boolean(),
  rawPurchase: fc.integer({ min: 0, max: 5 * GRAIN_SOURCE.referenceDailyVolume }),
});

const tunablesArb = fc.record({
  alpha: fc.double({ min: 0.01, max: 0.99, noNaN: true }),
  beta: fc.double({ min: 0.01, max: 0.99, noNaN: true }),
  kappa: fc.double({ min: 0.01, max: 0.5, noNaN: true }),
  maxCapture: fc.double({ min: 1, max: 3, noNaN: true }),
});

const noop = { emit: () => undefined };

describe('economy sweep property', () => {
  it('random offer books and purchases keep every invariant and |Δlevel| <= 2 alpha kappa', () => {
    fc.assert(
      fc.property(
        tunablesArb,
        fc.array(dayArb, { minLength: 1, maxLength: 120 }),
        (pricing, days) => {
          const content: ContentPack = {
            ...M1_CONTENT_PACK,
            economy: { ...M1_CONTENT_PACK.economy, pricing },
          };
          const state = createEconomyState(content, { tick: 0, ...noop });
          const maxStep = maxLevelStep(pricing.alpha, pricing.kappa);
          const maxStepC = maxLevelStep(GRAIN_SOURCE.alpha, GRAIN_SOURCE.kappa);
          days.forEach((day, i) => {
            const tick = i + 1;
            const offers = day.offers.map((o) => offer(money(o.price), o.quantity));
            const pm = productMarketOf(state, MARKET, BREAD);
            const before = { ...pm };
            const first = clearConsumerMarketIn(state, content, MARKET, BREAD, offers);
            expect(first.demandBefore).toBe(before.demandRemaining);
            expect(first.demandAfter).toBe(pm.demandRemaining);
            if (day.clearTwice) {
              const second = clearConsumerMarketIn(state, content, MARKET, BREAD, offers);
              expect(second.demandBefore).toBe(first.demandAfter);
              expect(second.demandAfter).toBeLessThanOrEqual(second.demandBefore);
            }
            if (day.rawPurchase > 0) recordRawPurchase(state, GRAIN, quantity(day.rawPurchase));
            expect(checkEconomyInvariants({ economy: state }, content)).toEqual([]);

            const levelBefore = pm.level;
            const levelBeforeC = state.commodities[GRAIN]!.level;
            advanceDay(state, content, calendarFromTick(tick, 2000), { tick, ...noop });
            expect(checkEconomyInvariants({ economy: state }, content)).toEqual([]);
            expect(Math.abs(pm.level - levelBefore)).toBeLessThanOrEqual(maxStep + 1e-12);
            expect(Math.abs(state.commodities[GRAIN]!.level - levelBeforeC)).toBeLessThanOrEqual(
              maxStepC + 1e-12,
            );
            expect(pm.demandRemaining).toBe(pm.demandToday);
            expect(pm.offeredToday).toBe(0);
            expect(pm.soldToday).toBe(0);
            expect(pm.referencePrice).toBeGreaterThanOrEqual(1);
          });
        },
      ),
      { numRuns: 150 },
    );
  });
});
