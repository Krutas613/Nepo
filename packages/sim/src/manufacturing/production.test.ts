import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../accounting/index.js';
import {
  M1_CONTENT_PACK,
  money,
  quantity,
  recipeId,
  type ContentPack,
  type EventInput,
  type Facility,
  type WipBatch,
} from '../schema/index.js';
import { newFacility } from './facility.js';
import { checkManufacturingInvariants } from './invariants.js';
import { emptyLot, lotFor, receiveIntoLot } from './lots.js';
import { insertWip, runFacilityDay, chargeDepreciation } from './production.js';
import {
  BAKE_BREAD,
  BAKERY,
  BREAD,
  FAC,
  GRAIN,
  PLAYER,
  SPRINGFIELD,
  contentWith,
  makeHarness,
  operatingBakery,
  runDays,
  stateOf,
  type Harness,
} from './test-helpers.js';

const types = (h: Harness) => h.events.map((e) => e.type);
const starved = (h: Harness) =>
  h.events.filter(
    (e): e is Extract<EventInput, { type: 'production.starved' }> =>
      e.type === 'production.starved',
  );

/** All invariants, including the ledger reconciliation of 1200 / 1205 / 1210. */
const violations = (h: Harness, f: Facility) =>
  checkManufacturingInvariants(
    { tick: h.tick, manufacturing: stateOf(f), accounting: h.acct },
    h.content,
  );

describe('construction', () => {
  it('constructionTicks = 3: operating on the 4th tick; no opex or depreciation before', () => {
    const h = makeHarness({ content: contentWith({ constructionTicks: 3 }) });
    const type = h.content.facilityTypes[BAKERY]!;
    const f = newFacility({ id: FAC, ownerId: PLAYER, type, cityId: SPRINGFIELD, orderedTick: 0 });
    f.recipeId = BAKE_BREAD;
    f.targetBatches = quantity(1);
    const cashBefore = h.cash();
    for (let t = 0; t < 3; t++) {
      h.tick = t;
      h.isMonthEnd = true; // would depreciate if it were operating
      runFacilityDay(f, h.prodEnv());
      expect(f.status).toBe('under_construction');
      expect(h.cash()).toBe(cashBefore);
      expect(h.events).toEqual([]);
    }
    h.tick = 3;
    h.isMonthEnd = true;
    runFacilityDay(f, h.prodEnv());
    expect(f.status).toBe('operating');
    expect(types(h)[0]).toBe('facility.completed');
    // opex, depreciation and the first batch all happen on the completion day
    expect(h.balance(ACCOUNTS.OPEX_FACILITY)).toBe(20_000);
    expect(f.accumulatedDepreciation).toBe(41_667);
    expect(f.wip).toHaveLength(1);
  });

  it('constructionTicks = 0 operates in the same tick', () => {
    const h = makeHarness({ content: contentWith({ constructionTicks: 0 }) });
    const type = h.content.facilityTypes[BAKERY]!;
    const f = newFacility({ id: FAC, ownerId: PLAYER, type, cityId: SPRINGFIELD, orderedTick: 0 });
    runFacilityDay(f, h.prodEnv());
    expect(f.status).toBe('operating');
  });
});

describe('production over 60 ticks', () => {
  it('WIP completes after durationTicks; lots and counters match; 1200/1205/1210 reconcile each tick', () => {
    const h = makeHarness({ content: contentWith({ storageCapacity: quantity(100_000) }) });
    const f = operatingBakery(h, 2);
    const completions: number[] = [];
    runDays(h, f, 60, (tick) => {
      expect(violations(h, f)).toEqual([]);
      for (const e of h.events) {
        if (e.type === 'production.completed') completions.push(tick);
      }
      h.events.length = 0;
    });

    // Capacity is 5 batches in flight and 2 start per tick (duration 2), so the pipeline overlaps:
    // starts every tick, completions every tick from tick 2.
    expect(completions).toEqual(Array.from({ length: 58 }, (_, i) => i + 2));
    const bread = f.outputs[BREAD]!;
    expect(bread.received).toBe(116 * 100);
    expect(bread.quantity).toBe(116 * 100);
    expect(bread.issued).toBe(0);
    // unit cost: (50 grain x 30 + 5,000 labour) per 100 loaves
    expect(bread.value).toBe(116 * 6_500);
    expect(f.wip.map((b) => [b.startedTick, b.completesTick, b.batches, b.value])).toEqual([
      [58, 60, 2, 13_000],
      [59, 61, 2, 13_000],
    ]);
    expect(h.balance(ACCOUNTS.INVENTORY_WIP)).toBe(26_000);
    expect(h.balance(ACCOUNTS.INVENTORY_FINISHED)).toBe(116 * 6_500);
    expect(h.balance(ACCOUNTS.INVENTORY_RAW)).toBe(0);
    // 120 batches paid for: inputs 1,500 + labour 5,000 each; opex 60 days
    expect(h.cash()).toBe(100_000_000 - 60 * 20_000 - 120 * 1_500 - 120 * 5_000);
    expect(h.balance(ACCOUNTS.OPEX_FACILITY)).toBe(60 * 20_000);
    // two month ends (ticks 29 and 59)
    expect(f.accumulatedDepreciation).toBe(2 * 41_667);
    expect(h.balance(ACCOUNTS.DEPRECIATION)).toBe(2 * 41_667);
    expect(h.bought.every((b) => b.productId === GRAIN)).toBe(true);
  });

  it('reaches storage_full and stops starting batches', () => {
    const h = makeHarness();
    const f = operatingBakery(h, 5);
    runDays(h, f, 60, () => {
      expect(violations(h, f)).toEqual([]);
    });
    const held = f.outputs[BREAD]!.quantity + f.wip.reduce((n, b) => n + b.batches * 100, 0);
    expect(held).toBeLessThanOrEqual(2_000);
    expect(f.starvedReason).toBe('storage_full');
  });
});

describe('starvation table (section 5, StarvedReason)', () => {
  it('no_recipe', () => {
    const h = makeHarness();
    const f = operatingBakery(h, 3, { recipeId: null });
    runDays(h, f, 1);
    expect(f.starvedReason).toBe('no_recipe');
    expect(f.wip).toEqual([]);
    expect(h.bought).toEqual([]);
    expect(starved(h)).toEqual([]); // no_recipe is a state, not a starvation event
    expect(h.balance(ACCOUNTS.OPEX_FACILITY)).toBe(20_000); // an idle facility still costs money
  });

  it('off', () => {
    const h = makeHarness();
    const f = operatingBakery(h, 0);
    runDays(h, f, 1);
    expect(f.starvedReason).toBe('off');
    expect(f.wip).toEqual([]);
    expect(starved(h)).toEqual([]);
  });

  it('capacity: batches in progress occupy slots', () => {
    const h = makeHarness();
    const wip: WipBatch = {
      recipeId: BAKE_BREAD,
      batches: quantity(3),
      startedTick: 0,
      completesTick: 5,
      value: money(0),
    };
    const f = operatingBakery(h, 5, { wip: [wip] });
    h.tick = 1;
    runDays(h, f, 1);
    expect(f.starvedReason).toBe('capacity');
    // the new batch (done at tick 3) sorts ahead of the old one (tick 5)
    expect(f.wip.map((b) => b.batches)).toEqual([2, 3]);
    expect(starved(h)[0]?.payload).toMatchObject({ reason: 'capacity', wanted: 5, started: 2 });
  });

  it('storage_full', () => {
    const h = makeHarness();
    const f = operatingBakery(h, 3);
    receiveIntoLot(lotFor(f.outputs, BREAD), 1_950, money(0));
    runDays(h, f, 1);
    expect(f.starvedReason).toBe('storage_full');
    expect(f.wip).toEqual([]);
    expect(h.bought).toEqual([]);
    expect(starved(h)[0]?.payload).toMatchObject({ reason: 'storage_full', wanted: 3, started: 0 });
  });

  it('storage_full counts WIP as committed output', () => {
    const h = makeHarness();
    const f = operatingBakery(h, 5);
    receiveIntoLot(lotFor(f.outputs, BREAD), 1_800, money(0));
    runDays(h, f, 1);
    // room 200 -> 2 batches
    expect(f.wip.map((b) => b.batches)).toEqual([2]);
    expect(f.starvedReason).toBe('storage_full');
  });

  it('no_inputs: a huge input price means cash buys nothing', () => {
    const h = makeHarness({ price: 1_000_000_000 });
    const f = operatingBakery(h, 2);
    runDays(h, f, 1);
    expect(f.starvedReason).toBe('no_inputs');
    expect(f.wip).toEqual([]);
    expect(h.bought).toEqual([]);
    expect(h.balance(ACCOUNTS.INVENTORY_RAW)).toBe(0);
    expect(starved(h)[0]?.payload).toMatchObject({ reason: 'no_inputs', wanted: 2, started: 0 });
  });

  it('no_cash: labour is discretionary and scales the start down', () => {
    const h = makeHarness({ cash: 6_000 });
    const f = operatingBakery(h, 3);
    // stock the inputs (outside the ledger; this test does not reconcile) so only labour is short
    receiveIntoLot(lotFor(f.inputs, GRAIN), 500, money(15_000));
    runDays(h, f, 1);
    expect(f.starvedReason).toBe('no_cash');
    expect(f.wip.map((b) => b.batches)).toEqual([1]); // floor(6,000 / 5,000)
    expect(starved(h)[0]?.payload).toMatchObject({ reason: 'no_cash', wanted: 3, started: 1 });
  });

  it('a partial purchase never takes discretionary spend below zero cash', () => {
    const h = makeHarness({ cash: 2_000 });
    const f = operatingBakery(h, 2);
    runDays(h, f, 1);
    expect(h.bought).toEqual([{ productId: GRAIN, quantity: 66, total: 1_980 }]);
    expect(f.inputs[GRAIN]?.quantity).toBe(66);
    expect(f.wip).toEqual([]); // 66 grain is one batch of inputs, but labour 5,000 > 20 cash
    expect(f.starvedReason).toBe('no_cash');
    // only the non-discretionary opex may (and does) take cash negative
    expect(h.cash()).toBe(2_000 - 1_980 - 20_000);
    expect(violations(h, f)).toEqual([]);
  });

  it('negative cash buys nothing', () => {
    const h = makeHarness({ cash: 0 });
    const f = operatingBakery(h, 2);
    runDays(h, f, 3);
    expect(h.bought).toEqual([]);
    expect(f.wip).toEqual([]);
    expect(h.cash()).toBe(-60_000); // opex still posts every day (ADR-014)
  });

  it('fully started production clears starvedReason', () => {
    const h = makeHarness();
    const f = operatingBakery(h, 2, { starvedReason: 'no_cash' });
    runDays(h, f, 1);
    expect(f.starvedReason).toBeNull();
    expect(starved(h)).toEqual([]);
  });
});

describe('depreciation (ADR-009)', () => {
  it('life 7, cost 1000: charges sum to exactly 1000 and stop', () => {
    const h = makeHarness({
      content: contentWith({ buildCost: money(1_000), usefulLifeMonths: 7 }),
    });
    const f = operatingBakery(h, 0);
    h.isMonthEnd = true;
    for (let month = 0; month < 10; month++) chargeDepreciation(f, 7, h.prodEnv());
    expect(f.accumulatedDepreciation).toBe(1_000);
    expect(h.balance(ACCOUNTS.DEPRECIATION)).toBe(1_000);
    expect(h.balance(ACCOUNTS.ACCUM_DEPRECIATION)).toBe(-1_000);
    expect(violations(h, f)).toEqual([]);
  });

  it('is posted only on month ends of an operating facility', () => {
    const h = makeHarness();
    const f = operatingBakery(h, 0);
    runDays(h, f, 29);
    expect(f.accumulatedDepreciation).toBe(0);
    runDays(h, f, 1); // tick 29 is the first month end
    expect(f.accumulatedDepreciation).toBe(41_667);
  });
});

describe('batch value allocation', () => {
  const twoOutputs = (): ContentPack => {
    const base = contentWith({ storageCapacity: quantity(100_000) });
    return {
      ...base,
      recipes: {
        [BAKE_BREAD]: {
          ...base.recipes[BAKE_BREAD]!,
          outputs: [
            { product: BREAD, quantity: quantity(100) },
            { product: GRAIN, quantity: quantity(7) },
          ],
        },
      },
    };
  };

  it('splits the batch value across outputs by quantity x basePrice; the parts sum exactly', () => {
    const h = makeHarness({ content: twoOutputs() });
    const f = operatingBakery(h, 3);
    runDays(h, f, 3);
    const done = h.events.find((e) => e.type === 'production.completed');
    if (done?.type !== 'production.completed') throw new Error('no completion');
    const { outputs } = done.payload;
    // 3 batches cost 3 x 6,500 = 19,500; weights 3x100x250 = 75,000 and 3x7x30 = 630
    expect(outputs.map((o) => o.quantity)).toEqual([300, 21]);
    expect(outputs.reduce((n, o) => n + o.cost, 0)).toBe(19_500);
    expect(f.outputs[BREAD]?.value).toBe(outputs[0]?.cost);
    expect(f.outputs[GRAIN]?.value).toBe(outputs[1]?.cost);
    expect(h.balance(ACCOUNTS.INVENTORY_FINISHED)).toBe(19_500);
    expect(violations(h, f)).toEqual([]);
  });
});

describe('edge cases', () => {
  it('a zero-input, zero-labour recipe produces goods at zero cost with no postings', () => {
    const base = contentWith({ storageCapacity: quantity(100_000) });
    const content = {
      ...base,
      recipes: {
        [BAKE_BREAD]: { ...base.recipes[BAKE_BREAD]!, inputs: [], laborCostPerBatch: money(0) },
      },
    } as ContentPack;
    const h = makeHarness({ content });
    const f = operatingBakery(h, 2);
    const entriesBefore = h.acct.journal.length;
    runDays(h, f, 4);
    expect(h.bought).toEqual([]);
    expect(f.outputs[BREAD]).toMatchObject({ quantity: 400, value: 0, received: 400 });
    // only opex postings
    expect(h.acct.journal.length - entriesBefore).toBe(4);
    expect(violations(h, f)).toEqual([]);
  });

  it('existing WIP completes with its own recipe after the recipe is cleared', () => {
    const h = makeHarness();
    const f = operatingBakery(h, 1);
    runDays(h, f, 1);
    f.recipeId = null;
    runDays(h, f, 2);
    expect(f.outputs[BREAD]?.quantity).toBe(100);
    expect(f.wip).toEqual([]);
    expect(violations(h, f)).toEqual([]);
  });

  it('insertWip keeps ascending completesTick, FIFO among equals', () => {
    const mk = (completesTick: number, batches: number): WipBatch => ({
      recipeId: recipeId('r'),
      batches: quantity(batches),
      startedTick: 0,
      completesTick,
      value: money(0),
    });
    const wip: WipBatch[] = [];
    insertWip(wip, mk(5, 1));
    insertWip(wip, mk(3, 2));
    insertWip(wip, mk(5, 3));
    insertWip(wip, mk(4, 4));
    expect(wip.map((b) => [b.completesTick, b.batches])).toEqual([
      [3, 2],
      [4, 4],
      [5, 1],
      [5, 3],
    ]);
  });

  it('tests build lots with the real helpers', () => {
    expect(emptyLot().quantity).toBe(0);
    expect(M1_CONTENT_PACK.recipes[BAKE_BREAD]).toBeDefined();
  });
});
