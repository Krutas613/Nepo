/**
 * Snapshot state migrations (ARCHITECTURE.md section 11).
 *
 * An ordered table of steps keyed by the version they migrate FROM: `MIGRATIONS[n]` turns a
 * version-`n` state into a version-`n + 1` state. Steps are authored by the engine agent from the
 * schema agent's migration notes in docs/schema-requests.md. Schema v1 is the first version, so the
 * table is empty.
 */
import { SCHEMA_VERSION, SnapshotError } from '../schema/index.js';

export type MigrationStep = (state: unknown) => unknown;
export type MigrationTable = Readonly<Partial<Record<number, MigrationStep>>>;

export const MIGRATIONS: MigrationTable = {};

export interface MigrationResult {
  state: unknown;
  /** Number of steps applied (0 when the input was already at `toVersion`). */
  steps: number;
}

/**
 * Migrates `state` from `fromVersion` to `toVersion` (default `SCHEMA_VERSION`). Throws
 * `SnapshotError('too_new')` if `fromVersion > toVersion` and `SnapshotError('no_migration')` when
 * a step is missing.
 */
export function migrateSnapshot(
  state: unknown,
  fromVersion: number,
  toVersion: number = SCHEMA_VERSION,
  table: MigrationTable = MIGRATIONS,
): MigrationResult {
  if (fromVersion > toVersion) {
    throw new SnapshotError(
      'too_new',
      `snapshot schema v${fromVersion} is newer than v${toVersion}`,
      {
        fromVersion,
        toVersion,
      },
    );
  }
  let current = state;
  let steps = 0;
  for (let version = fromVersion; version < toVersion; version++) {
    const migrate = table[version];
    if (migrate === undefined) {
      throw new SnapshotError('no_migration', `no migration from schema v${version}`, {
        fromVersion: version,
      });
    }
    current = migrate(current);
    steps += 1;
  }
  return { state: current, steps };
}
