/**
 * Integration with the real engine, accounting, economy and manufacturing (retail.md sections 4-6, 10).
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, allocateMoney, checkLedgerInvariants } from '../accounting/index.js';
import {
  createWorld,
  hashState,
  restore,
  snapshot,
  step,
  type System,
  type World,
} from '../engine/index.js';
import { newFacility } from '../manufacturing/index.js';
import {
  M1_CONTENT_PACK,
  facilityId,
  facilityTypeId,
  money,
  quantity,
  type Event,
  type Facility,
  type StoreFormat,
} from '../schema/index.js';
import { checkRetailInvariants } from './invariants.js';
import { RETAIL_SERVICE, type RetailApi } from './service.js';
import {
  BREAD,
  FACILITY_1,
  GRAIN,
  GROCERY,
  OTHER,
  OWNER,
  SPRINGFIELD,
  STORE_1,
} from './test-helpers.js';
import {
  SYSTEMS,
  balance,
  newWorld,
  post,
  run,
  scenarioOf,
  seedStore,
  send,
} from './test-world.js';
import { makeJournalEntry, dr, cr } from '../accounting/index.js';

const of = <T extends Event['type']>(events: readonly Event[], type: T) =>
  events.filter((e): e is Extract<Event, { type: T }> => e.type === type);

const rejections = (events: readonly Event[]) =>
  of(events, 'command.rejected').map((e) => e.payload.code);

function violations(world: World) {
  return checkRetailInvariants(world.state, world.scenario.content);
}

// ---------------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------------

describe('store.build', () => {
  it('posts one capex entry, issues an id, counts down and opens', () => {
    const world = newWorld();
    const cash0 = balance(world, ACCOUNTS.CASH);
    const journal0 = world.state.accounting.journal.length;
    send(world, {
      type: 'store.build',
      issuer: OWNER,
      payload: { companyId: OWNER, storeFormatId: GROCERY, cityId: SPRINGFIELD },
    });
    const events = run(world, 1);
    const format = M1_CONTENT_PACK.storeFormats[GROCERY] as StoreFormat;
    const store = world.state.retail.stores[STORE_1];
    expect(store?.status).toBe('under_construction');
    expect(store?.completesTick).toBe(format.constructionTicks);
    expect(store?.cost).toBe(format.buildCost);
    expect(of(events, 'store.ordered')).toHaveLength(1);
    expect(balance(world, ACCOUNTS.CASH)).toBe(cash0 - format.buildCost);
    expect(balance(world, ACCOUNTS.PPE)).toBe(format.buildCost);
    const entries = world.state.accounting.journal
      .slice(journal0)
      .filter((j) => j.source === 'retail');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ref).toEqual({ kind: 'store', id: STORE_1 });
    // No opex, no depreciation while under construction; opens at completesTick.
    expect(balance(world, ACCOUNTS.OPEX_FACILITY)).toBe(0);
    const later = run(world, format.constructionTicks);
    expect(of(later, 'store.opened').map((e) => e.tick)).toEqual([format.constructionTicks]);
    expect(world.state.retail.stores[STORE_1]?.status).toBe('operating');
  });

  it('rejects with the documented codes and posts nothing', () => {
    const world = newWorld(scenarioOf({ cash: 1_000, rival: true }));
    const journal0 = world.state.accounting.journal.length;
    const build = (issuer: typeof OWNER, companyId: typeof OWNER, format: string, city: string) =>
      send(world, {
        type: 'store.build',
        issuer,
        payload: { companyId, storeFormatId: format as never, cityId: city as never },
      });
    build(OWNER, OTHER, 'grocery', 'springfield');
    build(OWNER, OWNER, 'nope', 'springfield');
    build(OWNER, OWNER, 'grocery', 'nowhere');
    build(OWNER, OWNER, 'grocery', 'springfield');
    expect(rejections(run(world, 1))).toEqual([
      'not_owner',
      'unknown_store_format',
      'unknown_city',
      'insufficient_cash',
    ]);
    expect(Object.keys(world.state.retail.stores)).toEqual([]);
    expect(world.state.accounting.journal.length).toBe(journal0);
  });
});

describe('store.set_price and store.set_restock_policy', () => {
  function worldWithStore() {
    const world = newWorld(scenarioOf({ rival: true }));
    send(world, {
      type: 'store.build',
      issuer: OWNER,
      payload: { companyId: OWNER, storeFormatId: GROCERY, cityId: SPRINGFIELD },
    });
    send(world, {
      type: 'facility.build',
      issuer: OWNER,
      payload: { companyId: OWNER, facilityTypeId: facilityTypeId('bakery'), cityId: SPRINGFIELD },
    });
    send(world, {
      type: 'facility.build',
      issuer: OTHER,
      payload: { companyId: OTHER, facilityTypeId: facilityTypeId('bakery'), cityId: SPRINGFIELD },
    });
    run(world, 1);
    return world;
  }

  it('creates the shelf line, sets price and policy, emits events', () => {
    const world = worldWithStore();
    send(world, {
      type: 'store.set_price',
      issuer: OWNER,
      payload: { storeId: STORE_1, productId: BREAD, price: money(300) },
    });
    send(world, {
      type: 'store.set_restock_policy',
      issuer: OWNER,
      payload: {
        storeId: STORE_1,
        productId: BREAD,
        sourceFacilityId: FACILITY_1,
        targetStock: quantity(200),
      },
    });
    const events = run(world, 1);
    const line = world.state.retail.stores[STORE_1]?.shelves[BREAD];
    expect(line?.price).toBe(300);
    expect(line?.restock).toEqual({ sourceFacilityId: FACILITY_1, targetStock: 200 });
    expect(of(events, 'store.price_set')).toHaveLength(1);
    expect(of(events, 'store.restock_policy_set')).toHaveLength(1);
    send(world, {
      type: 'store.set_price',
      issuer: OWNER,
      payload: { storeId: STORE_1, productId: BREAD, price: null },
    });
    run(world, 1);
    expect(world.state.retail.stores[STORE_1]?.shelves[BREAD]?.price).toBeNull();
  });

  it('rejects with every documented code', () => {
    const world = worldWithStore();
    const cap = (M1_CONTENT_PACK.storeFormats[GROCERY] as StoreFormat).shelfCapacity;
    const price = (
      issuer: typeof OWNER,
      storeId: string,
      productId: typeof BREAD,
      p: number | null,
    ) =>
      send(world, {
        type: 'store.set_price',
        issuer,
        payload: { storeId: storeId as never, productId, price: p === null ? null : money(p) },
      });
    const policy = (
      issuer: typeof OWNER,
      productId: typeof BREAD,
      src: string | null,
      target: number,
    ) =>
      send(world, {
        type: 'store.set_restock_policy',
        issuer,
        payload: {
          storeId: STORE_1,
          productId,
          sourceFacilityId: src as never,
          targetStock: quantity(target),
        },
      });
    price(OWNER, 'st_999999', BREAD, 1);
    price(OTHER, STORE_1, BREAD, 1);
    price(OWNER, STORE_1, 'nope' as never, 1);
    price(OWNER, STORE_1, GRAIN, 1);
    price(OWNER, STORE_1, BREAD, 0);
    policy(OTHER, BREAD, null, 1);
    policy(OWNER, GRAIN, null, 1);
    policy(OWNER, BREAD, 'fa_999999', 1);
    policy(OWNER, BREAD, 'fa_000002', 1);
    policy(OWNER, BREAD, 'fa_000001', cap + 1);
    expect(rejections(run(world, 1))).toEqual([
      'unknown_store',
      'not_owner',
      'unknown_product',
      'category_not_allowed',
      'invalid_price',
      'not_owner',
      'category_not_allowed',
      'unknown_facility',
      'facility_not_owner',
      'target_exceeds_capacity',
    ]);
    expect(world.state.retail.stores[STORE_1]?.shelves).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------
// sales (economy real, shelf seeded)
// ---------------------------------------------------------------------------------------------

describe('sales against the real economy', () => {
  function soldAt(price: number | null, stock = 1000) {
    const world = newWorld();
    seedStore(world, { stock, value: stock * 100, price });
    const events = run(world, 1);
    return { world, events, sold: of(events, 'store.sold')[0] };
  }

  it('at the reference price sells min(stock, demand) and posts one retailSale', () => {
    const journal0 = newWorld().state.accounting.journal.length;
    const { world, events, sold } = soldAt(null);
    expect(sold?.payload.quantity).toBe(400);
    expect(sold?.payload.price).toBe(sold?.payload.referencePrice);
    expect(sold?.payload.revenue).toBe(400 * (sold?.payload.price ?? 0));
    expect(sold?.payload.cogs).toBe(allocateMoney(money(100_000), [400, 600])[0]);
    // Debit-normal signed balances: income accounts are negative.
    expect(balance(world, ACCOUNTS.SALES)).toBe(-(sold?.payload.revenue ?? 0));
    expect(balance(world, ACCOUNTS.COGS)).toBe(sold?.payload.cogs);
    expect(of(events, 'store.sold')).toHaveLength(1);
    const sales = world.state.accounting.journal.filter((j) => j.memo === 'Retail sale');
    expect(sales).toHaveLength(1);
    expect(world.state.accounting.journal.length).toBeGreaterThan(journal0);
    const line = world.state.retail.stores[STORE_1]?.shelves[BREAD];
    expect([line?.soldToday, line?.revenueToday]).toEqual([400, sold?.payload.revenue]);
    expect(line?.lot.quantity).toBe(600);
    expect(balance(world, ACCOUNTS.INVENTORY_MERCHANDISE)).toBe(line?.lot.value);
    expect(violations(world)).toEqual([]);
  });

  it('a price at 1 + 1/epsilon of reference sells nothing; a cheaper price sells more', () => {
    const atRef = soldAt(null).sold?.payload.quantity ?? 0;
    const cheap = soldAt(200, 2000 > 1000 ? 1000 : 1000).sold?.payload.quantity ?? 0;
    expect(cheap).toBeGreaterThan(atRef);
    const dear = soldAt(417);
    expect(dear.sold).toBeUndefined();
    expect(of(dear.events, 'store.sold')).toHaveLength(0);
    expect(dear.world.state.retail.stores[STORE_1]?.shelves[BREAD]?.lot.quantity).toBe(1000);
  });

  it('stock below demand sells out, flags the stockout and records unmet demand', () => {
    const { world, sold } = soldAt(null, 100);
    expect(sold?.payload.quantity).toBe(100);
    expect(sold?.payload.stockout).toBe(true);
    expect(sold?.payload.cogs).toBe(10_000);
    const line = world.state.retail.stores[STORE_1]?.shelves[BREAD];
    expect(line?.unmetToday).toBeGreaterThan(0);
    expect(line?.lot.value).toBe(0);
    expect(balance(world, ACCOUNTS.INVENTORY_MERCHANDISE)).toBe(0);
  });

  it('stock above demand does not flag a stockout', () => {
    const { sold, world } = soldAt(null, 1000);
    expect(sold?.payload.stockout).toBe(false);
    expect(world.state.retail.stores[STORE_1]?.shelves[BREAD]?.unmetToday).toBe(0);
  });

  it('posts the daily operating cost and, at month end, depreciation to the exact cost', () => {
    const world = newWorld();
    seedStore(world, { stock: 0, value: 0 });
    const format = M1_CONTENT_PACK.storeFormats[GROCERY] as StoreFormat;
    run(world, 30);
    expect(balance(world, ACCOUNTS.OPEX_FACILITY)).toBe(format.dailyOperatingCost * 30);
    const store = world.state.retail.stores[STORE_1];
    expect(store?.accumulatedDepreciation).toBeGreaterThan(0);
    expect(balance(world, ACCOUNTS.ACCUM_DEPRECIATION)).toBe(
      -(store?.accumulatedDepreciation ?? 0),
    );
  });

  it('shrinkage writes off the proportional value (perMille 10, stock 1000)', () => {
    const world = newWorld({
      ...scenarioOf(),
      content: {
        ...M1_CONTENT_PACK,
        storeFormats: {
          [GROCERY]: {
            ...(M1_CONTENT_PACK.storeFormats[GROCERY] as StoreFormat),
            shrinkagePerMille: 10,
          },
        },
      },
    } as never);
    seedStore(world, { stock: 1000, value: 250_000, price: 100_000 });
    run(world, 1);
    const line = world.state.retail.stores[STORE_1]?.shelves[BREAD];
    expect(line?.lot.quantity).toBe(990);
    expect(line?.shrunk).toBe(10);
    expect(line?.lot.value).toBe(247_500);
    expect(balance(world, ACCOUNTS.OPEX_OTHER)).toBe(2_500);
    expect(balance(world, ACCOUNTS.INVENTORY_MERCHANDISE)).toBe(247_500);
    expect(violations(world)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// restock from a real manufacturing facility
// ---------------------------------------------------------------------------------------------

function seedFacility(world: World, units: number, value: number): Facility {
  const type = M1_CONTENT_PACK.facilityTypes[facilityTypeId('bakery')];
  if (type === undefined) throw new Error('no bakery');
  const f = newFacility({
    id: FACILITY_1,
    ownerId: OWNER,
    type,
    cityId: SPRINGFIELD,
    orderedTick: 0,
  });
  f.status = 'operating';
  f.outputs[BREAD] = {
    quantity: quantity(units),
    value: money(value),
    received: quantity(units),
    issued: quantity(0),
  };
  world.state.manufacturing.facilities[FACILITY_1] = f;
  post(
    world,
    OWNER,
    makeJournalEntry(
      [dr(ACCOUNTS.INVENTORY_FINISHED, money(value)), cr(ACCOUNTS.CASH, money(value))],
      'manufacturing',
      'Seed',
    ),
  );
  return f;
}

describe('restock (ADR-013)', () => {
  it('pulls from the factory at transfer cost, then sells from the refilled shelf', () => {
    const world = newWorld();
    seedStore(world, { stock: 0, value: 0 });
    seedFacility(world, 1000, 123_457);
    const line = world.state.retail.stores[STORE_1]?.shelves[BREAD];
    if (line === undefined) throw new Error('no line');
    line.restock = { sourceFacilityId: FACILITY_1, targetStock: quantity(600) };
    const finished0 = balance(world, ACCOUNTS.INVENTORY_FINISHED);
    const events = run(world, 1);

    const transfer = allocateMoney(money(123_457), [600, 400])[0] ?? 0;
    const restocked = of(events, 'store.restocked')[0];
    expect(restocked?.payload).toMatchObject({
      storeId: STORE_1,
      facilityId: FACILITY_1,
      quantity: 600,
      cost: transfer,
    });
    const sold = of(events, 'store.sold')[0];
    expect(sold?.payload.quantity).toBe(400);
    expect(sold?.payload.cogs).toBe(allocateMoney(money(transfer), [400, 200])[0]);
    expect(line.lot.quantity).toBe(200);
    expect(line.lot.value).toBe(transfer - (sold?.payload.cogs ?? 0));
    expect(line.lot.received).toBe(600);
    expect(balance(world, ACCOUNTS.INVENTORY_MERCHANDISE)).toBe(line.lot.value);
    expect(balance(world, ACCOUNTS.INVENTORY_FINISHED)).toBe(finished0 - transfer);
    expect(world.state.manufacturing.facilities[FACILITY_1]?.outputs[BREAD]?.quantity).toBe(400);
    expect(violations(world)).toEqual([]);
  });

  it('is limited by shelf capacity and by what the factory has', () => {
    const world = newWorld();
    seedStore(world, { stock: 0, value: 0 });
    seedFacility(world, 50, 5_000);
    const line = world.state.retail.stores[STORE_1]?.shelves[BREAD];
    if (line === undefined) throw new Error('no line');
    line.restock = { sourceFacilityId: FACILITY_1, targetStock: quantity(1000) };
    run(world, 1);
    expect(line.lot.received).toBe(50);
    expect(world.state.manufacturing.facilities[FACILITY_1]?.outputs[BREAD]?.quantity).toBe(0);
    expect(world.state.manufacturing.facilities[FACILITY_1]?.outputs[BREAD]?.value).toBe(0);
  });

  it('drops a vanished or foreign source and emits restock_failed', () => {
    const world = newWorld(scenarioOf({ rival: true }));
    seedStore(world, { stock: 0, value: 0 });
    const line = world.state.retail.stores[STORE_1]?.shelves[BREAD];
    if (line === undefined) throw new Error('no line');
    line.restock = { sourceFacilityId: facilityId('fa_000077'), targetStock: quantity(10) };
    // availableOutput of an unknown facility is 0, so nothing is withdrawn and the policy stays;
    // a facility that changed hands is detected on withdraw.
    const f = seedFacility(world, 100, 1_000);
    f.ownerId = OTHER;
    line.restock = { sourceFacilityId: FACILITY_1, targetStock: quantity(10) };
    const events = run(world, 1);
    expect(of(events, 'store.restock_failed').map((e) => e.payload.code)).toEqual(['not_owner']);
    expect(line.restock.sourceFacilityId).toBeNull();
    expect(line.lot.quantity).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// RetailApi
// ---------------------------------------------------------------------------------------------

/** A throwaway `ai` system that captures the retail service during `decide`. */
function worldWithApi(): { world: World; api: () => RetailApi } {
  let api: RetailApi | null = null;
  const probe: System<Record<string, never>> = {
    id: 'ai',
    handles: [],
    init: () => ({}),
    phases: {
      decide(ctx) {
        api = ctx.services.get(RETAIL_SERVICE);
      },
    },
  };
  const world = createWorld({ seed: 1, scenario: scenarioOf(), systems: [...SYSTEMS, probe] });
  return {
    world,
    api: () => {
      if (api === null) throw new Error('service not captured yet');
      return api;
    },
  };
}

describe('RetailApi service', () => {
  it('answers reads', () => {
    const { world, api } = worldWithApi();
    seedStore(world, { stock: 1000, value: 100_000 });
    run(world, 1);
    expect(api().storesOf(OWNER)).toEqual([STORE_1]);
    expect(api().storesOf(OWNER, SPRINGFIELD)).toEqual([STORE_1]);
    expect(api().storesOf(OWNER, 'elsewhere' as never)).toEqual([]);
    expect(api().storesOf(OTHER)).toEqual([]);
    expect(api().store(STORE_1)?.id).toBe(STORE_1);
    expect(api().store('st_000042' as never)).toBeNull();
    expect(api().shelfQuantity(STORE_1, BREAD)).toBe(600);
    expect(api().shelfQuantity(STORE_1, GRAIN)).toBe(0);
    expect(api().shelfQuantity('st_000042' as never, BREAD)).toBe(0);
  });

  it('receive lands goods, posts nothing and respects capacity (M2 logistics path)', () => {
    const { world, api } = worldWithApi();
    seedStore(world, { stock: 1000, value: 100_000 });
    run(world, 1); // 600 left on the shelf, 400 free
    const source = { kind: 'shipment', id: 'sh_000001' } as const;
    const journal0 = world.state.accounting.journal.length;
    const rcv = (id: string, p: typeof BREAD, q: number, c: number) =>
      api().receive(id as never, p, quantity(q), money(c), source);

    expect(rcv('st_000042', BREAD, 1, 1)).toMatchObject({
      ok: false,
      error: { code: 'unknown_store' },
    });
    expect(rcv(STORE_1, GRAIN, 1, 1)).toMatchObject({
      ok: false,
      error: { code: 'no_shelf_line' },
    });
    expect(rcv(STORE_1, BREAD, 401, 1)).toMatchObject({
      ok: false,
      error: { code: 'over_capacity' },
    });
    expect(api().shelfQuantity(STORE_1, BREAD)).toBe(600);

    // The caller books the credit side (logistics: Dr 1230 / Cr 1220); here Dr 1230 / Cr cash.
    post(
      world,
      OWNER,
      makeJournalEntry(
        [dr(ACCOUNTS.INVENTORY_MERCHANDISE, money(4_000)), cr(ACCOUNTS.CASH, money(4_000))],
        'logistics',
        'Landing',
      ),
    );
    const ok = rcv(STORE_1, BREAD, 400, 4_000);
    expect(ok).toEqual({ ok: true, value: 400 });
    expect(api().shelfQuantity(STORE_1, BREAD)).toBe(1000);
    const line = world.state.retail.stores[STORE_1]?.shelves[BREAD];
    expect(line?.lot.received).toBe(1400);
    expect(world.state.accounting.journal.length).toBe(journal0 + 1); // only the test's own entry
    expect(violations(world)).toEqual([]);
  });

  it('receive refuses a store still under construction', () => {
    const { world, api } = worldWithApi();
    seedStore(world, { stock: 0, value: 0 });
    const store = world.state.retail.stores[STORE_1];
    if (store === undefined) throw new Error('no store');
    store.status = 'under_construction';
    store.completesTick = 99;
    run(world, 1);
    expect(
      api().receive(STORE_1, BREAD, quantity(1), money(1), { kind: 'facility', id: 'fa_000001' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'not_operating' },
    });
  });
});
