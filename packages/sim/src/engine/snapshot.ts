/**
 * Versioned snapshot save/load (ARCHITECTURE.md section 11, docs/design/engine.md section 5).
 *
 * A snapshot is self-contained (REQ-001): it carries the scenario the world was created from next to
 * the state, so `restore` needs nothing but the snapshot and the system objects.
 *
 * `snapshot` deep-copies via `JSON.parse(canonicalJson(state))`, which also proves the state is
 * serializable; the hash covers `state` only (the scenario is immutable configuration, validated
 * rather than hashed). `restore` parses the envelope, migrates the state if it is older than
 * `SCHEMA_VERSION`, deep-validates state and scenario, checks the hash when no migration ran, checks
 * `scenario.epochYear === state.epochYear`, and rebuilds the world (services included) WITHOUT
 * calling any system's `init`.
 */
import {
  SCHEMA_VERSION,
  SNAPSHOT_FORMAT,
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

/** Test overrides only; a snapshot needs nothing else to restore. */
export interface RestoreOptions {
  /** Migration table override (tests). Defaults to `MIGRATIONS`. */
  migrations?: MigrationTable;
}

/** Self-contained, plain-JSON copy of the world. */
export function snapshot(world: World): Snapshot {
  if (isWorldPoisoned(world)) {
    throw new SnapshotError('poisoned', 'cannot snapshot a world whose step threw');
  }
  const state = JSON.parse(canonicalJson(world.state)) as WorldState;
  // Copied too, so mutating the snapshot cannot reach the live world's scenario.
  const scenario = JSON.parse(canonicalJson(world.scenario)) as Scenario;
  return {
    format: SNAPSHOT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    hash: hashState(state),
    scenario,
    state,
  };
}

/**
 * Rebuilds a world from a `Snapshot` (accepts untrusted input, e.g. `JSON.parse` of a save file).
 * The scenario is read from the snapshot (there is no caller-supplied scenario). Throws
 * `SnapshotError` with code `invalid`, `too_new`, `no_migration`, `hash_mismatch` or
 * `scenario_mismatch`; `InvariantError('restore.missing_slice')` (and the system-validation codes of
 * `createWorld`) for a system set that does not fit the state.
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
  // Validated by `ScenarioSchema` inside `SnapshotSchema`; re-copied like the state.
  const scenario = JSON.parse(canonicalJson(parsed.data.scenario)) as Scenario;
  if (scenario.epochYear !== state.epochYear) {
    throw new SnapshotError('scenario_mismatch', 'scenario epochYear differs from the snapshot', {
      scenarioEpochYear: scenario.epochYear,
      stateEpochYear: state.epochYear,
    });
  }
  return buildWorld(state, scenario, systems, false);
}
