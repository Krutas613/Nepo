/**
 * Snapshots (ARCHITECTURE.md section 11).
 *
 * Bump `SCHEMA_VERSION` on every breaking change to `WorldState` and add migration notes to
 * docs/schema-requests.md for the engine agent's `migrations.ts`.
 */
import { z } from 'zod';
import { WorldStateSchema, type WorldState } from './world.js';

/** Version of the `WorldState` shape. v1: initial M0 types. */
export const SCHEMA_VERSION = 1;

export const SNAPSHOT_FORMAT = 'nepo/snapshot';

export interface Snapshot {
  format: 'nepo/snapshot';
  /** Schema version of `state` as written. */
  schemaVersion: number;
  /** Informational; never gates loading. */
  engineVersion: string;
  /** `hashState(state)` at write time (16 hex chars). */
  hash: string;
  /** Self-contained: seed, tick, rng streams and pending commands are inside. */
  state: WorldState;
}

/** Snapshot envelope with the state left unvalidated, e.g. to read `schemaVersion` before migrating. */
export interface SnapshotEnvelope {
  format: 'nepo/snapshot';
  schemaVersion: number;
  engineVersion: string;
  hash: string;
  state: unknown;
}

const envelopeShape = {
  format: z.literal(SNAPSHOT_FORMAT),
  schemaVersion: z.int().min(1),
  engineVersion: z.string(),
  hash: z.string().regex(/^[0-9a-fA-F]{16}$/, 'expected 16 hex characters'),
};

/** Validates only the envelope; `state` is passed through untouched. */
export const SnapshotEnvelopeSchema = z.strictObject({
  ...envelopeShape,
  state: z.unknown(),
}) satisfies z.ZodType<SnapshotEnvelope>;

/** Deep validator: envelope plus the full current-version `WorldState`. */
export const SnapshotSchema = z.strictObject({
  ...envelopeShape,
  state: WorldStateSchema,
}) satisfies z.ZodType<Snapshot>;
