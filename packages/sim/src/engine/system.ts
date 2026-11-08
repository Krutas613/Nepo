/**
 * Tick phases and the System interface (ARCHITECTURE.md section 6).
 *
 * Phase order (every `step`):
 *   0 ingest     engine   drain pendingCommands by seq, reject unknown_issuer / no_handler, route
 *   1 apply      systems  process routed commands (mutate own slice or ctx.reject)
 *   2 macro      economy
 *   3 production manufacturing
 *   4 logistics  logistics
 *   5 market     retail, economy, manufacturing
 *   6 finance    finance
 *   7 close      accounting ONLY: month/quarter/year close on ctx.date flags (ADR-009)
 *   8 decide     ai: ctx.submit commands for the next tick (the only phase where submit is legal)
 *   9 finalize   engine   debug checks, tick += 1
 * Within a phase systems run in `SYSTEM_ORDER` (schema).
 *
 * Registration rules (checked at `createWorld`/`restore`): `ingest`/`finalize` are engine-only
 * (`systems.invalid_phase`); `close` may be registered only by the system with id `accounting`
 * (`systems.close_reserved`). Domain systems post period-end entries in their own phase on the tick
 * whose `ctx.date.isMonthEnd` (etc.) is set, so they land before accounting's close.
 */
import type {
  Brand,
  Command,
  CommandInput,
  CommandValidationError,
  EntityKind,
  Event,
  EventInput,
  IdOf,
  Result,
  Scenario,
  SystemId,
  WorldState,
} from '../schema/index.js';
import type { CalendarDate } from './calendar.js';
import type { Rng } from './rng.js';

export type Phase =
  | 'ingest'
  | 'apply'
  | 'macro'
  | 'production'
  | 'logistics'
  | 'market'
  | 'finance'
  | 'close'
  | 'decide'
  | 'finalize';

/** The documented, fixed order of phases within one tick. */
export const PHASE_ORDER: readonly Phase[] = [
  'ingest',
  'apply',
  'macro',
  'production',
  'logistics',
  'market',
  'finance',
  'close',
  'decide',
  'finalize',
];

/** Phases a system may register handlers for (`ingest` and `finalize` are engine-only). */
export type SystemPhase = Exclude<Phase, 'ingest' | 'finalize'>;

export const SYSTEM_PHASES: readonly SystemPhase[] = [
  'apply',
  'macro',
  'production',
  'logistics',
  'market',
  'finance',
  'close',
  'decide',
];

/**
 * Type-level read-only view. The engine does not freeze state at runtime (too slow).
 *
 * Arrays are handled explicitly (tuples keep their shape) so that recursive types such as the
 * `JsonValue` of untyped slices (`ctx.state.retail`, ...) resolve instead of hitting TS2589.
 */
export type DeepReadonly<T> = T extends
  string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly unknown[]
      ? number extends T['length']
        ? readonly DeepReadonly<T[number]>[]
        : { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : { readonly [K in keyof T]: DeepReadonly<T[K]> };

/** A typed key under which a system registers its service API (ADR-007). */
export type ServiceKey<T> = Brand<string, 'ServiceKey'> & { readonly __type?: T };

export function createServiceKey<T>(name: string): ServiceKey<T> {
  return name as ServiceKey<T>;
}

export interface ServiceRegistry {
  /** Throws `InvariantError('services.missing')` if no service is registered under `key`. */
  get<T>(key: ServiceKey<T>): T;
  has(key: ServiceKey<unknown>): boolean;
}

export interface InitContext {
  readonly seed: number;
  readonly scenario: DeepReadonly<Scenario>;
  /** Slices of systems earlier in `SYSTEM_ORDER` are already initialised. */
  readonly state: DeepReadonly<WorldState>;
  /** Stream `${systemId}`. */
  readonly rng: Rng;
  issueId<K extends EntityKind>(kind: K): IdOf<K>;
  /** Init events form the pre-run log of tick 0 (`world.lastEvents` after `createWorld`). */
  emit(event: EventInput): void;
  /** Services of systems earlier in `SYSTEM_ORDER`. */
  readonly services: ServiceRegistry;
}

export interface TickContext<S> {
  readonly tick: number;
  readonly date: CalendarDate;
  readonly phase: SystemPhase;
  readonly scenario: DeepReadonly<Scenario>;
  /** Whole world, read-only. */
  readonly state: DeepReadonly<WorldState>;
  /** This system's slice: the ONLY mutable thing. */
  readonly slice: S;
  /** Default stream `${systemId}`. */
  readonly rng: Rng;
  /** Sub-stream `${systemId}/${name}`, created lazily. */
  rngFor(name: string): Rng;
  /** Routed to this system this tick, ascending seq (same in every phase). */
  readonly commands: readonly Command[];
  /** Everything emitted so far this tick, by all systems. */
  readonly events: readonly Event[];
  emit(event: EventInput): void;
  /** Emits `command.rejected` with `source` = this system. Never throws. */
  reject(command: Command, code: string, reason: string): void;
  /** `decide` phase only (`InvariantError('commands.submit_outside_decide')` otherwise). */
  submit(command: CommandInput): Result<number, CommandValidationError>;
  issueId<K extends EntityKind>(kind: K): IdOf<K>;
  readonly services: ServiceRegistry;
}

/** What a service closes over; lives for the world's lifetime. */
export interface ServiceHandle<S> {
  /** Current own slice (mutable). */
  slice(): S;
  state(): DeepReadonly<WorldState>;
  /** The immutable scenario the world was created from (survives `restore`; same as `ctx.scenario`). */
  scenario(): DeepReadonly<Scenario>;
  /**
   * The world's live service registry (same lookups as `ctx.services`). Services are created in
   * `SYSTEM_ORDER`, so during `createService` only earlier systems' services are present; lookups made
   * lazily inside a service method see every registered service. A service may call only services of
   * systems EARLIER in `SYSTEM_ORDER`; calling a later system's service is a dependency-direction
   * violation (reviewed, not enforced). Missing keys throw `InvariantError('services.missing')`.
   */
  readonly services: ServiceRegistry;
  tick(): number;
  date(): CalendarDate;
  issueId<K extends EntityKind>(kind: K): IdOf<K>;
  emit(event: EventInput): void;
}

/**
 * A phase handler. Declared through a method signature so `System<AccountingState>` is assignable
 * to `AnySystem` (method parameters are checked bivariantly).
 */
export type PhaseHandler<S> = { handle(ctx: TickContext<S>): void }['handle'];

export interface System<S> {
  /** Schema literal; also the slice key in `WorldState` (`core` owns `companies`). */
  readonly id: SystemId;
  /** Command types routed to this system; unique across systems. */
  readonly handles: readonly Command['type'][];
  /** Returns the initial slice; may issue IDs, emit, and call earlier systems' services. */
  init(ctx: InitContext): S;
  readonly phases: Partial<Record<SystemPhase, PhaseHandler<S>>>;
  /** Returns the object registered under `serviceKey`. */
  createService?(handle: ServiceHandle<S>): unknown;
  /** Required if `createService` is present. */
  readonly serviceKey?: ServiceKey<unknown>;
}

export type AnySystem = System<unknown>;

/** The `WorldState` key holding a system's slice. */
export function sliceKeyOf(id: SystemId): string {
  return id === 'core' ? 'companies' : id;
}
