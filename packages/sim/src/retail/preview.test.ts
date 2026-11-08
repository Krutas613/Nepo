import { describe, expect, it } from 'vitest';
import { allocateMoney } from '../accounting/index.js';
import { money, quantity } from '../schema/index.js';
import { shelfUnitCost, storeDayPreview, storeSummary } from './preview.js';
import { BREAD, GRAIN, GROCERY_FORMAT, STORE_1, makeStore } from './test-helpers.js';
import { newShelfLine } from './store.js';

describe('preview helpers', () => {
  it('shelfUnitCost is value / quantity, null when empty', () => {
    expect(shelfUnitCost(makeStore(4, 10).shelves[BREAD]!.lot)).toBe(2.5);
    expect(shelfUnitCost(makeStore(0, 0).shelves[BREAD]!.lot)).toBeNull();
  });

  it('storeSummary derives totals, ticks to open and effective prices', () => {
    const store = makeStore(40, 400, { status: 'under_construction', completesTick: 9 });
    store.shelves[GRAIN] = newShelfLine();
    const line = store.shelves[BREAD]!;
    line.soldToday = quantity(5);
    line.revenueToday = money(1250);
    line.unmetToday = quantity(2);
    const s = storeSummary(store, GROCERY_FORMAT, 4, { [BREAD]: money(250) });
    expect(s).toMatchObject({
      storeId: STORE_1,
      status: 'under_construction',
      ticksToOpen: 5,
      unitsOnShelves: 40,
      shelfCapacity: GROCERY_FORMAT.shelfCapacity,
      inventoryValue: 400,
      revenueToday: 1250,
    });
    expect(s.lines.map((l) => l.productId)).toEqual([BREAD, GRAIN]);
    expect(s.lines[0]).toMatchObject({
      unitCost: 10,
      effectivePrice: 250,
      stockout: true,
      price: null,
    });
    expect(s.lines[1]).toMatchObject({ unitCost: null, effectivePrice: null, stockout: false });
    expect(storeSummary({ ...store, status: 'operating' }, GROCERY_FORMAT, 4).ticksToOpen).toBe(0);
  });

  it('storeDayPreview mirrors the sale: demand-limited vs stock-limited', () => {
    const lot = makeStore(100, 1000).shelves[BREAD]!.lot;
    const demandLimited = storeDayPreview(lot, money(30), 40);
    expect(demandLimited).toMatchObject({ units: 40, revenue: 1200, stockLimited: false });
    expect(demandLimited.cogs).toBe(allocateMoney(money(1000), [40, 60])[0]);
    expect(demandLimited.grossProfit).toBe(1200 - demandLimited.cogs);
    const stockLimited = storeDayPreview(lot, money(30), 400);
    expect(stockLimited).toMatchObject({ units: 100, cogs: 1000, stockLimited: true });
    const none = storeDayPreview(lot, money(30), 0);
    expect(none).toMatchObject({ units: 0, revenue: 0, cogs: 0, marginPct: null });
  });
});
