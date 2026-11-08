/**
 * End-to-end on `VERTICAL_SLICE_SCENARIO` with the real engine, accounting, economy, manufacturing and
 * retail: build a factory and a store, run 120 ticks, and check sales, postings, reconciliation and
 * determinism.
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, checkLedgerInvariants } from '../accounting/index.js';
import { hashState, restore, snapshot, step, type World } from '../engine/index.js';
import { checkManufacturingInvariants } from '../manufacturing/index.js';
import {
  M1_CONTENT_PACK,
  facilityTypeId,
  quantity,
  recipeId,
  type Event,
} from '../schema/index.js';
import { checkRetailInvariants, ppeOfStores } from './invariants.js';
import { shelfValue } from './store.js';
import { BREAD, FACILITY_1, GROCERY, OWNER, SPRINGFIELD, STORE_1 } from './test-helpers.js';
import { SYSTEMS, balance, newWorld, run, send } from './test-world.js';

const TICKS = 120;

function script(world: World): void {
  send(world, {
    type: 'facility.build',
    issuer: OWNER,
    payload: { companyId: OWNER, facilityTypeId: facilityTypeId('bakery'), cityId: SPRINGFIELD },
  });
  send(world, {
    type: 'store.build',
    issuer: OWNER,
    payload: { companyId: OWNER, storeFormatId: GROCERY, cityId: SPRINGFIELD },
  });
  send(world, {
    type: 'facility.set_recipe',
    issuer: OWNER,
    payload: { facilityId: FACILITY_1, recipeId: recipeId('bake_bread') },
  });
  send(world, {
    type: 'facility.set_production',
    issuer: OWNER,
    payload: { facilityId: FACILITY_1, targetBatches: quantity(5) },
  });
  send(world, {
    type: 'store.set_restock_policy',
    issuer: OWNER,
    payload: {
      storeId: STORE_1,
      productId: BREAD,
      sourceFacilityId: FACILITY_1,
      targetStock: quantity(500),
    },
  });
  send(world, {
    type: 'store.set_price',
    issuer: OWNER,
    payload: { storeId: STORE_1, productId: BREAD, price: null },
  });
}

function check(world: World): void {
  expect(checkRetailInvariants(world.state, world.scenario.content)).toEqual([]);
  expect(checkManufacturingInvariants(world.state)).toEqual([]);
  expect(checkLedgerInvariants(world.state.accounting)).toEqual([]);
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  return xs.reduce((a, x) => a + f(x), 0);
}

describe('vertical slice: factory + store, 120 ticks', () => {
  const world = newWorld();
  script(world);
  const events: Event[] = [];
  const cashSeries: number[] = [];
  for (let t = 0; t < TICKS; t += 1) {
    events.push(...run(world, 1));
    check(world);
    cashSeries.push(balance(world, ACCOUNTS.CASH));
  }
  const sold = events.filter((e) => e.type === 'store.sold');
  const restocked = events.filter((e) => e.type === 'store.restocked');
  const store = world.state.retail.stores[STORE_1];
  const format = M1_CONTENT_PACK.storeFormats[GROCERY]!;

  it('rejects nothing and opens the store after its construction', () => {
    expect(events.filter((e) => e.type === 'command.rejected')).toEqual([]);
    const opened = events.filter((e) => e.type === 'store.opened');
    expect(opened.map((e) => e.tick)).toEqual([format.constructionTicks]);
    expect(store?.status).toBe('operating');
  });

  it('sells, with revenue and COGS posted through accounting', () => {
    expect(sold.length).toBeGreaterThan(20);
    expect(restocked.length).toBeGreaterThan(20);
    const revenue = sum(sold, (e) => e.payload.revenue);
    const cogs = sum(sold, (e) => e.payload.cogs);
    expect(revenue).toBeGreaterThan(0);
    expect(balance(world, ACCOUNTS.SALES)).toBe(-revenue);
    expect(balance(world, ACCOUNTS.COGS)).toBe(cogs);
    for (const e of sold) {
      expect(e.payload.revenue).toBe(e.payload.price * e.payload.quantity);
      expect(e.payload.price).toBe(e.payload.referencePrice); // price: null follows the market
    }
  });

  it('keeps goods and value conserved from factory to till', () => {
    const line = store?.shelves[BREAD];
    const transferred = sum(restocked, (e) => e.payload.cost);
    const units = sum(restocked, (e) => e.payload.quantity);
    const unitsSold = sum(sold, (e) => e.payload.quantity);
    const cogs = sum(sold, (e) => e.payload.cogs);
    expect(line?.lot.received).toBe(units);
    expect(line?.lot.issued).toBe(unitsSold);
    expect(units - unitsSold).toBe(line?.lot.quantity);
    expect(transferred).toBe(cogs + (line?.lot.value ?? 0));
    expect(balance(world, ACCOUNTS.INVENTORY_MERCHANDISE)).toBe(
      store === undefined ? 0 : shelfValue(store),
    );
  });

  it('posts store opex and depreciation on the right days', () => {
    const open = format.constructionTicks;
    const opex = world.state.accounting.journal
      .filter((j) => j.source === 'retail' && j.memo === 'Store operating cost')
      .reduce((a, j) => a + (j.lines[0]?.debit ?? 0), 0);
    expect(opex).toBe((TICKS - open) * format.dailyOperatingCost);
    // Month ends at ticks 29, 59, 89, 119: four charges of ceil(cost / life).
    const charge = Math.ceil(format.buildCost / format.usefulLifeMonths);
    expect(store?.accumulatedDepreciation).toBe(4 * charge);
    const ppe = ppeOfStores(world.state, OWNER);
    expect(ppe.cost).toBe(format.buildCost);
    expect(ppe.accumulatedDepreciation).toBe(4 * charge);
  });

  it('keeps cash flows coherent', () => {
    const factoryCapex = M1_CONTENT_PACK.facilityTypes[facilityTypeId('bakery')]?.buildCost ?? 0;
    expect(balance(world, ACCOUNTS.PPE)).toBe(format.buildCost + factoryCapex);
    // Every entry balanced and cash is the sum of its journal lines.
    const cash = world.state.accounting.journal
      .filter((j) => j.entityId === OWNER)
      .reduce(
        (a, j) =>
          a +
          sum(
            j.lines.filter((l) => l.account === ACCOUNTS.CASH),
            (l) => l.debit - l.credit,
          ),
        0,
      );
    expect(cash).toBe(balance(world, ACCOUNTS.CASH));
    expect(balance(world, ACCOUNTS.CASH)).toBeGreaterThan(0);
    // Trading is cash-positive once the store is selling: the last month's cash change is > 0.
    expect(cashSeries[TICKS - 1] ?? 0).toBeGreaterThan(cashSeries[TICKS - 31] ?? 0);
  });
});

describe('determinism and snapshots', () => {
  it('two runs with the same seed and commands hash identically at every checkpoint', () => {
    const a = newWorld();
    const b = newWorld();
    script(a);
    script(b);
    for (let t = 0; t < TICKS; t += 1) {
      step(a);
      step(b);
      if (t % 20 === 19) expect(hashState(a.state)).toBe(hashState(b.state));
    }
    expect(hashState(a.state)).toBe(hashState(b.state));
  });

  it('snapshot and restore mid-run continue identically', () => {
    const a = newWorld();
    script(a);
    run(a, 60);
    const restored = restore(snapshot(a), SYSTEMS);
    expect(hashState(restored.state)).toBe(hashState(a.state));
    run(a, 60);
    run(restored, 60);
    expect(hashState(restored.state)).toBe(hashState(a.state));
    expect(checkRetailInvariants(restored.state, restored.scenario.content)).toEqual([]);
  });
});
