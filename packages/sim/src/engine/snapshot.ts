/**
 * Versioned snapshot save/load (ARCHITECTURE.md section 11, docs/design/engine.md section 5).
 *
 * `snapshot` deep-copies via `JSON.parse(canonicalJson(state))`, which also proves the state is
 * serializable. `restore` parses the envelope, migrates the state if it is older than
 * `SCHEMA_VERSION`, deep-validates it, checks the hash when no migration ran, and rebuilds the
 * world (services included) WITHOUT calling any system's `init`.
 */
import {
  SCHEMA_VERSION,
  SNAPSHOT_FORMAT,
  ScenarioSchema,
  SnapshotEnvelopeSchema,
  SnapshotError,
  SnapshotSchema,
  formatSchemaIssues,
  type Scenario,
  type Snapshot,
  type WorldState,
} from '../schema/index.js';
import { canonicalJson } from './canonical.js';
import { hashState } from './hash.js';
import { migrateSnapshot, MIGRATIONS, type MigrationTable } from './migrations.js';
import type { AnySystem } from './system.js';
import { buildWorld, isWorldPoisoned, type World } from './world.js';

/** Informational version of the engine that wrote a snapshot; never gates loading. */
export const ENGINE_VERSION = '0.1.0';

export interface RestoreOptions {
  /**
   * The scenario the world was created from. Snapshots do not carry it (see REQ-001 in
   * docs/schema-requests.md); when omitted, `world.scenario` is a stub with the state's `epochYear`
   * and no companies. Systems must not read `ctx.scenario` after init for anything that affects
   * state, or restore equivalence depends on passing this.
   */
  scenario?: Scenario;
  /** Migration table override (tests). Defaults to `MIGRATIONS`. */
  migrations?: MigrationTable;
}

/** Self-contained, plain-JSON copy of the world. */
export function snapshot(world: World): Snapshot {
  if (isWorldPoisoned(world)) {
    throw new SnapshotError('poisoned', 'cannot snapshot a world whose step threw');
  }
  const state = JSON.parse(canonicalJson(world.state)) as WorldState;
  return {
    format: SNAPSHOT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    hash: hashState(state),
    state,
  };
}

/**
 * Rebuilds a world from a `Snapshot` (accepts untrusted input, e.g. `JSON.parse` of a save file).
 * Throws `SnapshotError` with code `invalid`, `too_new`, `no_migration` or `hash_mismatch`.
 */
export function restore(
  input: unknown,
  systems: readonly AnySystem[],
  options: RestoreOptions = {},
): World {
  const envelope = SnapshotEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    throw new SnapshotError('invalid', 'snapshot envelope failed validation', {
      issues: formatSchemaIssues(envelope.error),
    });
  }
  const { schemaVersion, hash } = envelope.data;
  if (schemaVersion > SCHEMA_VERSION) {
    throw new SnapshotError('too_new', `snapshot schema v${schemaVersion} > v${SCHEMA_VERSION}`, {
      schemaVersion,
    });
  }
  const migrated = migrateSnapshot(
    envelope.data.state,
    schemaVersion,
    SCHEMA_VERSION,
    options.migrations ?? MIGRATIONS,
  );
  const parsed = SnapshotSchema.safeParse({
    ...envelope.data,
    schemaVersion: SCHEMA_VERSION,
    state: migrated.state,
  });
  if (!parsed.success) {
    throw new SnapshotError('invalid', 'snapshot state failed validation', {
      issues: formatSchemaIssues(parsed.error),
    });
  }
  // Re-canonicalise so the live state is a fresh plain copy independent of the input object.
  const state = JSON.parse(canonicalJson(parsed.data.state)) as WorldState;
  if (migrated.steps === 0) {
    const actual = hashState(state);
    if (actual !== hash.toLowerCase()) {
      throw new SnapshotError('hash_mismatch', `snapshot hash ${hash} != state hash ${actual}`, {
        expected: hash,
        actual,
      });
    }
  }
  let scenario: Scenario;
  if (options.scenario === undefined) {
    scenario = {
      id: 'restored',
      name: 'Restored snapshot',
      epochYear: state.epochYear,
      companies: [],
    };
  } else {
    const parsedScenario = ScenarioSchema.safeParse(options.scenario);
    if (!parsedScenario.success) {
      throw new SnapshotError('invalid_scenario', 'restore scenario failed validation', {
        issues: formatSchemaIssues(parsedScenario.error),
      });
    }
    scenario = parsedScenario.data;
    if (scenario.epochYear !== state.epochYear) {
      throw new SnapshotError('scenario_mismatch', 'scenario epochYear differs from the snapshot', {
        scenarioEpochYear: scenario.epochYear,
        stateEpochYear: state.epochYear,
      });
    }
  }
  return buildWorld(state, scenario, systems, false);
}
