import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, accountingSystem } from '../accounting/index.js';
import { economySystem } from '../economy/index.js';
import { createWorld, step, submit, type System, type World } from '../engine/index.js';
import {
  EMPTY_RETAIL_STATE,
  VERTICAL_SLICE_SCENARIO,
  money,
  quantity,
  type Facility,
  type RetailState,
} from '../schema/index.js';
import { checkManufacturingInvariants, ppeByEntity } from './invariants.js';
import { lotFor, receiveIntoLot } from './lots.js';
import { MANUFACTURING_SERVICE } from './service.js';
import { manufacturingSystem } from './system.js';
import {
  BAKE_BREAD,
  BAKERY,
  BREAD,
  FAC,
  GRAIN,
  PLAYER,
  SPRINGFIELD,
  makeHarness,
  operatingBakery,
  stateOf,
} from './test-helpers.js';

const codes = (f: Facility, withLedger = false) => {
  const h = makeHarness();
  return checkManufacturingInvariants(
    { tick: 5, manufacturing: stateOf(f), ...(withLedger ? { accounting: h.acct } : {}) },
    h.content,
  ).map((v) => v.code);
};

describe('checkManufacturingInvariants', () => {
  it('passes on a pristine facility', () => {
    expect(codes(operatingBakery(makeHarness(), 1))).toEqual([]);
  });

  it('flags each lot violation', () => {
    const f = operatingBakery(makeHarness(), 1);
    f.outputs[BREAD] = {
      quantity: quantity(5),
      value: money(10),
      received: quantity(7),
      issued: quantity(1),
    };
    expect(codes(f)).toContain('lot.conservation');

    const g = operatingBakery(makeHarness(), 1);
    g.inputs[GRAIN] = {
      quantity: quantity(0),
      value: money(3),
      received: quantity(2),
      issued: quantity(2),
    };
    expect(codes(g)).toEqual(['lot.empty_has_value']);

    const n = operatingBakery(makeHarness(), 1);
    n.inputs[GRAIN] = {
      quantity: -1 as never,
      value: -5 as never,
      received: quantity(0),
      issued: quantity(1),
    };
    expect(codes(n)).toEqual(
      expect.arrayContaining(['lot.negative_quantity', 'lot.negative_value']),
    );
  });

  it('flags capacity, target, storage and depreciation bounds', () => {
    const f = operatingBakery(makeHarness(), 1);
    f.wip = [
      {
        recipeId: BAKE_BREAD,
        batches: quantity(6),
        startedTick: 0,
        completesTick: 2,
        value: money(0),
      },
    ];
    f.targetBatches = quantity(9);
    f.accumulatedDepreciation = money(f.cost + 1);
    receiveIntoLot(lotFor(f.outputs, BREAD), 1_500, money(0));
    expect(codes(f)).toEqual(
      expect.arrayContaining([
        'facility.over_capacity',
        'facility.target_exceeds_capacity',
        'facility.storage_exceeded',
        'facility.depreciation_bounds',
      ]),
    );
  });

  it('flags a facility still under construction after its completion tick', () => {
    const f = operatingBakery(makeHarness(), 1, { status: 'under_construction', completesTick: 3 });
    expect(codes(f)).toEqual(['facility.construction_overdue']);
  });

  it('flags lot values that do not reconcile to the ledger (a1200 / a1205 / a1210)', () => {
    const f = operatingBakery(makeHarness(), 1);
    receiveIntoLot(lotFor(f.inputs, GRAIN), 10, money(300));
    f.wip = [
      {
        recipeId: BAKE_BREAD,
        batches: quantity(1),
        startedTick: 0,
        completesTick: 2,
        value: money(7),
      },
    ];
    receiveIntoLot(lotFor(f.outputs, BREAD), 10, money(11));
    expect(codes(f, true)).toEqual([
      'ledger.inputs_mismatch',
      'ledger.wip_mismatch',
      'ledger.outputs_mismatch',
    ]);
  });

  it('ppeByEntity sums cost and accumulated depreciation per owner', () => {
    const f = operatingBakery(makeHarness(), 1, { accumulatedDepreciation: money(100) });
    expect(ppeByEntity(stateOf(f))).toEqual({
      [PLAYER]: { cost: 5_000_000, accumulatedDepreciation: 100 },
    });
  });
});

describe('manufacturing invariant property (real engine)', () => {
  interface Action {
    target: number;
    recipeOn: boolean;
    withdraw: number;
  }
  const actionArb: fc.Arbitrary<Action> = fc.record({
    target: fc.integer({ min: 0, max: 8 }),
    recipeOn: fc.boolean(),
    withdraw: fc.integer({ min: 0, max: 700 }),
  });

  it('random recipe/target/withdraw scripts never break an invariant (no negative inventory)', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 30, maxLength: 70 }), (actions) => {
        const retail: System<RetailState> = {
          id: 'retail',
          handles: [],
          init: () => ({ ...EMPTY_RETAIL_STATE, stores: {} }),
          phases: {
            market(ctx) {
              const a = actions[ctx.tick - 11];
              if (a === undefined || a.withdraw === 0) return;
              const api = ctx.services.get(MANUFACTURING_SERVICE);
              const take = Math.min(a.withdraw, api.availableOutput(FAC, BREAD));
              if (take >= 1) {
                const r = api.withdraw(
                  PLAYER,
                  FAC,
                  BREAD,
                  quantity(take),
                  ACCOUNTS.INVENTORY_MERCHANDISE,
                );
                expect(r.ok).toBe(true);
              }
            },
          },
        };
        const world: World = createWorld({
          seed: 3,
          scenario: VERTICAL_SLICE_SCENARIO,
          systems: [accountingSystem, economySystem, manufacturingSystem, retail],
        });
        submit(world, {
          type: 'facility.build',
          issuer: PLAYER,
          payload: { companyId: PLAYER, facilityTypeId: BAKERY, cityId: SPRINGFIELD },
        });
        for (let tick = 0; tick < 11 + actions.length; tick++) {
          const a = actions[tick - 11];
          if (a !== undefined) {
            submit(world, {
              type: 'facility.set_recipe',
              issuer: PLAYER,
              payload: { facilityId: FAC, recipeId: a.recipeOn ? BAKE_BREAD : null },
            });
            submit(world, {
              type: 'facility.set_production',
              issuer: PLAYER,
              payload: { facilityId: FAC, targetBatches: quantity(a.target) },
            });
          }
          step(world, { checkSliceOwnership: true });
          expect(checkManufacturingInvariants(world.state, world.scenario.content)).toEqual([]);
        }
      }),
      { numRuns: 12 },
    );
  });
});
