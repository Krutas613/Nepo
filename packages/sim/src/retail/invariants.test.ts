import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../accounting/index.js';
import { M1_CONTENT_PACK, quantity, money } from '../schema/index.js';
import { checkRetailInvariants, ppeOfStores } from './invariants.js';
import { BREAD, OWNER, STORE_1, makeStore } from './test-helpers.js';
import { newWorld, seedStore } from './test-world.js';

const content = M1_CONTENT_PACK;
const codes = (w: ReturnType<typeof newWorld>) =>
  checkRetailInvariants(w.state, content).map((v) => v.code);

describe('checkRetailInvariants', () => {
  it('is clean for an empty world and for a consistent seeded store', () => {
    const w = newWorld();
    expect(codes(w)).toEqual([]);
    seedStore(w, { stock: 100, value: 12_345 });
    expect(codes(w)).toEqual([]);
  });

  it('flags a shelf/ledger mismatch', () => {
    const w = newWorld();
    seedStore(w, { stock: 100, value: 12_345 });
    const lot = w.state.retail.stores[STORE_1]?.shelves[BREAD]?.lot;
    if (lot === undefined) throw new Error('no lot');
    lot.value = money(lot.value + 1);
    expect(codes(w)).toEqual(['shelf.value_mismatch']);
  });

  it('flags a ledger balance without stores', () => {
    const w = newWorld();
    seedStore(w, { stock: 10, value: 100 });
    Reflect.deleteProperty(w.state.retail.stores, STORE_1);
    expect(codes(w)).toEqual(['shelf.value_mismatch']);
  });

  it('flags broken lots, capacity, price, targets, depreciation and counters', () => {
    const w = newWorld();
    const store = makeStore(2000, 0);
    w.state.retail.stores[STORE_1] = store;
    const line = store.shelves[BREAD];
    if (line === undefined) throw new Error('no line');
    line.lot.value = money(-1);
    line.price = 0 as never;
    line.restock.targetStock = quantity(5000);
    line.shrunk = quantity(9);
    line.soldToday = quantity(3000);
    store.accumulatedDepreciation = money(store.cost + 1);
    const found = new Set(codes(w));
    for (const code of [
      'lot.invalid',
      'shelf.exceeds_capacity',
      'shelf.price_invalid',
      'shelf.restock_target_exceeds_capacity',
      'shelf.shrunk_exceeds_issued',
      'shelf.sold_exceeds_received',
      'store.depreciation_out_of_range',
      'shelf.value_mismatch',
    ]) {
      expect(found.has(code as never)).toBe(true);
    }
  });

  it('skips capacity checks without content and flags an unknown format with it', () => {
    const w = newWorld();
    w.state.retail.stores[STORE_1] = makeStore(5000, 0, { formatId: 'mystery' as never });
    expect(checkRetailInvariants(w.state).map((v) => v.code)).toEqual([]);
    expect(codes(w)).toContain('store.unknown_format');
  });

  it('ppeOfStores sums the owner’s store records', () => {
    const w = newWorld();
    w.state.retail.stores[STORE_1] = makeStore(0, 0, {
      cost: money(100),
      accumulatedDepreciation: money(10),
    });
    w.state.retail.stores['st_000002' as never] = makeStore(0, 0, {
      id: 'st_000002' as never,
      cost: money(50),
      accumulatedDepreciation: money(5),
    });
    expect(ppeOfStores(w.state, OWNER)).toEqual({ cost: 150, accumulatedDepreciation: 15 });
    expect(ppeOfStores(w.state, 'co_000002' as never)).toEqual({
      cost: 0,
      accumulatedDepreciation: 0,
    });
    expect(ACCOUNTS.INVENTORY_MERCHANDISE).toBe('a1230');
  });
});
