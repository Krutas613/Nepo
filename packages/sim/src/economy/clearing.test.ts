/** Clearing table (economy.md section 9) and a property over random offer books. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { money, quantity, type Money, type Quantity } from '../schema/index.js';
import { clearOffers, type ClearingOffer, type ClearingParams } from './clearing.js';

const REF: Money = money(250);
const base: ClearingParams = {
  demand: quantity(1000),
  referencePrice: REF,
  elasticity: 1.5,
  maxCapture: 1.5,
};

function offer(price: number, qty: number): ClearingOffer {
  return { price: money(price), quantity: quantity(qty) };
}

describe('clearOffers', () => {
  it('no offers: nothing sold, no supply', () => {
    expect(clearOffers(base, [])).toEqual({
      sold: [],
      totalSold: 0,
      effectiveSupply: 0,
      capture: [],
    });
  });

  it('one offer at reference sells min(stock, D) and offers its whole stock as supply', () => {
    expect(clearOffers(base, [offer(250, 5000)]).sold).toEqual([1000]);
    expect(clearOffers(base, [offer(250, 5000)]).effectiveSupply).toBe(5000);
    expect(clearOffers(base, [offer(250, 300)]).sold).toEqual([300]);
    expect(clearOffers(base, [offer(250, 300)]).effectiveSupply).toBe(300);
  });

  it('a seller at r >= 1 + 1/eps sells nothing and adds no effective supply', () => {
    // 1 + 1/1.5 = 1.6667 -> 416.67; 417 is above it, 500 is r = 2.
    const r = clearOffers(base, [offer(417, 1000), offer(500, 1000)]);
    expect(r.sold).toEqual([0, 0]);
    expect(r.effectiveSupply).toBe(0);
    expect(r.capture.map((g) => g <= 0)).toEqual([true, true]);
  });

  it('a cheaper seller captures more than D, up to floor(D maxCapture); supply is capped at 1 per unit', () => {
    const r = clearOffers(base, [offer(125, 5000)]); // r = 0.5 -> g = 1.5
    expect(r.capture).toEqual([1.5]);
    expect(r.sold).toEqual([1500]);
    expect(r.effectiveSupply).toBe(5000);
  });

  it('two offers split by w_i / W, and the spill pass moves unfilled demand to the seller with stock', () => {
    // g = 1 and g = 1: want 500 each. Seller 0 has only 200 -> spill 300 goes to seller 1.
    const r = clearOffers(base, [offer(250, 200), offer(250, 5000)]);
    expect(r.sold).toEqual([200, 800]);
    expect(r.totalSold).toBe(1000);
    expect(r.effectiveSupply).toBe(5200);
  });

  it('unequal prices: the cheaper seller gets the larger share', () => {
    // g0 = 1 (at reference), g1 = 1 - 1.5 * (200/250 - 1) = 1.3. W = 2.3.
    const r = clearOffers(base, [offer(250, 5000), offer(200, 5000)]);
    const want0 = Math.floor(1000 * 1 * (1 / 2.3));
    const want1 = Math.floor(1000 * 1.3 * (1.3 / 2.3));
    expect(r.sold).toEqual([want0, want1]);
    expect(want1).toBeGreaterThan(want0);
    // The grand total never exceeds floor(D max g).
    expect(r.totalSold).toBeLessThanOrEqual(Math.floor(1000 * 1.3));
  });

  it('empty offers carry no weight and do not dilute stocked sellers', () => {
    const r = clearOffers(base, [offer(250, 0), offer(250, 5000)]);
    expect(r.sold).toEqual([0, 1000]);
  });

  it('spill never exceeds floor(D max_i g_i)', () => {
    // Seller 0 cheap (g = 1.5) but tiny stock; seller 1 expensive (g = 0.4) with plenty.
    // W = 1.9; want0 = floor(1000 * 1.5 * 1.5/1.9) = 1184 -> sold 10, spill 1174;
    // want1 = floor(1000 * 0.4 * 0.4/1.9) = 84. cap = 1500 -> spill limited to 1500 - 94 = 1406.
    const r = clearOffers(base, [offer(125, 10), offer(350, 100_000)]);
    expect(r.sold[0]).toBe(10);
    expect(r.totalSold).toBeLessThanOrEqual(1500);
    expect(r.totalSold).toBe(10 + 84 + 1174);
  });

  it('zero demand sells nothing but still tallies supply', () => {
    const r = clearOffers({ ...base, demand: quantity(0) }, [offer(250, 100)]);
    expect(r.sold).toEqual([0]);
    expect(r.effectiveSupply).toBe(100);
  });

  it('property: sold_i <= quantity_i, Σ sold <= floor(D max g) <= floor(D maxCapture), supply in [0, Σ qty]', () => {
    const offerArb = fc.record({
      price: fc.integer({ min: 1, max: 5 * REF }).map((p) => money(p)),
      quantity: fc.integer({ min: 0, max: 20_000 }).map((q) => quantity(q)),
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000 }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.double({ min: 1, max: 3, noNaN: true }),
        fc.array(offerArb, { maxLength: 6 }),
        (D, elasticity, maxCapture, offers) => {
          const r = clearOffers(
            { demand: quantity(D), referencePrice: REF, elasticity, maxCapture },
            offers,
          );
          let sum = 0;
          let qtySum = 0;
          r.sold.forEach((s: Quantity, i) => {
            expect(s).toBeLessThanOrEqual(offers[i]?.quantity ?? 0);
            expect(s).toBeGreaterThanOrEqual(0);
            sum += s;
            qtySum += offers[i]?.quantity ?? 0;
          });
          expect(sum).toBe(r.totalSold);
          const gmax = Math.max(0, ...r.capture);
          expect(sum).toBeLessThanOrEqual(Math.floor(D * gmax));
          expect(sum).toBeLessThanOrEqual(Math.floor(D * maxCapture));
          expect(r.effectiveSupply).toBeGreaterThanOrEqual(0);
          expect(r.effectiveSupply).toBeLessThanOrEqual(qtySum);
          expect(Number.isFinite(r.effectiveSupply)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
