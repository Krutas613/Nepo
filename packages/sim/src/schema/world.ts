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
import { JsonValueSchema, type JsonValue } from './json.js';
import { NonNegativeIntegerSchema, SafeIntegerSchema } from './money.js';
import type { SystemId } from './system.js';

/** Registry ID counters per entity kind; a missing kind means 0 issued. */
export interface RegistryState {
  counters: Partial<Record<EntityKind, number>>;
}

/** xoshiro128** state: four u32 words (section 9). */
export interface RngStreamState {
  s: [number, number, number, number];
}

/**
 * `SystemId`s whose slice is typed in `WorldState`. A typed slice is always present; when its system
 * is not registered the engine installs the slice's `EMPTY_<SLICE>` constant (section 2). The slice
 * key is the `SystemId`, except `core`, whose slice is `companies`.
 */
export type TypedSliceSystemId = 'core' | 'accounting';

/** `SystemId`s whose slice type has not landed yet. Shrinks by one each time a slice is typed. */
export type UntypedSliceId = Exclude<SystemId, TypedSliceSystemId>;

/**
 * Untyped-slice policy (ARCHITECTURE.md sections 2, 11, 14). Under a `SystemId` key with no typed
 * slice, state may carry any plain-JSON value (a test system, or a domain agent's work in progress);
 * schema validates nothing inside it. Every other unknown top-level key is rejected.
 *
 * Representation: one explicit optional `JsonValue` property per untyped `SystemId`, not an index
 * signature, so `WorldState` stays a closed object type: typed slices keep their exact types, a
 * misspelt key is still a compile error, and `WorldStateSchema` remains a strict object whose keys
 * mirror this type one for one (`satisfies z.ZodType<WorldState>` checks both directions).
 *
 * Shipped code must not read or write these properties: a system joins `DEFAULT_SYSTEMS` only once
 * its slice is typed. Typing a slice removes its id from `UntypedSliceId`, adds a required property
 * to `WorldState`, bumps `SCHEMA_VERSION`, and its migration replaces any pre-existing untyped value
 * under the key with the slice's initial value (section 11).
 */
export type UntypedSlices = Partial<Record<UntypedSliceId, JsonValue>>;

export interface WorldState extends UntypedSlices {
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
  // Each arrives as a new required property with a SCHEMA_VERSION bump and migration notes; until
  // then it may appear only as an untyped slice (`UntypedSlices`).
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

/** One `JsonValue` validator per untyped slice key; must list exactly the `UntypedSliceId`s. */
const untypedSliceShape = {
  economy: JsonValueSchema.exactOptional(),
  manufacturing: JsonValueSchema.exactOptional(),
  logistics: JsonValueSchema.exactOptional(),
  retail: JsonValueSchema.exactOptional(),
  finance: JsonValueSchema.exactOptional(),
  ai: JsonValueSchema.exactOptional(),
  hr: JsonValueSchema.exactOptional(),
} satisfies Record<UntypedSliceId, z.ZodType>;

export const WorldStateSchema = z
  .strictObject({
    ...untypedSliceShape,
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
