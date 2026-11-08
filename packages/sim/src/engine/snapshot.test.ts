import { describe, expect, it } from 'vitest';
import {
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
    expect(SnapshotSchema.safeParse(snap).success).toBe(true);
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
    const restored = restore(JSON.parse(text) as unknown, SYSTEMS, { scenario: SMOKE_SCENARIO });
    expect(hashState(restored.state)).toBe(hashState(original.state));
    expect(restored.lastEvents).toEqual([]);

    const continuedOriginal = run(original, n - k);
    const continuedRestored = run(restored, n - k);
    expect(continuedRestored).toEqual(expected.slice(k));
    expect(continuedOriginal).toEqual(expected.slice(k));
  });

  it('carries queued commands (including optional fields) and does not call init', () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
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
    expect(restored.scenario.epochYear).toBe(2000);
    const { events } = step(restored);
    expect(events.map((e) => e.type)).toEqual(['company.renamed', 'command.rejected']);
    expect(restored.state.companies[companyId('co_000001')]?.name).toBe('Queued');
    expect(restored.state.commandSeq).toBe(2);
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

  it('scenario_mismatch when the given scenario has another epoch', () => {
    expect(
      snapshotCode(() => restore(base(), [], { scenario: { ...SMOKE_SCENARIO, epochYear: 1990 } })),
    ).toBe('scenario_mismatch');
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

  it('the default table is empty at schema v1', () => {
    expect(migrateSnapshot({ x: 1 }, SCHEMA_VERSION)).toEqual({ state: { x: 1 }, steps: 0 });
  });
});
