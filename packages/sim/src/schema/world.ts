/**
 * The single world state object (ARCHITECTURE.md section 2, ADR-004).
 *
 * Plain JSON data only: no classes, functions, Map/Set/Date/bigint/undefined. Optional fields are
 * omitted, never `undefined`. Keyed collections are `Record<Id, T>` iterated in sorted-key order.
 * NaN, +-Infinity and -0 are forbidden everywhere.
 */
import { z } from 'zod';
import {
  AccountingStateSchema,
  EMPTY_ACCOUNTING_STATE,
  type AccountingState,
} from './accounting.js';
import { CommandSchema, type Command } from './commands.js';
import { CompanySchema, type Company } from './company.js';
import { EconomyStateSchema, EMPTY_ECONOMY_STATE, type EconomyState } from './economy.js';
import { FinanceStateSchema, EMPTY_FINANCE_STATE, type FinanceState } from './finance.js';
import { deepFreeze } from './freeze.js';
import {
  CompanyIdSchema,
  EntityKindSchema,
  RecordKeySchema,
  type CompanyId,
  type EntityKind,
} from './ids.js';
import { JsonValueSchema, type JsonValue } from './json.js';
import { checkKeyedBy } from './keyed.js';
import {
  EMPTY_MANUFACTURING_STATE,
  ManufacturingStateSchema,
  type ManufacturingState,
} from './manufacturing.js';
import { EMPTY_RETAIL_STATE, RetailStateSchema, type RetailState } from './retail.js';
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
export type TypedSliceSystemId =
  'core' | 'accounting' | 'economy' | 'manufacturing' | 'retail' | 'finance';

/** Typed slices whose key is their `SystemId` (every typed slice except `core`'s `companies`). */
export type TypedDomainSliceId = Exclude<TypedSliceSystemId, 'core'>;

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
  /** Stream name -> state. Stream names are never integer-like. */
  rng: Record<string, RngStreamState>;
  /** Core slice, owned by the engine's `core` system. */
  companies: Record<CompanyId, Company>;
  /** Owned by the `accounting` system. */
  accounting: AccountingState;
  /** Owned by `economy` (schema v2). */
  economy: EconomyState;
  /** Owned by `manufacturing` (schema v2). */
  manufacturing: ManufacturingState;
  /** Owned by `retail` (schema v2). */
  retail: RetailState;
  /** Owned by `finance` (schema v2). */
  finance: FinanceState;
  // M2: logistics; M3: ai; M4: hr. Each arrives as a new required property with a SCHEMA_VERSION
  // bump and migration notes; until then it may appear only as an untyped slice (`UntypedSlices`).
}

/**
 * The empty value of every typed domain slice, for the engine: `createWorld` installs a copy of
 * `EMPTY_TYPED_SLICES[id]` for each typed slice whose system is not registered, and migrations use
 * the same values, so no module hand-writes a slice shape. Deep-frozen: install copies.
 * (Assignable to `Readonly<Record<TypedDomainSliceId, unknown>>`, the type schema-m1.md names.)
 */
export const EMPTY_TYPED_SLICES: { readonly [K in TypedDomainSliceId]: WorldState[K] } = deepFreeze(
  {
    accounting: EMPTY_ACCOUNTING_STATE,
    economy: EMPTY_ECONOMY_STATE,
    manufacturing: EMPTY_MANUFACTURING_STATE,
    retail: EMPTY_RETAIL_STATE,
    finance: EMPTY_FINANCE_STATE,
  },
);

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
  logistics: JsonValueSchema.exactOptional(),
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
    rng: z.record(RecordKeySchema, RngStreamStateSchema),
    companies: z.record(CompanyIdSchema, CompanySchema),
    accounting: AccountingStateSchema,
    economy: EconomyStateSchema,
    manufacturing: ManufacturingStateSchema,
    retail: RetailStateSchema,
    finance: FinanceStateSchema,
  })
  .superRefine((state, ctx) => {
    checkKeyedBy(state.companies, 'id', (c) => c.id, ['companies'], ctx);
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
