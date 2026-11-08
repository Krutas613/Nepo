import { describe, expect, it } from 'vitest';
import { allocateMoney } from '../accounting/index.js';
import { money, quantity } from '../schema/index.js';
import { lotInvariantErrors } from './lots.js';
import {
  applyShrinkage,
  buildOffer,
  createStore,
  depreciationCharge,
  effectivePrice,
  freeCapacity,
  newShelfLine,
  resetDay,
  restockQuantity,
  settleSale,
  shelfUnits,
  shelfValue,
  shrinkageUnits,
  unmetDemand,
} from './store.js';
import {
  BREAD,
  GRAIN,
  GROCERY_FORMAT,
  OWNER,
  SPRINGFIELD,
  SPRINGFIELD_MARKET,
  STORE_1,
  makeStore,
} from './test-helpers.js';

describe('createStore', () => {
  it('starts under construction and completes after constructionTicks', () => {
    const s = createStore({
      id: STORE_1,
      ownerId: OWNER,
      format: GROCERY_FORMAT,
      cityId: SPRINGFIELD,
      marketId: SPRINGFIELD_MARKET,
      tick: 7,
    });
    expect(s.status).toBe('under_construction');
    expect(s.orderedTick).toBe(7);
    expect(s.completesTick).toBe(7 + GROCERY_FORMAT.constructionTicks);
    expect(s.cost).toBe(GROCERY_FORMAT.buildCost);
    expect(s.accumulatedDepreciation).toBe(0);
    expect(s.shelves).toEqual({});
    expect(s.brand).toBe(0);
  });
});

describe('capacity and restock sizing', () => {
  it('counts units and value across lines and frees the remainder', () => {
    const store = makeStore(300, 900);
    const second = newShelfLine();
    second.lot = { quantity: quantity(100), value: money(50), received: quantity(100), issued: quantity(0) };
    store.shelves[GRAIN] = second;
    expect(shelfUnits(store)).toBe(400);
    expect(shelfValue(store)).toBe(950);
    expect(freeCapacity(store, GROCERY_FORMAT)).toBe(GROCERY_FORMAT.shelfCapacity - 400);
  });

  it('never reports negative free capacity', () => {
    const store = makeStore(GROCERY_FORMAT.shelfCapacity + 5, 10);
    expect(freeCapacity(store, GROCERY_FORMAT)).toBe(0);
  });

  it('restockQuantity is min(target gap, free room, available), floored at 0', () => {
    expect(restockQuantity(500, 100, 1000, 10_000)).toBe(400);
    expect(restockQuantity(500, 100, 150, 10_000)).toBe(150);
    expect(restockQuantity(500, 100, 1000, 70)).toBe(70);
    expect(restockQuantity(100, 500, 1000, 70)).toBe(0);
    expect(restockQuantity(500, 100, 0, 70)).toBe(0);
    expect(restockQuantity(500, 100, 1000, 0)).toBe(0);
  });
});

describe('offers', () => {
  it('follows the reference price when the line price is null, else its own price', () => {
    const store = makeStore(50, 500);
    const line = store.shelves[BREAD]!;
    expect(effectivePrice(line, money(250))).toBe(250);
    let offer = buildOffer(store, BREAD, money(250));
    expect(offer).toEqual({
      sellerId: OWNER,
      storeId: STORE_1,
      productId: BREAD,
      price: 250,
      quantity: 50,
      quality: 0,
      brand: 0,
    });
    line.price = money(300);
    offer = buildOffer(store, BREAD, money(250));
    expect(offer.price).toBe(300);
  });

  it('throws for a missing shelf line', () => {
    expect(() => buildOffer(makeStore(), GRAIN, money(10))).toThrow(/no shelf line/);
  });
});

describe('settleSale', () => {
  it('releases COGS by the allocateMoney split and tallies revenue', () => {
    const store = makeStore(7, 100);
    const line = store.shelves[BREAD]!;
    const expected = allocateMoney(money(100), [3, 4])[0]!;
    const sale = settleSale(line, quantity(3), money(250));
    expect(sale.cogs).toBe(expected);
    expect(sale.revenue).toBe(750);
    expect(line.lot.quantity).toBe(4);
    expect(line.lot.value).toBe(100 - expected);
    expect(line.lot.issued).toBe(3);
    expect(line.soldToday).toBe(3);
    expect(line.revenueToday).toBe(750);
    expect(lotInvariantErrors(line.lot)).toEqual([]);
  });

  it('selling everything releases every minor unit of value', () => {
    const line = makeStore(3, 10).shelves[BREAD]!;
    const sale = settleSale(line, quantity(3), money(5));
    expect(sale.cogs).toBe(10);
    expect(line.lot.value).toBe(0);
  });

  it('refuses to sell more than the stock', () => {
    const line = makeStore(3, 10).shelves[BREAD]!;
    expect(() => settleSale(line, quantity(4), money(5))).toThrow(/issue_exceeds_stock/);
  });

  it('resetDay clears the daily tallies only', () => {
    const line = makeStore(10, 10).shelves[BREAD]!;
    settleSale(line, quantity(2), money(5));
    line.unmetToday = quantity(4);
    resetDay(line);
    expect([line.soldToday, line.revenueToday, line.unmetToday]).toEqual([0, 0, 0]);
    expect(line.lot.issued).toBe(2);
  });
});

describe('unmetDemand', () => {
  it('is the leftover demand only when the store sold out', () => {
    expect(unmetDemand(50, 50, 120)).toBe(120);
    expect(unmetDemand(50, 50, 0)).toBe(0);
    expect(unmetDemand(50, 30, 120)).toBe(0);
  });
});

describe('shrinkage', () => {
  it('perMille 10 on stock 1000 loses 10 units and the proportional value', () => {
    const line = makeStore(1000, 250_000).shelves[BREAD]!;
    expect(shrinkageUnits(1000, 10)).toBe(10);
    const { lost, cost } = applyShrinkage(line, 10);
    expect(lost).toBe(10);
    expect(cost).toBe(allocateMoney(money(250_000), [10, 990])[0]);
    expect(cost).toBe(2_500);
    expect(line.lot.quantity).toBe(990);
    expect(line.lot.value).toBe(247_500);
    expect(line.shrunk).toBe(10);
    expect(line.lot.issued).toBe(10);
  });

  it('loses nothing when floor(stock x perMille / 1000) is 0', () => {
    const line = makeStore(99, 990).shelves[BREAD]!;
    expect(applyShrinkage(line, 10)).toEqual({ lost: 0, cost: 0 });
    expect(line.lot.quantity).toBe(99);
    expect(applyShrinkage(line, 0)).toEqual({ lost: 0, cost: 0 });
  });
});

describe('depreciationCharge', () => {
  it('sums exactly to cost over usefulLifeMonths and then stops', () => {
    for (const [cost, life] of [
      [1000, 7],
      [2_000_000, 120],
      [999_999, 13],
      [5, 12],
      [1000, 12],
    ] as const) {
      let accumulated = money(0);
      let charges = 0;
      for (let m = 0; m < life + 5; m += 1) {
        const c = depreciationCharge(money(cost), accumulated, life);
        expect(c).toBeGreaterThanOrEqual(0);
        if (c > 0) charges += 1;
        accumulated = money(accumulated + c);
      }
      expect(accumulated).toBe(cost);
      expect(charges).toBeLessThanOrEqual(life);
    }
  });

  it('is zero for a free or fully depreciated store', () => {
    expect(depreciationCharge(money(0), money(0), 12)).toBe(0);
    expect(depreciationCharge(money(100), money(100), 12)).toBe(0);
  });
});
