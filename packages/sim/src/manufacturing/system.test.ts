/**
 * Integration: the real engine + accounting + economy + manufacturing on VERTICAL_SLICE_SCENARIO.
 * Retail is stood in for by a scripted system that calls `ManufacturingApi.withdraw` in `market`.
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNTING_SERVICE, ACCOUNTS, accountingSystem } from '../accounting/index.js';
import { economySystem } from '../economy/index.js';
import {
  createWorld,
  hashState,
  restore,
  snapshot,
  step,
  submit,
  type AnySystem,
  type System,
  type TickContext,
  type World,
} from '../engine/index.js';
import {
  EMPTY_RETAIL_STATE,
  VERTICAL_SLICE_SCENARIO,
  WorldStateSchema,
  facilityId,
  money,
  quantity,
  type Event,
  type RetailState,
  type Result,
} from '../schema/index.js';
import { checkManufacturingInvariants } from './invariants.js';
import { MANUFACTURING_SERVICE, type Withdrawal, type WithdrawError } from './service.js';
import { manufacturingSystem } from './system.js';
import { BAKE_BREAD, BAKERY, BREAD, GRAIN, OTHER, PLAYER, SPRINGFIELD } from './test-helpers.js';

const FAC = facilityId('fa_000001');
const SCENARIO = VERTICAL_SLICE_SCENARIO;

type Retail = System<RetailState> & { calls: Result<Withdrawal, WithdrawError>[] };

/** Retail stand-in: `script(ctx)` runs in `market` and may call the manufacturing service. */
function fakeRetail(
  script: (ctx: TickContext<RetailState>, calls: Retail['calls']) => void,
): Retail {
  const calls: Retail['calls'] = [];
  return {
    id: 'retail',
    handles: [],
    init: () => ({ ...EMPTY_RETAIL_STATE, stores: {} }),
    phases: {
      market(ctx) {
        script(ctx, calls);
      },
    },
    calls,
  };
}

const core: AnySystem[] = [accountingSystem, economySystem, manufacturingSystem];

function newWorld(extra: AnySystem[] = [], seed = 7): World {
  return createWorld({ seed, scenario: SCENARIO, systems: [...core, ...extra] });
}

function bakeryCommands(world: World, target = 5): void {
  const build = submit(world, {
    type: 'facility.build',
    issuer: PLAYER,
    payload: { companyId: PLAYER, facilityTypeId: BAKERY, cityId: SPRINGFIELD },
  });
  const recipe = submit(world, {
    type: 'facility.set_recipe',
    issuer: PLAYER,
    payload: { facilityId: FAC, recipeId: BAKE_BREAD },
  });
  const prod = submit(world, {
    type: 'facility.set_production',
    issuer: PLAYER,
    payload: { facilityId: FAC, targetBatches: quantity(target) },
  });
  expect([build.ok, recipe.ok, prod.ok]).toEqual([true, true, true]);
}

function balance(world: World, code: Parameters<ReturnType<typeof acct>['balance']>[1]) {
  return acct(world).balance(PLAYER, code);
}
function acct(world: World) {
  const entities = world.state.accounting.entities;
  return {
    balance: (id: typeof PLAYER, code: (typeof ACCOUNTS)[keyof typeof ACCOUNTS]) =>
      entities[id]?.accounts[code]?.balance ?? money(0),
  };
}

const typesOf = (events: readonly Event[], type: Event['type']) =>
  events.filter((e) => e.type === type);

function violations(world: World) {
  return checkManufacturingInvariants(world.state, world.scenario.content);
}

describe('manufacturing on the real engine', () => {
  it('builds, constructs, produces for 90 ticks and reconciles to the ledger', () => {
    const world = newWorld();
    const startCash = balance(world, ACCOUNTS.CASH);
    expect(startCash).toBe(50_000_000);
    bakeryCommands(world);
    const all: Event[] = [];
    for (let i = 0; i < 90; i++) {
      step(world, { checkSliceOwnership: true, checkFinite: i % 10 === 0 });
      all.push(...world.lastEvents);
      expect(violations(world)).toEqual([]);
    }

    // build: one capex entry, one id, completes after 10 ticks
    expect(typesOf(all, 'command.rejected')).toEqual([]);
    expect(typesOf(all, 'facility.ordered')).toHaveLength(1);
    const completed = typesOf(all, 'facility.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.tick).toBe(10);
    const f = world.state.manufacturing.facilities[FAC]!;
    expect(f.status).toBe('operating');
    expect(f.recipeId).toBe(BAKE_BREAD);

    // production started on tick 10 (the completion day) and lots grew
    const bread = f.outputs[BREAD]!;
    expect(bread.received).toBeGreaterThan(0);
    expect(bread.received - bread.issued).toBe(bread.quantity);
    expect(bread.quantity + f.wip.reduce((n, b) => n + b.batches * 100, 0)).toBeLessThanOrEqual(
      2_000,
    );

    // a1210 === Σ lot values; a1205 === Σ wip; a1200 === Σ inputs
    expect(balance(world, ACCOUNTS.INVENTORY_FINISHED)).toBe(bread.value);
    expect(balance(world, ACCOUNTS.INVENTORY_WIP)).toBe(f.wip.reduce((n, b) => n + b.value, 0));
    expect(balance(world, ACCOUNTS.INVENTORY_RAW)).toBe(f.inputs[GRAIN]?.value ?? 0);

    // cash decreased by exactly capex + opex + inputs + labour
    const purchased = typesOf(all, 'commodity.purchased').reduce(
      (n, e) => n + (e.type === 'commodity.purchased' ? e.payload.total : 0),
      0,
    );
    const batchesStarted = f.wip.reduce((n, b) => n + b.batches, 0) + bread.received / 100;
    const opexDays = 90 - 10; // ticks 10..89 inclusive
    expect(balance(world, ACCOUNTS.OPEX_FACILITY)).toBe(opexDays * 20_000);
    expect(balance(world, ACCOUNTS.PPE)).toBe(5_000_000);
    expect(balance(world, ACCOUNTS.CASH)).toBe(
      startCash - 5_000_000 - opexDays * 20_000 - purchased - batchesStarted * 5_000,
    );
    // depreciation: month ends at ticks 29, 59, 89 (operating since 10)
    expect(f.accumulatedDepreciation).toBe(3 * 41_667);
    expect(balance(world, ACCOUNTS.ACCUM_DEPRECIATION)).toBe(-3 * 41_667);
    // the state passes the strict schema
    expect(WorldStateSchema.safeParse(JSON.parse(JSON.stringify(world.state))).success).toBe(true);
  });

  it('commands can arrive later, and rejections surface as command.rejected', () => {
    const world = newWorld();
    submit(world, {
      type: 'facility.build',
      issuer: PLAYER,
      payload: { companyId: OTHER, facilityTypeId: BAKERY, cityId: SPRINGFIELD },
    });
    step(world, { checkSliceOwnership: true });
    const rejected = typesOf(world.lastEvents, 'command.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.type === 'command.rejected' && rejected[0].payload.code).toBe('not_owner');
    expect(Object.keys(world.state.manufacturing.facilities)).toEqual([]);
  });

  it('cannot afford a build with too little cash (rejected, nothing posted)', () => {
    const poor = {
      ...SCENARIO,
      companies: [{ ...SCENARIO.companies[0]!, startingCash: money(1_000_000) }],
    };
    const world = createWorld({ seed: 1, scenario: poor, systems: core });
    submit(world, {
      type: 'facility.build',
      issuer: PLAYER,
      payload: { companyId: PLAYER, facilityTypeId: BAKERY, cityId: SPRINGFIELD },
    });
    step(world);
    const e = typesOf(world.lastEvents, 'command.rejected')[0];
    expect(e?.type === 'command.rejected' && e.payload.code).toBe('insufficient_cash');
    expect(balance(world, ACCOUNTS.CASH)).toBe(1_000_000);
    expect(typesOf(world.lastEvents, 'ledger.posted')).toEqual([]);
  });

  it('withdraw moves goods and value to the destination account atomically', () => {
    let withdrawn: Result<Withdrawal, WithdrawError>[] = [];
    const retail = fakeRetail((ctx, calls) => {
      if (ctx.tick < 14) return;
      const api = ctx.services.get(MANUFACTURING_SERVICE);
      if (ctx.tick === 14) {
        calls.push(api.withdraw(OTHER, FAC, BREAD, quantity(1), ACCOUNTS.INVENTORY_MERCHANDISE));
        calls.push(api.withdraw(PLAYER, FAC, GRAIN, quantity(1), ACCOUNTS.INVENTORY_MERCHANDISE));
        calls.push(api.withdraw(PLAYER, FAC, BREAD, quantity(0), ACCOUNTS.INVENTORY_MERCHANDISE));
        calls.push(
          api.withdraw(PLAYER, FAC, BREAD, quantity(999_999), ACCOUNTS.INVENTORY_MERCHANDISE),
        );
        calls.push(api.withdraw(PLAYER, FAC, BREAD, quantity(150), ACCOUNTS.INVENTORY_MERCHANDISE));
      }
      if (ctx.tick === 30) {
        const have = api.availableOutput(FAC, BREAD);
        calls.push(api.withdraw(PLAYER, FAC, BREAD, have, ACCOUNTS.INVENTORY_MERCHANDISE));
      }
      withdrawn = calls;
    });
    const world = newWorld([retail]);
    bakeryCommands(world, 2);
    for (let i = 0; i <= 30; i++) {
      step(world, { checkSliceOwnership: true });
      expect(violations(world)).toEqual([]);
    }
    const codes = withdrawn.map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes).toEqual([
      'not_owner',
      'unknown_product',
      'invalid_quantity',
      'insufficient',
      'ok',
      'ok',
    ]);

    const first = withdrawn[4];
    expect(first?.ok && first.value).toMatchObject({ quantity: 150 });
    // merchandise holds exactly the withdrawn cost; finished goods + merchandise = Σ completed batch value
    const f = world.state.manufacturing.facilities[FAC]!;
    const totalCost = withdrawn.reduce((n, r) => n + (r.ok ? r.value.cost : 0), 0);
    expect(balance(world, ACCOUNTS.INVENTORY_MERCHANDISE)).toBe(totalCost);
    expect(balance(world, ACCOUNTS.INVENTORY_FINISHED)).toBe(f.outputs[BREAD]?.value);
    // 6,500 per 100 loaves at the (rounded) average
    expect(totalCost).toBeGreaterThan(0);
    expect(f.outputs[BREAD]?.issued).toBe(
      withdrawn.reduce((n, r) => n + (r.ok ? r.value.quantity : 0), 0),
    );
    // withdrawing everything on tick 30 emptied that lot's value before the day's later production
    expect(f.outputs[BREAD]!.received - f.outputs[BREAD]!.issued).toBe(f.outputs[BREAD]!.quantity);
  });

  it('withdrawing every unit leaves the lot with value 0', () => {
    let all: Result<Withdrawal, WithdrawError> | null = null;
    const retail = fakeRetail((ctx) => {
      if (ctx.tick !== 20) return;
      const api = ctx.services.get(MANUFACTURING_SERVICE);
      all = api.withdraw(
        PLAYER,
        FAC,
        BREAD,
        api.availableOutput(FAC, BREAD),
        ACCOUNTS.INVENTORY_MERCHANDISE,
      );
      // the posting is visible to accounting immediately
      expect(
        ctx.services.get(ACCOUNTING_SERVICE).balance(PLAYER, ACCOUNTS.INVENTORY_FINISHED),
      ).toBe(0);
    });
    const world = newWorld([retail]);
    bakeryCommands(world, 3);
    for (let i = 0; i <= 20; i++) step(world, { checkSliceOwnership: true });
    expect((all as Result<Withdrawal, WithdrawError> | null)?.ok).toBe(true);
    const lot = world.state.manufacturing.facilities[FAC]!.outputs[BREAD]!;
    expect(lot.quantity).toBe(0);
    expect(lot.value).toBe(0);
    expect(violations(world)).toEqual([]);
  });

  it('under construction: withdraw says not_operating; reads work', () => {
    let result: Result<Withdrawal, WithdrawError> | null = null;
    let found: unknown = 'unset';
    let owned: readonly string[] = [];
    const retail = fakeRetail((ctx) => {
      if (ctx.tick !== 3) return;
      const api = ctx.services.get(MANUFACTURING_SERVICE);
      result = api.withdraw(PLAYER, FAC, BREAD, quantity(1), ACCOUNTS.INVENTORY_MERCHANDISE);
      found = api.facility(FAC)?.status;
      owned = api.facilitiesOf(PLAYER, SPRINGFIELD);
      expect(api.facilitiesOf(OTHER)).toEqual([]);
      expect(api.availableOutput(FAC, BREAD)).toBe(0);
      expect(api.facility(facilityId('fa_000099'))).toBeNull();
    });
    const world = newWorld([retail]);
    bakeryCommands(world);
    for (let i = 0; i < 5; i++) step(world);
    expect((result as Result<Withdrawal, WithdrawError> | null)?.ok).toBe(false);
    expect(found).toBe('under_construction');
    expect(owned).toEqual([FAC]);
  });

  it('is deterministic: two runs have the same hash every tick', () => {
    const a = newWorld();
    const b = newWorld();
    bakeryCommands(a);
    bakeryCommands(b);
    for (let i = 0; i < 90; i++) {
      step(a);
      step(b);
      expect(hashState(a.state)).toBe(hashState(b.state));
    }
  });

  it('snapshot/restore mid-run continues identically', () => {
    const a = newWorld();
    bakeryCommands(a);
    for (let i = 0; i < 40; i++) step(a);
    const b = restore(JSON.parse(JSON.stringify(snapshot(a))), core);
    for (let i = 0; i < 50; i++) {
      step(a);
      step(b, { checkSliceOwnership: true });
      expect(hashState(b.state)).toBe(hashState(a.state));
    }
    expect(violations(b)).toEqual([]);
  });
});
