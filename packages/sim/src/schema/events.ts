/**
 * Events (ARCHITECTURE.md section 7.2). An append-only log per tick, numbered by `seq` in emission
 * order. Events are NOT part of `WorldState` and are not hashed (ADR-007).
 */
import { z } from 'zod';
import { PeriodKindSchema, type PeriodKind } from './accounting.js';
import { CommandTypeSchema, type CommandType } from './commands.js';
import {
  CompanyIdSchema,
  JournalEntryIdSchema,
  type CompanyId,
  type DistributiveOmit,
  type JournalEntryId,
} from './ids.js';
import { NonNegativeIntegerSchema, SafeIntegerSchema } from './money.js';
import { SystemIdSchema, type SystemId } from './system.js';

export interface EventBase {
  tick: number;
  /** 0.. within the tick, in emission order. */
  seq: number;
  source: SystemId;
}

export interface CommandRejectedPayload {
  commandSeq: number;
  commandType: CommandType;
  issuer: CompanyId;
  /** Stable machine code, e.g. `unknown_issuer`, `no_handler`, `not_owner`, `invalid_name`. */
  code: string;
  reason: string;
}

export interface CommandRejectedEvent extends EventBase {
  type: 'command.rejected';
  payload: CommandRejectedPayload;
}

export interface CompanyFoundedPayload {
  companyId: CompanyId;
  name: string;
}

export interface CompanyFoundedEvent extends EventBase {
  type: 'company.founded';
  payload: CompanyFoundedPayload;
}

export interface CompanyRenamedPayload {
  companyId: CompanyId;
  name: string;
}

export interface CompanyRenamedEvent extends EventBase {
  type: 'company.renamed';
  payload: CompanyRenamedPayload;
}

export interface LedgerPostedPayload {
  entryId: JournalEntryId;
  entityId: CompanyId;
  memo: string;
}

export interface LedgerPostedEvent extends EventBase {
  type: 'ledger.posted';
  payload: LedgerPostedPayload;
}

export interface PeriodClosedPayload {
  entityId: CompanyId;
  kind: PeriodKind;
  year: number;
  month: number;
}

export interface PeriodClosedEvent extends EventBase {
  type: 'period.closed';
  payload: PeriodClosedPayload;
}

export type Event =
  | CommandRejectedEvent
  | CompanyFoundedEvent
  | CompanyRenamedEvent
  | LedgerPostedEvent
  | PeriodClosedEvent;

export type EventType = Event['type'];

/** What `emit()` takes: the engine stamps `tick`, `seq` and `source`. */
export type EventInput = DistributiveOmit<Event, 'tick' | 'seq' | 'source'>;

/** Event payload by event type. */
export type EventPayload<T extends EventType> = Extract<Event, { type: T }>['payload'];

export const EVENT_TYPES: readonly EventType[] = [
  'command.rejected',
  'company.founded',
  'company.renamed',
  'ledger.posted',
  'period.closed',
];

// ---------------------------------------------------------------------------------------------
// zod validators (events are not in state; these serve tests, tools and the UI)
// ---------------------------------------------------------------------------------------------

const eventBaseShape = {
  tick: NonNegativeIntegerSchema,
  seq: NonNegativeIntegerSchema,
  source: SystemIdSchema,
};

export const CommandRejectedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('command.rejected'),
  payload: z.strictObject({
    commandSeq: NonNegativeIntegerSchema,
    commandType: CommandTypeSchema,
    issuer: CompanyIdSchema,
    code: z.string(),
    reason: z.string(),
  }),
}) satisfies z.ZodType<CommandRejectedEvent>;

export const CompanyFoundedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('company.founded'),
  payload: z.strictObject({ companyId: CompanyIdSchema, name: z.string() }),
}) satisfies z.ZodType<CompanyFoundedEvent>;

export const CompanyRenamedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('company.renamed'),
  payload: z.strictObject({ companyId: CompanyIdSchema, name: z.string() }),
}) satisfies z.ZodType<CompanyRenamedEvent>;

export const LedgerPostedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('ledger.posted'),
  payload: z.strictObject({
    entryId: JournalEntryIdSchema,
    entityId: CompanyIdSchema,
    memo: z.string(),
  }),
}) satisfies z.ZodType<LedgerPostedEvent>;

export const PeriodClosedEventSchema = z.strictObject({
  ...eventBaseShape,
  type: z.literal('period.closed'),
  payload: z.strictObject({
    entityId: CompanyIdSchema,
    kind: PeriodKindSchema,
    year: SafeIntegerSchema,
    month: z.int().min(1).max(12),
  }),
}) satisfies z.ZodType<PeriodClosedEvent>;

export const EventSchema = z.discriminatedUnion('type', [
  CommandRejectedEventSchema,
  CompanyFoundedEventSchema,
  CompanyRenamedEventSchema,
  LedgerPostedEventSchema,
  PeriodClosedEventSchema,
]) satisfies z.ZodType<Event>;
