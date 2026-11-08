/**
 * Snapshots (ARCHITECTURE.md section 11).
 *
 * Bump `SCHEMA_VERSION` on every breaking change to `WorldState` and add migration notes to
 * docs/schema-requests.md for the engine agent's `migrations.ts`.
 */
import { z } from 'zod';
import { ScenarioSchema, type Scenario } from './scenario.js';
import { WorldStateSchema, type WorldState } from './world.js';

/**
 * Version of the `WorldState` shape.
 * - v1: initial M0 types.
 * - v2: M1 typed slices `economy`, `manufacturing`, `retail`, `finance`; account codes stored as
 *   `'a1000'` (migration note in docs/schema-requests.md, REQ-002).
 */
export const SCHEMA_VERSION = 2;

export const SNAPSHOT_FORMAT = 'nepo/snapshot';

export interface Snapshot {
  format: 'nepo/snapshot';
  /** Schema version of `state` as written. */
  schemaVersion: number;
  /** Informational; never gates loading. */
  engineVersion: string;
  /** `hashState(state)` at write time (16 hex chars); covers `state` only. */
  hash: string;
  /**
   * The scenario the world was created from (REQ-001). Outside `state`, so not hashed. `restore`
   * rejects `scenario.epochYear !== state.epochYear` (`SnapshotError('scenario_mismatch')`).
   */
  scenario: Scenario;
  /** Self-contained: seed, tick, rng streams and pending commands are inside. */
  state: WorldState;
}

/** Snapshot envelope with the state left unvalidated, e.g. to read `schemaVersion` before migrating. */
export interface SnapshotEnvelope {
  format: 'nepo/snapshot';
  schemaVersion: number;
  engineVersion: string;
  hash: string;
  /**
   * Validated in the envelope too (section 11). Consequence: a breaking change to `Scenario` would
   * make old envelopes unreadable before any migration runs; such a change needs an ADR first.
   */
  scenario: Scenario;
  state: unknown;
}

const envelopeShape = {
  format: z.literal(SNAPSHOT_FORMAT),
  schemaVersion: z.int().min(1),
  engineVersion: z.string(),
  hash: z.string().regex(/^[0-9a-fA-F]{16}$/, 'expected 16 hex characters'),
  scenario: ScenarioSchema,
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
