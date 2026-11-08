/**
 * `GameStore`: the UI's only handle on the sim. Owns the `World`, the `GameClock`, the event ring
 * buffer and chart series. It is a vanilla external store (`subscribe` + `getView`) consumed by
 * `useSyncExternalStore` in `hooks.ts`.
 *
 * Rendering contract: listeners fire only at commit boundaries (once per frame batch, manual
 * step, dispatch, load or clock change), never once per tick. `GameView` is replaced on every
 * commit, but it points at the live, mutable `World`: read-only by convention, and selectors must
 * return narrow values (compared with an equality function) so unrelated views do not re-render.
 */
import {
  createWorld,
  hashState,
  isWorldPoisoned,
  restore,
  step,
  submit,
  type World,
} from '@nepo/sim/engine';
import {
  NepoError,
  SnapshotError,
  type CommandInput,
  type CommandValidationError,
  type Event,
} from '@nepo/sim/schema';
import type { AnySystem } from '@nepo/sim/engine';
import { browserScheduler, GameClock, type ClockState, type FrameScheduler } from './clock.js';
import { createLocalStorage, readSave, serializeWorld, type SaveStorage } from './saves.js';
import { cashOf, playerCompanyId } from './selectors.js';
import { SeriesBuffer, type SeriesPoint } from './series.js';
import { DEFAULT_SCENARIO, DEFAULT_SEED, SYSTEMS } from './systems.js';

export const EVENT_BUFFER_CAP = 10_000;
export const REJECTION_CAP = 100;
export const SERIES_CAP = 5_000;
/** The "last good" snapshot is refreshed at most this often (ticks). */
export const LAST_GOOD_INTERVAL = 90;

export interface Rejection {
  tick: number;
  commandSeq: number;
  commandType: string;
  issuer: string;
  code: string;
  reason: string;
}

export interface PoisonInfo {
  seed: number;
  tick: number;
  code: string;
  message: string;
}

export interface GameView {
  readonly world: World;
  /** Increments on every commit. */
  readonly version: number;
  readonly tick: number;
  readonly seed: number;
  /** Newest last; capped at `EVENT_BUFFER_CAP`. Includes the init events. */
  readonly events: readonly Event[];
  /** Newest last; capped at `REJECTION_CAP`. */
  readonly rejections: readonly Rejection[];
  readonly cashSeries: readonly SeriesPoint[];
  readonly clock: ClockState;
  readonly poisoned: PoisonInfo | null;
  /** Plain-JSON snapshot text of the last known-good state (for "export snapshot" after a crash). */
  readonly lastGood: string | null;
}

export type DispatchResult =
  { ok: true; seq: number; executesOnTick: number } | { ok: false; error: CommandValidationError };

export type LoadResult = { ok: true } | { ok: false; code: string; message: string };

export interface GameStoreOptions {
  scheduler?: FrameScheduler;
  /** Defaults to `localStorage` (or `null` where blocked). */
  storage?: SaveStorage | null;
  systems?: readonly AnySystem[];
  seed?: number;
  /** Start from an existing world instead of `createWorld` (tests, load-on-start). */
  world?: World;
}

type Listener = () => void;

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof NepoError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'unexpected', message: error.message };
  return { code: 'unexpected', message: String(error) };
}

export class GameStore {
  readonly storage: SaveStorage | null;
  private readonly systems: readonly AnySystem[];
  private readonly clock: GameClock;
  private readonly listeners = new Set<Listener>();
  private readonly cash = new SeriesBuffer(SERIES_CAP);
  private world: World;
  private events: Event[] = [];
  private rejections: Rejection[] = [];
  private poisoned: PoisonInfo | null = null;
  private lastGood: string | null = null;
  private lastGoodTick = -Infinity;
  private version = 0;
  private view: GameView;
  private eventsDirty = true;
  private eventsCopy: readonly Event[] = [];
  private cashDirty = true;
  private cashCopy: readonly SeriesPoint[] = [];

  constructor(options: GameStoreOptions = {}) {
    this.systems = options.systems ?? SYSTEMS;
    this.storage = options.storage === undefined ? createLocalStorage() : options.storage;
    this.world =
      options.world ??
      createWorld({
        seed: options.seed ?? DEFAULT_SEED,
        scenario: DEFAULT_SCENARIO,
        systems: this.systems,
      });
    this.clock = new GameClock({
      scheduler: options.scheduler ?? browserScheduler,
      step: () => {
        this.stepWorld();
      },
      commit: () => {
        this.commit();
      },
      onError: (error) => {
        this.markPoisoned(error);
      },
      onChange: () => {
        this.commit();
      },
    });
    this.resetBuffers();
    this.view = this.buildView();
  }

  // ---- external store protocol ------------------------------------------------------------

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getView = (): GameView => this.view;

  // ---- time controls ----------------------------------------------------------------------

  play(): void {
    if (this.poisoned === null) this.clock.play();
  }
  pause(): void {
    this.clock.pause();
  }
  toggle(): void {
    if (this.poisoned === null) this.clock.toggle();
  }
  setSpeed(ticksPerSecond: 1 | 5 | 30): void {
    this.clock.setSpeed(ticksPerSecond);
  }
  /** Advance exactly one tick (pauses a running clock). */
  stepOnce(): void {
    if (this.poisoned === null) this.clock.stepOnce();
  }
  /** Advance `count` ticks synchronously with a single commit (used by "skip a year", tests). */
  stepMany(count: number): void {
    if (this.poisoned !== null) return;
    this.clock.pause();
    try {
      for (let i = 0; i < count; i++) this.stepWorld();
    } catch (error) {
      this.markPoisoned(error);
    }
    this.commit();
  }

  // ---- commands ---------------------------------------------------------------------------

  /**
   * Queues a command for the next tick. Shape errors come back here; semantic rejections arrive as
   * `command.rejected` events after the next step and are collected in `GameView.rejections`.
   */
  dispatch(input: CommandInput): DispatchResult {
    const result = submit(this.world, input);
    if (!result.ok) return { ok: false, error: result.error };
    this.commit();
    return { ok: true, seq: result.value, executesOnTick: this.world.state.tick };
  }

  // ---- game lifecycle ---------------------------------------------------------------------

  newGame(seed: number): void {
    this.clock.pause();
    this.world = createWorld({ seed, scenario: DEFAULT_SCENARIO, systems: this.systems });
    this.poisoned = null;
    this.resetBuffers();
    this.commit();
  }

  /** Restores from snapshot JSON text. On failure the current game is untouched. */
  loadFromText(text: string): LoadResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, code: 'invalid_json', message: 'That is not valid JSON.' };
    }
    let next: World;
    try {
      next = restore(parsed, this.systems);
    } catch (error) {
      const { code, message } = describeError(error);
      const friendly: Record<string, string> = {
        invalid: 'The file is not a Nepo snapshot, or is damaged.',
        too_new: 'This save was written by a newer version of the game.',
        no_migration: 'This save is too old and cannot be migrated.',
        hash_mismatch: 'The save is corrupted (state hash does not match).',
        scenario_mismatch: 'The save is inconsistent (scenario and state disagree).',
      };
      const detail = error instanceof SnapshotError ? friendly[code] : undefined;
      return { ok: false, code, message: detail ?? message };
    }
    this.clock.pause();
    this.world = next;
    this.poisoned = null;
    this.resetBuffers();
    this.commit();
    return { ok: true };
  }

  loadSlot(slot: string): LoadResult {
    const text = this.storage === null ? null : readSave(this.storage, slot);
    if (text === null) return { ok: false, code: 'missing', message: `No save named "${slot}".` };
    return this.loadFromText(text);
  }

  /** Snapshot JSON of the live world, or `null` if poisoned (use `GameView.lastGood`). */
  serialize(): string | null {
    return isWorldPoisoned(this.world) ? null : serializeWorld(this.world);
  }

  /** `hashState` of the live state (16 hex chars): the replay/compare key shown after loading. */
  stateHash(): string {
    return hashState(this.world.state);
  }

  getWorld(): World {
    return this.world;
  }

  dispose(): void {
    this.clock.dispose();
    this.listeners.clear();
  }

  // ---- internals --------------------------------------------------------------------------

  private stepWorld(): void {
    const result = step(this.world);
    for (const event of result.events) {
      this.events.push(event);
      if (event.type === 'command.rejected') {
        this.rejections.push({ tick: event.tick, ...event.payload });
      }
    }
    if (result.events.length > 0) this.eventsDirty = true;
    this.recordSeries();
  }

  private recordSeries(): void {
    const state = this.world.state;
    const id = playerCompanyId(state);
    const cash = id === null ? null : cashOf(state, id);
    if (cash !== null) {
      this.cash.push(state.tick, cash);
      this.cashDirty = true;
    }
  }

  private resetBuffers(): void {
    this.events = [...this.world.lastEvents];
    this.rejections = [];
    this.cash.clear();
    this.lastGood = null;
    this.lastGoodTick = -Infinity;
    this.eventsDirty = true;
    this.cashDirty = true;
    this.recordSeries();
    this.refreshLastGood();
  }

  private markPoisoned(error: unknown): void {
    const { code, message } = describeError(error);
    this.poisoned = {
      seed: this.world.state.seed,
      tick: this.world.state.tick,
      code,
      message,
    };
  }

  private trimBuffers(): void {
    if (this.events.length > EVENT_BUFFER_CAP * 1.25) {
      this.events = this.events.slice(this.events.length - EVENT_BUFFER_CAP);
      this.eventsDirty = true;
    }
    if (this.rejections.length > REJECTION_CAP) {
      this.rejections = this.rejections.slice(this.rejections.length - REJECTION_CAP);
    }
  }

  private refreshLastGood(): void {
    if (this.poisoned !== null || isWorldPoisoned(this.world)) return;
    const tick = this.world.state.tick;
    if (tick - this.lastGoodTick < LAST_GOOD_INTERVAL && this.lastGood !== null) return;
    this.lastGood = serializeWorld(this.world);
    this.lastGoodTick = tick;
  }

  private buildView(): GameView {
    if (this.eventsDirty) {
      this.eventsCopy =
        this.events.length > EVENT_BUFFER_CAP
          ? this.events.slice(this.events.length - EVENT_BUFFER_CAP)
          : this.events.slice();
      this.eventsDirty = false;
    }
    if (this.cashDirty) {
      this.cashCopy = this.cash.snapshot();
      this.cashDirty = false;
    }
    const state = this.world.state;
    return {
      world: this.world,
      version: this.version,
      tick: state.tick,
      seed: state.seed,
      events: this.eventsCopy,
      rejections: this.rejections.slice(),
      cashSeries: this.cashCopy,
      clock: this.clock.getState(),
      poisoned: this.poisoned,
      lastGood: this.lastGood,
    };
  }

  private commit(): void {
    this.trimBuffers();
    this.refreshLastGood();
    this.version += 1;
    this.view = this.buildView();
    for (const listener of [...this.listeners]) listener();
  }
}
