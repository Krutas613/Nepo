/**
 * World container and the tick loop (ARCHITECTURE.md sections 6 and 7; docs/design/engine.md
 * section 3).
 *
 * A `World` is a runtime container, not state: everything a step reads lives in `world.state`
 * (including RNG streams and queued commands), so `restore(snapshot(world))` is equivalent to the
 * original. Runtime-only bookkeeping (routing table, services, Rng wrappers, the current phase)
 * lives in a private `WeakMap` keyed by the world and is rebuilt identically by `restore`.
 *
 * `step` never hashes, zod-validates or deep-copies state unless a `StepOptions` flag asks for it.
 */
import {
  EMPTY_ACCOUNTING_STATE,
  InvariantError,
  ScenarioSchema,
  formatSchemaIssues,
  ok,
  systemOrderIndex,
  validateCommandInput,
  type Command,
  type CommandInput,
  type CommandType,
  type AccountingState,
  type CommandValidationError,
  type EntityKind,
  type Event,
  type EventInput,
  type IdOf,
  type Result,
  type Scenario,
  type SystemId,
  type WorldState,
} from '../schema/index.js';
import { calendarFromTick, type CalendarDate } from './calendar.js';
import { canonicalJson } from './canonical.js';
import { coreSystem } from './core.js';
import { findNonFinite } from './finite.js';
import { hashValue } from './hash.js';
import { issueId } from './registry.js';
import { createRng, seedStream, type Rng } from './rng.js';
import {
  SYSTEM_PHASES,
  sliceKeyOf,
  type AnySystem,
  type DeepReadonly,
  type InitContext,
  type Phase,
  type ServiceHandle,
  type ServiceKey,
  type ServiceRegistry,
  type SystemPhase,
  type TickContext,
} from './system.js';

// -------------------------------------------------------------------------------------------------
// Public types
// -------------------------------------------------------------------------------------------------

/** Runtime container, NOT state. Opaque beyond these fields. */
export interface World {
  /** Live state. Outside the engine treat it as read-only. */
  readonly state: WorldState;
  readonly scenario: Scenario;
  /** In `SYSTEM_ORDER`; always starts with the built-in `core` system. */
  readonly systems: readonly AnySystem[];
  /** Events of the most recent step (or of init, right after `createWorld`). */
  readonly lastEvents: readonly Event[];
}

export interface CreateWorldOptions {
  seed: number;
  scenario: Scenario;
  /** Domain systems; `core` is added by the engine. Caller order is irrelevant. */
  systems: readonly AnySystem[];
}

export interface StepOptions {
  /** Hash every other slice around each system phase; throw `slice.foreign_write` on change. */
  checkSliceOwnership?: boolean;
  /** Run `findNonFinite(state)` in finalize; throw `state.non_finite` on any offender. */
  checkFinite?: boolean;
}

export interface TickResult {
  /** The tick that was executed. */
  tick: number;
  date: CalendarDate;
  events: readonly Event[];
}

// -------------------------------------------------------------------------------------------------
// Internals
// -------------------------------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface WorldInternals {
  inStep: boolean;
  poisoned: boolean;
  /** Current phase while stepping, else null. */
  phase: Phase | null;
  /** Event buffer being filled (init or the current step), else null. */
  events: Event[] | null;
  /** `tick` stamped on emitted events. */
  eventTick: number;
  routing: Partial<Record<CommandType, SystemId>>;
  services: Map<string, unknown>;
  rngs: Map<string, Rng>;
  /** Systems whose service handle exposed their slice during the current phase (ownership check). */
  touched: Set<SystemId> | null;
}

const internalsByWorld = new WeakMap<World, WorldInternals>();

function internalsOf(world: World): WorldInternals {
  const internals = internalsByWorld.get(world);
  if (internals === undefined) {
    throw new InvariantError('world.unknown', 'not a world created by createWorld/restore');
  }
  return internals;
}

/**
 * Top-level state fields the engine owns and systems may change only through ctx/handle methods,
 * so the ownership check skips them: `registry` (`issueId`) and `rng` (`rng`/`rngFor`) in every
 * phase; `commandSeq` and `pendingCommands` (`submit`) only in `decide`, the one phase where submit
 * is legal (docs/design/engine.md section 3), so a direct queue write elsewhere is caught.
 */
const CTX_MUTATED_FIELDS: readonly string[] = ['registry', 'rng'];
const SUBMIT_MUTATED_FIELDS: readonly string[] = ['commandSeq', 'pendingCommands'];

function ownershipExclusions(system: SystemId, phase: SystemPhase): Set<string> {
  const exclude = new Set<string>([...CTX_MUTATED_FIELDS, sliceKeyOf(system)]);
  if (phase === 'decide') for (const field of SUBMIT_MUTATED_FIELDS) exclude.add(field);
  return exclude;
}

function stateRecord(state: WorldState): Record<string, unknown> {
  return state as unknown as Record<string, unknown>;
}

function readonlyView<T>(value: T): DeepReadonly<T> {
  return value as DeepReadonly<T>;
}

// -------------------------------------------------------------------------------------------------
// System validation and ordering
// -------------------------------------------------------------------------------------------------

/** The only system that may register the `close` phase (ADR-009). */
const CLOSE_OWNER: SystemId = 'accounting';

function orderSystems(systems: readonly AnySystem[]): AnySystem[] {
  const ids = new Set<SystemId>();
  for (const system of systems) {
    if (system.id === 'core') {
      throw new InvariantError('systems.reserved_id', 'core is built in; do not register it', {
        system: system.id,
      });
    }
    if (ids.has(system.id)) {
      throw new InvariantError('systems.duplicate_id', `system ${system.id} registered twice`, {
        system: system.id,
      });
    }
    ids.add(system.id);
    for (const phase of Object.keys(system.phases)) {
      if (!(SYSTEM_PHASES as readonly string[]).includes(phase)) {
        throw new InvariantError('systems.invalid_phase', `${system.id} registers phase ${phase}`, {
          system: system.id,
          phase,
        });
      }
    }
    // ADR-009: `close` is accounting-only; the one place the engine names a domain system id.
    if (system.phases.close !== undefined && system.id !== CLOSE_OWNER) {
      throw new InvariantError(
        'systems.close_reserved',
        `${system.id} registers close; only ${CLOSE_OWNER} may (post period-end entries in your own phase)`,
        { system: system.id, phase: 'close' },
      );
    }
    if (system.createService !== undefined && system.serviceKey === undefined) {
      throw new InvariantError(
        'services.missing_key',
        `${system.id} has createService but no serviceKey`,
        {
          system: system.id,
        },
      );
    }
  }
  const ordered: AnySystem[] = [coreSystem, ...systems];
  ordered.sort((a, b) => systemOrderIndex(a.id) - systemOrderIndex(b.id));
  return ordered;
}

function buildRouting(systems: readonly AnySystem[]): Partial<Record<CommandType, SystemId>> {
  const routing: Partial<Record<CommandType, SystemId>> = {};
  for (const system of systems) {
    for (const type of system.handles) {
      const existing = routing[type];
      if (existing !== undefined) {
        throw new InvariantError(
          'commands.duplicate_handler',
          `${type} handled by ${existing} and ${system.id}`,
          {
            type,
            systems: [existing, system.id],
          },
        );
      }
      routing[type] = system.id;
    }
  }
  return routing;
}

// -------------------------------------------------------------------------------------------------
// Context plumbing
// -------------------------------------------------------------------------------------------------

function emitEvent(internals: WorldInternals, source: SystemId, input: EventInput): void {
  const events = internals.events;
  if (events === null) {
    throw new InvariantError(
      'events.emit_outside_tick',
      `${source} emitted ${input.type} outside init/step`,
      {
        source,
        type: input.type,
      },
    );
  }
  events.push({ ...input, tick: internals.eventTick, seq: events.length, source });
}

function rejectCommand(
  internals: WorldInternals,
  source: SystemId,
  command: Command,
  code: string,
  reason: string,
): void {
  emitEvent(internals, source, {
    type: 'command.rejected',
    payload: {
      commandSeq: command.seq,
      commandType: command.type,
      issuer: command.issuer,
      code,
      reason,
    },
  });
}

function rngStream(world: World, internals: WorldInternals, name: string): Rng {
  let rng = internals.rngs.get(name);
  if (rng === undefined) {
    const state = world.state;
    rng = createRng(() => {
      let stream = state.rng[name];
      if (stream === undefined) {
        stream = seedStream(state.seed, name);
        state.rng[name] = stream;
      }
      return stream;
    });
    internals.rngs.set(name, rng);
  }
  return rng;
}

function makeServiceRegistry(internals: WorldInternals): ServiceRegistry {
  return {
    get<T>(key: ServiceKey<T>): T {
      if (!internals.services.has(key)) {
        throw new InvariantError('services.missing', `no service registered under ${key}`, { key });
      }
      return internals.services.get(key) as T;
    },
    has(key: ServiceKey<unknown>): boolean {
      return internals.services.has(key);
    },
  };
}

function createServiceFor(world: World, internals: WorldInternals, system: AnySystem): void {
  if (system.createService === undefined || system.serviceKey === undefined) return;
  const key = system.serviceKey;
  if (internals.services.has(key)) {
    throw new InvariantError('services.duplicate_key', `service key ${key} registered twice`, {
      key,
      system: system.id,
    });
  }
  const sliceKey = sliceKeyOf(system.id);
  const state = world.state;
  const handle: ServiceHandle<unknown> = {
    slice() {
      internals.touched?.add(system.id);
      return stateRecord(state)[sliceKey];
    },
    state: () => readonlyView(state),
    tick: () => state.tick,
    date: () => calendarFromTick(state.tick, state.epochYear),
    issueId: <K extends EntityKind>(kind: K): IdOf<K> => issueId(state.registry, kind),
    emit: (event) => {
      emitEvent(internals, system.id, event);
    },
  };
  internals.services.set(key, system.createService(handle));
}

function submitInternal(
  world: World,
  internals: WorldInternals,
  input: CommandInput,
): Result<number, CommandValidationError> {
  if (internals.inStep && internals.phase !== 'decide') {
    throw new InvariantError(
      'commands.submit_outside_decide',
      `submit during phase ${String(internals.phase)}`,
      {
        phase: internals.phase,
      },
    );
  }
  const parsed = validateCommandInput(input);
  if (!parsed.ok) return parsed;
  const state = world.state;
  state.commandSeq += 1;
  const seq = state.commandSeq;
  const tick = internals.inStep ? state.tick + 1 : state.tick;
  state.pendingCommands.push({ ...parsed.value, seq, tick });
  return ok(seq);
}

// -------------------------------------------------------------------------------------------------
// Construction
// -------------------------------------------------------------------------------------------------

/**
 * Builds a world around `state`. With `runInit`, runs `init` for every system in `SYSTEM_ORDER`
 * (assigning slices) and creates each system's service right after its init, so `InitContext.services`
 * holds the services of earlier systems. Without it (restore), only services are created.
 */
export function buildWorld(
  state: WorldState,
  scenario: Scenario,
  systems: readonly AnySystem[],
  runInit: boolean,
): World {
  const ordered = orderSystems(systems);
  const internals: WorldInternals = {
    inStep: false,
    poisoned: false,
    phase: null,
    events: null,
    eventTick: state.tick,
    routing: buildRouting(ordered),
    services: new Map(),
    rngs: new Map(),
    touched: null,
  };
  const world: Mutable<World> = { state, scenario, systems: ordered, lastEvents: [] };
  internalsByWorld.set(world, internals);
  const services = makeServiceRegistry(internals);

  if (runInit) {
    const initEvents: Event[] = [];
    internals.events = initEvents;
    for (const system of ordered) {
      const ctx: InitContext = {
        seed: state.seed,
        scenario: readonlyView(scenario),
        state: readonlyView(state),
        rng: rngStream(world, internals, system.id),
        issueId: (kind) => issueId(state.registry, kind),
        emit: (event) => {
          emitEvent(internals, system.id, event);
        },
        services,
      };
      stateRecord(state)[sliceKeyOf(system.id)] = system.init(ctx);
      createServiceFor(world, internals, system);
    }
    internals.events = null;
    world.lastEvents = initEvents;
  } else {
    for (const system of ordered) {
      if (!Object.hasOwn(state, sliceKeyOf(system.id))) {
        throw new InvariantError('restore.missing_slice', `state has no slice for ${system.id}`, {
          system: system.id,
        });
      }
      createServiceFor(world, internals, system);
    }
  }
  return world;
}

/** Creates a world: core fields, `core` init (companies), each system's init, services. */
export function createWorld(options: CreateWorldOptions): World {
  const { seed } = options;
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new InvariantError('world.invalid_seed', 'seed must be a non-negative safe integer', {
      seed,
    });
  }
  const parsed = ScenarioSchema.safeParse(options.scenario);
  if (!parsed.success) {
    throw new InvariantError('scenario.invalid', 'scenario failed validation', {
      issues: formatSchemaIssues(parsed.error),
    });
  }
  const scenario: Scenario = parsed.data;
  const state: WorldState = {
    seed,
    tick: 0,
    epochYear: scenario.epochYear,
    commandSeq: 0,
    pendingCommands: [],
    registry: { counters: {} },
    rng: {},
    companies: {},
    // Typed slice whose system may not be registered: a plain copy of schema's empty value (the
    // constant is deep-frozen; `structuredClone` is not in the sim's ES2022-only lib). The system's
    // init replaces it when registered (ARCHITECTURE.md section 2).
    accounting: JSON.parse(canonicalJson(EMPTY_ACCOUNTING_STATE)) as AccountingState,
  };
  return buildWorld(state, scenario, options.systems, true);
}

// -------------------------------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------------------------------

/**
 * Queues a command for the next `ingest`. Validates shape immediately (invalid -> `err`, nothing
 * queued); stamps `seq = ++state.commandSeq` and `tick` (between steps: `state.tick`; during the
 * `decide` phase: `state.tick + 1`). Legal between steps or during `decide`; any other phase throws
 * `InvariantError('commands.submit_outside_decide')`.
 */
export function submit(
  world: World,
  command: CommandInput,
): Result<number, CommandValidationError> {
  return submitInternal(world, internalsOf(world), command);
}

// -------------------------------------------------------------------------------------------------
// Step
// -------------------------------------------------------------------------------------------------

function sliceHashes(state: WorldState, exclude: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const record = stateRecord(state);
  for (const key of Object.keys(record).sort()) {
    if (!exclude.has(key)) out[key] = hashValue(record[key]);
  }
  return out;
}

function checkOwnership(
  state: WorldState,
  before: Record<string, string>,
  exclude: Set<string>,
  touched: ReadonlySet<SystemId>,
  system: SystemId,
  phase: SystemPhase,
  tick: number,
): void {
  for (const id of touched) exclude.add(sliceKeyOf(id));
  const after = sliceHashes(state, exclude);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    if (exclude.has(key)) continue;
    if (before[key] !== after[key]) {
      throw new InvariantError('slice.foreign_write', `${system} wrote ${key} during ${phase}`, {
        system,
        phase,
        slice: key,
        tick,
      });
    }
  }
}

function makeTickContext(
  world: World,
  internals: WorldInternals,
  system: AnySystem,
  phase: SystemPhase,
  commands: readonly Command[],
  date: CalendarDate,
  events: readonly Event[],
  services: ServiceRegistry,
): TickContext<unknown> {
  const state = world.state;
  const id = system.id;
  return {
    tick: state.tick,
    date,
    phase,
    scenario: readonlyView(world.scenario),
    state: readonlyView(state),
    slice: stateRecord(state)[sliceKeyOf(id)],
    rng: rngStream(world, internals, id),
    rngFor: (name) => rngStream(world, internals, `${id}/${name}`),
    commands,
    events,
    emit: (event) => {
      emitEvent(internals, id, event);
    },
    reject: (command, code, reason) => {
      rejectCommand(internals, id, command, code, reason);
    },
    submit: (command) => submitInternal(world, internals, command),
    issueId: (kind) => issueId(state.registry, kind),
    services,
  };
}

const NO_COMMANDS: readonly Command[] = [];

/**
 * Executes one tick: `ingest`, phases `apply`..`decide` (systems in `SYSTEM_ORDER`), `finalize`.
 * Returns the executed tick, its date and its events. Any thrown error poisons the world.
 */
export function step(world: World, options: StepOptions = {}): TickResult {
  const internals = internalsOf(world);
  if (internals.poisoned) {
    throw new InvariantError('world.poisoned', 'a previous step threw; the world is unusable');
  }
  if (internals.inStep) {
    throw new InvariantError('step.reentrant', 'step called while a step is running');
  }
  const state = world.state;
  const tick = state.tick;
  const date = calendarFromTick(tick, state.epochYear);
  const events: Event[] = [];
  const services = makeServiceRegistry(internals);
  internals.inStep = true;
  internals.events = events;
  internals.eventTick = tick;
  try {
    // 0. ingest: drain the queue in ascending seq; route or reject.
    internals.phase = 'ingest';
    const batch = state.pendingCommands;
    state.pendingCommands = [];
    const inbox: Partial<Record<SystemId, Command[]>> = {};
    for (const command of batch) {
      if (!Object.hasOwn(state.companies, command.issuer)) {
        rejectCommand(internals, 'core', command, 'unknown_issuer', `no company ${command.issuer}`);
        continue;
      }
      const target = internals.routing[command.type];
      if (target === undefined) {
        rejectCommand(
          internals,
          'core',
          command,
          'no_handler',
          `no system handles ${command.type}`,
        );
        continue;
      }
      (inbox[target] ??= []).push(command);
    }

    // 1..8: system phases.
    const ownership = options.checkSliceOwnership === true;
    for (const phase of SYSTEM_PHASES) {
      internals.phase = phase;
      for (const system of world.systems) {
        const handler = system.phases[phase];
        if (handler === undefined) continue;
        const ctx = makeTickContext(
          world,
          internals,
          system,
          phase,
          inbox[system.id] ?? NO_COMMANDS,
          date,
          events,
          services,
        );
        if (ownership) {
          const exclude = ownershipExclusions(system.id, phase);
          const before = sliceHashes(state, exclude);
          const touched = new Set<SystemId>();
          internals.touched = touched;
          handler(ctx);
          internals.touched = null;
          checkOwnership(state, before, exclude, touched, system.id, phase, tick);
        } else {
          handler(ctx);
        }
      }
    }

    // 9. finalize
    internals.phase = 'finalize';
    if (options.checkFinite === true) {
      const paths = findNonFinite(state);
      if (paths.length > 0) {
        throw new InvariantError('state.non_finite', `non-finite numbers at ${paths.join(', ')}`, {
          paths,
          tick,
        });
      }
    }
    state.tick = tick + 1;
    (world as Mutable<World>).lastEvents = events;
  } catch (error) {
    internals.poisoned = true;
    throw error;
  } finally {
    internals.inStep = false;
    internals.phase = null;
    internals.events = null;
    internals.touched = null;
  }
  return { tick, date, events };
}

/** True between a thrown step and the end of the world's life. */
export function isWorldPoisoned(world: World): boolean {
  return internalsOf(world).poisoned;
}
