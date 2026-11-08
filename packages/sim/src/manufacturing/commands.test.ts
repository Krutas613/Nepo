import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../accounting/index.js';
import { cityId, facilityId, facilityTypeId, quantity, recipeId } from '../schema/index.js';
import { applyCommand, MANUFACTURING_COMMANDS } from './commands.js';
import {
  BAKE_BREAD,
  BAKERY,
  BREAD,
  GRAIN,
  OTHER,
  PLAYER,
  SPRINGFIELD,
  cmd,
  contentWith,
  makeHarness,
  stateOf,
} from './test-helpers.js';
import type { Command } from '../schema/index.js';

const build = (issuer = PLAYER, companyId = PLAYER, typeId = BAKERY, city = SPRINGFIELD) =>
  cmd({
    type: 'facility.build',
    issuer,
    payload: { companyId, facilityTypeId: typeId, cityId: city },
  });

describe('facility.build', () => {
  it('rejects in order: not_owner, unknown_facility_type, unknown_city, insufficient_cash', () => {
    const h = makeHarness({ cash: 1_000 });
    const state = stateOf();
    const run = (c: Command) => {
      applyCommand(state, c, h.cmdEnv());
    };

    // Everything is wrong at once: the first check in the list wins.
    run(build(PLAYER, OTHER, facilityTypeId('nope'), cityId('nowhere')));
    run(build(PLAYER, PLAYER, facilityTypeId('nope'), cityId('nowhere')));
    run(build(PLAYER, PLAYER, BAKERY, cityId('nowhere')));
    run(build()); // cash 1,000 < 5,000,000
    expect(h.rejections.map((r) => r.code)).toEqual([
      'not_owner',
      'unknown_facility_type',
      'unknown_city',
      'insufficient_cash',
    ]);
    expect(Object.keys(state.facilities)).toEqual([]);
    expect(h.acct.journal).toHaveLength(1); // opening capital only: nothing posted
    expect(h.cash()).toBe(1_000);
    expect(h.events).toEqual([]);
  });

  it('posts exactly one capex entry, reduces cash by buildCost, issues an id and emits facility.ordered', () => {
    const h = makeHarness({ cash: 10_000_000 });
    h.tick = 7;
    const state = stateOf();
    applyCommand(state, build(), h.cmdEnv());

    expect(h.rejections).toEqual([]);
    expect(h.acct.journal).toHaveLength(2);
    const entry = h.acct.journal[1];
    expect(entry).toMatchObject({ source: 'manufacturing', memo: 'Capital expenditure' });
    expect(entry?.ref).toEqual({ kind: 'facility', id: 'fa_000001' });
    expect(h.cash()).toBe(5_000_000);
    expect(h.balance(ACCOUNTS.PPE)).toBe(5_000_000);

    const f = state.facilities[facilityId('fa_000001')];
    expect(f).toMatchObject({
      ownerId: PLAYER,
      typeId: BAKERY,
      cityId: SPRINGFIELD,
      status: 'under_construction',
      orderedTick: 7,
      completesTick: 17,
      cost: 5_000_000,
    });
    expect(h.events).toEqual([
      {
        type: 'facility.ordered',
        payload: {
          facilityId: 'fa_000001',
          companyId: PLAYER,
          facilityTypeId: BAKERY,
          cityId: SPRINGFIELD,
          completesTick: 17,
        },
      },
    ]);
  });

  it('can spend exactly all its cash (cash === buildCost is affordable)', () => {
    const h = makeHarness({ cash: 5_000_000 });
    applyCommand(stateOf(), build(), h.cmdEnv());
    expect(h.rejections).toEqual([]);
    expect(h.cash()).toBe(0);
  });

  it('a zero-cost type posts nothing but still builds', () => {
    const h = makeHarness({ content: contentWith({ buildCost: 0 as never }) });
    const state = stateOf();
    applyCommand(state, build(), h.cmdEnv());
    expect(h.rejections).toEqual([]);
    expect(h.acct.journal).toHaveLength(1);
    expect(Object.keys(state.facilities)).toHaveLength(1);
  });
});

describe('facility.set_recipe / facility.set_production', () => {
  const setup = () => {
    const h = makeHarness();
    const state = stateOf();
    applyCommand(state, build(), h.cmdEnv());
    h.events.length = 0;
    return { h, state, id: facilityId('fa_000001') };
  };

  it('set_recipe rejects in order: unknown_facility, not_owner, unknown_recipe, recipe_mismatch', () => {
    const { h, state, id } = setup();
    const run = (c: Command) => {
      applyCommand(state, c, h.cmdEnv());
    };
    run(
      cmd({
        type: 'facility.set_recipe',
        issuer: PLAYER,
        payload: { facilityId: facilityId('fa_999999'), recipeId: BAKE_BREAD },
      }),
    );
    run(
      cmd({
        type: 'facility.set_recipe',
        issuer: OTHER,
        payload: { facilityId: id, recipeId: recipeId('nope') },
      }),
    );
    run(
      cmd({
        type: 'facility.set_recipe',
        issuer: PLAYER,
        payload: { facilityId: id, recipeId: recipeId('nope') },
      }),
    );
    expect(h.rejections.map((r) => r.code)).toEqual([
      'unknown_facility',
      'not_owner',
      'unknown_recipe',
    ]);
    expect(state.facilities[id]?.recipeId).toBeNull();
    expect(h.events).toEqual([]);
  });

  it('set_recipe rejects a recipe for another facility type (recipe_mismatch)', () => {
    const { h, state, id } = setup();
    const other = facilityTypeId('mill');
    const content = h.content;
    h.content = {
      ...content,
      recipes: {
        ...content.recipes,
        [recipeId('mill_it')]: {
          ...content.recipes[BAKE_BREAD]!,
          id: recipeId('mill_it'),
          facilityType: other,
        },
      },
    };
    applyCommand(
      state,
      cmd({
        type: 'facility.set_recipe',
        issuer: PLAYER,
        payload: { facilityId: id, recipeId: recipeId('mill_it') },
      }),
      h.cmdEnv(),
    );
    expect(h.rejections.map((r) => r.code)).toEqual(['recipe_mismatch']);
  });

  it('set_recipe sets, clears, touches lots and emits', () => {
    const { h, state, id } = setup();
    applyCommand(
      state,
      cmd({
        type: 'facility.set_recipe',
        issuer: PLAYER,
        payload: { facilityId: id, recipeId: BAKE_BREAD },
      }),
      h.cmdEnv(),
    );
    const f = state.facilities[id]!;
    expect(f.recipeId).toBe(BAKE_BREAD);
    expect(Object.keys(f.inputs)).toEqual([GRAIN]);
    expect(Object.keys(f.outputs)).toEqual([BREAD]);
    applyCommand(
      state,
      cmd({
        type: 'facility.set_recipe',
        issuer: PLAYER,
        payload: { facilityId: id, recipeId: null },
      }),
      h.cmdEnv(),
    );
    expect(f.recipeId).toBeNull();
    expect(h.events.map((e) => e.type)).toEqual(['facility.recipe_set', 'facility.recipe_set']);
  });

  it('set_production rejects unknown_facility then not_owner; clamps to capacity; emits the clamped value', () => {
    const { h, state, id } = setup();
    const run = (c: Command) => {
      applyCommand(state, c, h.cmdEnv());
    };
    run(
      cmd({
        type: 'facility.set_production',
        issuer: PLAYER,
        payload: { facilityId: facilityId('fa_999999'), targetBatches: quantity(1) },
      }),
    );
    run(
      cmd({
        type: 'facility.set_production',
        issuer: OTHER,
        payload: { facilityId: id, targetBatches: quantity(1) },
      }),
    );
    expect(h.rejections.map((r) => r.code)).toEqual(['unknown_facility', 'not_owner']);
    run(
      cmd({
        type: 'facility.set_production',
        issuer: PLAYER,
        payload: { facilityId: id, targetBatches: quantity(99) },
      }),
    );
    expect(state.facilities[id]?.targetBatches).toBe(5);
    expect(h.events).toEqual([
      { type: 'facility.production_set', payload: { facilityId: id, targetBatches: 5 } },
    ]);
  });

  it('ignores command types it does not handle and lists exactly its three', () => {
    const { h, state } = setup();
    applyCommand(
      state,
      cmd({ type: 'company.rename', issuer: PLAYER, payload: { name: 'x' } }),
      h.cmdEnv(),
    );
    expect(h.rejections).toEqual([]);
    expect([...MANUFACTURING_COMMANDS]).toEqual([
      'facility.build',
      'facility.set_recipe',
      'facility.set_production',
    ]);
  });
});
