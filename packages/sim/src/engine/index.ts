/**
 * Nepo `engine` module (ARCHITECTURE.md sections 3, 5, 6, 9, 10, 11). Owned by the `engine` agent.
 *
 * Public surface: tick loop (`createWorld`, `step`, `submit`), snapshots (`snapshot`, `restore`,
 * `migrateSnapshot`), determinism utilities (`hashState`, `hashString`, `canonicalJson`,
 * `findNonFinite`, `sortedKeys`), calendar, RNG, registry, and the System types.
 */
export {
  calendarFromTick,
  DAYS_PER_MONTH,
  DAYS_PER_QUARTER,
  DAYS_PER_YEAR,
  MONTHS_PER_QUARTER,
  MONTHS_PER_YEAR,
  type CalendarDate,
} from './calendar.js';
export { canonicalJson } from './canonical.js';
export { coreSystem, type CompaniesSlice } from './core.js';
export { findNonFinite } from './finite.js';
export { hashState, hashString, hashValue } from './hash.js';
export {
  migrateSnapshot,
  MIGRATIONS,
  type MigrationResult,
  type MigrationStep,
  type MigrationTable,
} from './migrations.js';
export { formatEntityId, issueId } from './registry.js';
export {
  createRng,
  fnv1a32,
  rngFromState,
  seedStream,
  splitmix32,
  xoshiro128ss,
  type Rng,
} from './rng.js';
export { ENGINE_VERSION, restore, snapshot, type RestoreOptions } from './snapshot.js';
export { sortedKeys } from './sorted.js';
export {
  createServiceKey,
  PHASE_ORDER,
  SYSTEM_PHASES,
  sliceKeyOf,
  type AnySystem,
  type DeepReadonly,
  type InitContext,
  type Phase,
  type PhaseHandler,
  type ServiceHandle,
  type ServiceKey,
  type ServiceRegistry,
  type System,
  type SystemPhase,
  type TickContext,
} from './system.js';
export {
  createWorld,
  isWorldPoisoned,
  step,
  submit,
  type CreateWorldOptions,
  type StepOptions,
  type TickResult,
  type World,
} from './world.js';
