import { describe, expect, it } from 'vitest';
import {
  InvariantError,
  SCHEMA_VERSION,
  SMOKE_SCENARIO,
  SnapshotError,
  SnapshotSchema,
  companyId,
  type Snapshot,
} from '../schema/index.js';
import { hashState } from './hash.js';
import { migrateSnapshot } from './migrations.js';
import { ENGINE_VERSION, restore, snapshot } from './snapshot.js';
import type { AnySystem } from './system.js';
import { chaosSystem } from './testkit.js';
import { createWorld, step, submit, type World } from './world.js';

const SYSTEMS: readonly AnySystem[] = [chaosSystem];

function run(world: World, ticks: number): string[] {
  const hashes: string[] = [];
  for (let i = 0; i < ticks; i++) {
    step(world);
    hashes.push(hashState(world.state));
  }
  return hashes;
}

function snapshotCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SnapshotError);
    return (e as SnapshotError).code;
  }
  throw new Error('expected a throw');
}

function invariantCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvariantError);
    return (e as InvariantError).code;
  }
  throw new Error('expected a throw');
}

describe('snapshot', () => {
  it('produces a valid, self-contained, deep-copied envelope', () => {
    const world = createWorld({ seed: 5, scenario: SMOKE_SCENARIO, systems: SYSTEMS });
    run(world, 10);
    const snap = snapshot(world);
    expect(snap).toMatchObject({
      format: 'nepo/snapshot',
      schemaVersion: SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
    });
    expect(snap.hash).toBe(hashState(world.state));
    expect(snap.state).not.toBe(world.state);
    expect(snap.state).toEqual(world.state);
    expect(snap.scenario).toEqual(SMOKE_SCENARIO);
    expect(snap.scenario).toEqual(world.scenario);
    expect(snap.scenario).not.toBe(world.scenario);
    // The untyped `ai` slice of the chaos system is part of the saved state.
    expect(snap.state.ai).toEqual({ decisions: 10 });
    expect(SnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it('the hash covers state only: a different scenario name does not change it', () => {
    const world = createWorld({ seed: 5, scenario: SMOKE_SCENARIO, systems: SYSTEMS });
    const renamed = createWorld({
      seed: 5,
      scenario: { ...SMOKE_SCENARIO, name: 'Another name' },
      systems: SYSTEMS,
    });
    expect(snapshot(renamed).hash).toBe(snapshot(world).hash);
  });

  it('mutating a snapshot does not reach the live world', () => {
    const world = createWorld({ seed: 5, scenario: SMOKE_SCENARIO, systems: SYSTEMS });
    const snap = snapshot(world);
    snap.scenario.name = 'mutated';
    snap.scenario.companies.length = 0;
    expect(world.scenario).toEqual(SMOKE_SCENARIO);
  });
});

describe('self-contained save', () => {
  it('restore(JSON.parse(JSON.stringify(snapshot(w))), systems) needs no options', () => {
    const world = createWorld({ seed: 77, scenario: SMOKE_SCENARIO, systems: SYSTEMS });
    run(world, 45);
    const restored = restore(JSON.parse(JSON.stringify(snapshot(world))) as unknown, SYSTEMS);
    expect(hashState(restored.state)).toBe(hashState(world.state));
    expect(restored.scenario).toEqual(world.scenario);
    expect(restored.scenario).toEqual(SMOKE_SCENARIO);
    expect(restored.scenario).not.toBe(world.scenario);
    expect(run(restored, 30)).toEqual(run(world, 30));
  });

  it('a snapshot without a scenario is invalid', () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    const { scenario: _dropped, ...rest } = snapshot(world);
    expect(snapshotCode(() => restore(rest, []))).toBe('invalid');
    const bad = { ...snapshot(world), scenario: { ...SMOKE_SCENARIO, id: '' } };
    expect(snapshotCode(() => restore(bad, []))).toBe('invalid');
  });
});

describe('restore equivalence', () => {
  it.each([
    [100, 200],
    [73, 200],
    [0, 50],
  ])('snapshot at %i, restore, run to %i == uninterrupted run', (k, n) => {
    const uninterrupted = createWorld({ seed: 2024, scenario: SMOKE_SCENARIO, systems: SYSTEMS });
    const expected = run(uninterrupted, n);

    const original = createWorld({ seed: 2024, scenario: SMOKE_SCENARIO, systems: SYSTEMS });
    run(original, k);
    // Through text, as a save file would be.
    const text = JSON.stringify(snapshot(original));
    const restored = restore(JSON.parse(text) as unknown, SYSTEMS);
    expect(hashState(restored.state)).toBe(hashState(original.state));
    expect(restored.lastEvents).toEqual([]);

    const continuedOriginal = run(original, n - k);
    const continuedRestored = run(restored, n - k);
    expect(continuedRestored).toEqual(expected.slice(k));
    expect(continuedOriginal).toEqual(expected.slice(k));
  });

  it('carries queued commands (including optional fields) and does not call init', () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: SYSTEMS });
    submit(world, {
      type: 'company.rename',
      issuer: companyId('co_000001'),
      payload: { name: 'Queued' },
    });
    submit(world, {
      type: 'company.rename',
      issuer: companyId('co_000001'),
      payload: { name: 'Bad', companyId: companyId('co_000002') },
    });
    let inits = 0;
    const counting: AnySystem = {
      ...(chaosSystem as AnySystem),
      init: (ctx) => {
        inits += 1;
        return chaosSystem.init(ctx);
      },
    };
    const restored = restore(snapshot(world), [counting]);
    expect(inits).toBe(0);
    expect(restored.state.pendingCommands).toHaveLength(2);
    expect(restored.state.commandSeq).toBe(2);
    expect(restored.scenario).toEqual(SMOKE_SCENARIO);
    const { events } = step(restored);
    expect(events.map((e) => e.type)).toEqual(['company.renamed', 'command.rejected']);
    expect(restored.state.companies[companyId('co_000001')]?.name).toBe('Queued');
  });

  it('restored state is independent of the snapshot object', () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    const snap = snapshot(world);
    const restored = restore(snap, []);
    step(restored);
    expect(snap.state.tick).toBe(0);
  });
});

describe('restore errors', () => {
  function base(): Snapshot {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    run(world, 3);
    return snapshot(world);
  }

  it('hash_mismatch when state was tampered with', () => {
    const snap = base();
    snap.state.tick += 1;
    expect(snapshotCode(() => restore(snap, []))).toBe('hash_mismatch');
  });

  it('too_new for a newer schema version', () => {
    expect(snapshotCode(() => restore({ ...base(), schemaVersion: SCHEMA_VERSION + 1 }, []))).toBe(
      'too_new',
    );
  });

  it('invalid for garbage or bad state', () => {
    expect(snapshotCode(() => restore({ nope: true }, []))).toBe('invalid');
    expect(snapshotCode(() => restore(null, []))).toBe('invalid');
    const snap = base() as unknown as { state: Record<string, unknown> };
    snap.state['extra'] = 1;
    expect(snapshotCode(() => restore(snap, []))).toBe('invalid');
  });

  it('scenario_mismatch when the saved scenario has another epoch (scenario is not hashed)', () => {
    const snap = base();
    snap.scenario.epochYear = 1990;
    expect(snapshotCode(() => restore(snap, []))).toBe('scenario_mismatch');
  });

  it('missing_slice and system validation apply on restore', () => {
    // `base()` has no systems, so its state has no `ai` slice.
    expect(invariantCode(() => restore(base(), SYSTEMS))).toBe('restore.missing_slice');
    const withAi = snapshot(createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: SYSTEMS }));
    const closer: AnySystem = { ...(chaosSystem as AnySystem), phases: { close: () => undefined } };
    expect(invariantCode(() => restore(withAi, [closer]))).toBe('systems.close_reserved');
  });
});

describe('migration hook', () => {
  it('runs steps in order and reports how many ran', () => {
    const table = {
      1: (s: unknown) => ({ ...(s as object), v2: true }),
      2: (s: unknown) => ({ ...(s as object), v3: true }),
    };
    expect(migrateSnapshot({ a: 1 }, 1, 3, table)).toEqual({
      state: { a: 1, v2: true, v3: true },
      steps: 2,
    });
    expect(migrateSnapshot({ a: 1 }, 3, 3, table)).toEqual({ state: { a: 1 }, steps: 0 });
  });

  it('throws no_migration for a gap and too_new for a newer source', () => {
    expect(snapshotCode(() => migrateSnapshot({}, 1, 3, { 1: (s) => s }))).toBe('no_migration');
    expect(snapshotCode(() => migrateSnapshot({}, 4, 3, {}))).toBe('too_new');
  });

  it('the default table runs nothing for a current-version state', () => {
    expect(migrateSnapshot({ x: 1 }, SCHEMA_VERSION)).toEqual({ state: { x: 1 }, steps: 0 });
  });
});
