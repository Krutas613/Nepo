/**
 * The single world state object (ARCHITECTURE.md section 2, ADR-004).
 *
 * Plain JSON data only: no classes, functions, Map/Set/Date/bigint/undefined. Optional fields are
 * omitted, never `undefined`. Keyed collections are `Record<Id, T>` iterated in sorted-key order.
 * NaN, +-Infinity and -0 are forbidden everywhere.
 */
import { z } from 'zod';
import { AccountingStateSchema, type AccountingState } from './accounting.js';
import { CommandSchema, type Command } from './commands.js';
import { CompanySchema, type Company } from './company.js';
import { CompanyIdSchema, EntityKindSchema, type CompanyId, type EntityKind } from './ids.js';
import { NonNegativeIntegerSchema, SafeIntegerSchema } from './money.js';

/** Registry ID counters per entity kind; a missing kind means 0 issued. */
export interface RegistryState {
  counters: Partial<Record<EntityKind, number>>;
}

/** xoshiro128** state: four u32 words (section 9). */
export interface RngStreamState {
  s: [number, number, number, number];
}

export interface WorldState {
  /** Non-negative safe integer; the world seed. */
  seed: number;
  /** Ticks completed = the tick `step` will execute next. */
  tick: number;
  /** Calendar year of tick 0 (from the scenario). */
  epochYear: number;
  /** Last issued command sequence number (global, monotonic). */
  commandSeq: number;
  /** Queued for the next tick's ingest phase, ascending `seq`. */
  pendingCommands: Command[];
  registry: RegistryState;
  /** Stream name -> state. */
  rng: Record<string, RngStreamState>;
  /** Core slice, owned by the engine's `core` system. */
  companies: Record<CompanyId, Company>;
  /** Owned by the `accounting` system. */
  accounting: AccountingState;
  // Milestone 1+: economy, manufacturing, retail, finance; M2: logistics; M3: ai; M4: hr.
  // Each arrives as a new required property with a SCHEMA_VERSION bump and migration notes.
}

// ---------------------------------------------------------------------------------------------
// zod validators
// ---------------------------------------------------------------------------------------------

export const RegistryStateSchema = z.strictObject({
  counters: z.partialRecord(EntityKindSchema, NonNegativeIntegerSchema),
}) satisfies z.ZodType<RegistryState>;

const U32Schema = z.int().min(0).max(0xffffffff);

export const RngStreamStateSchema = z.strictObject({
  s: z.tuple([U32Schema, U32Schema, U32Schema, U32Schema]),
}) satisfies z.ZodType<RngStreamState>;

export const WorldStateSchema = z
  .strictObject({
    seed: NonNegativeIntegerSchema,
    tick: NonNegativeIntegerSchema,
    epochYear: SafeIntegerSchema,
    commandSeq: NonNegativeIntegerSchema,
    pendingCommands: z.array(CommandSchema),
    registry: RegistryStateSchema,
    rng: z.record(z.string(), RngStreamStateSchema),
    companies: z.record(CompanyIdSchema, CompanySchema),
    accounting: AccountingStateSchema,
  })
  .superRefine((state, ctx) => {
    for (const key of Object.keys(state.companies).sort()) {
      const company = state.companies[key as CompanyId];
      if (company !== undefined && company.id !== key) {
        ctx.addIssue({
          code: 'custom',
          path: ['companies', key, 'id'],
          message: `company keyed ${key} has id ${company.id}`,
        });
      }
    }
    let previousSeq = 0;
    state.pendingCommands.forEach((command, i) => {
      if (command.seq <= previousSeq || command.seq > state.commandSeq) {
        ctx.addIssue({
          code: 'custom',
          path: ['pendingCommands', i, 'seq'],
          message: 'pendingCommands must have strictly ascending seq in 1..commandSeq',
        });
      }
      previousSeq = command.seq;
    });
  }) satisfies z.ZodType<WorldState>;
