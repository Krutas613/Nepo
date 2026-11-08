/**
 * `GameClock`: the UI-owned run loop (player-flow.md section 4). The sim never sees wall-clock
 * time; this class converts frame timestamps into a whole number of `step` calls.
 *
 * Scheduling logic is separated from the browser via `FrameScheduler`, so tests drive it with a
 * fake. Time is accumulated in milli-ticks (`elapsedMs * ticksPerSecond`) so integer-millisecond
 * frames are exact: N frames covering T ms at 5x step exactly `floor(T * 5 / 1000)` times.
 */

export type TicksPerSecond = 1 | 5 | 30;
export const SPEEDS: readonly TicksPerSecond[] = [1, 5, 30];

export interface FrameScheduler {
  /** Calls `callback(nowMs)` once, on the next frame. Returns a handle for `cancel`. */
  request(callback: (nowMs: number) => void): number;
  cancel(handle: number): void;
}

export interface ClockState {
  readonly running: boolean;
  readonly ticksPerSecond: TicksPerSecond;
}

export interface GameClockOptions {
  scheduler: FrameScheduler;
  /** Advance the world by one tick. May throw; the clock then pauses and reports via `onError`. */
  step: () => void;
  /** Called once after each batch of steps (a frame, or a manual step): the render boundary. */
  commit: () => void;
  /** Called when `step` throws. */
  onError?: (error: unknown) => void;
  /** Called whenever `running` or `ticksPerSecond` changes. */
  onChange?: () => void;
  /** Steps per frame cap (default 60); excess backlog is dropped, not deferred. */
  maxStepsPerFrame?: number;
  initialSpeed?: TicksPerSecond;
}

export class GameClock {
  private readonly scheduler: FrameScheduler;
  private readonly stepFn: () => void;
  private readonly commitFn: () => void;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly onChange: (() => void) | undefined;
  private readonly maxSteps: number;
  private running = false;
  private speed: TicksPerSecond;
  private handle: number | null = null;
  private lastFrameMs: number | null = null;
  /** Milli-ticks owed (1000 = one tick). */
  private accumulator = 0;
  private disposed = false;
  private state: ClockState;

  constructor(options: GameClockOptions) {
    this.scheduler = options.scheduler;
    this.stepFn = options.step;
    this.commitFn = options.commit;
    this.onError = options.onError;
    this.onChange = options.onChange;
    this.maxSteps = options.maxStepsPerFrame ?? 60;
    this.speed = options.initialSpeed ?? 1;
    this.state = { running: false, ticksPerSecond: this.speed };
  }

  getState(): ClockState {
    return this.state;
  }

  play(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrameMs = null;
    this.accumulator = 0;
    this.requestFrame();
    this.changed();
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.cancelFrame();
    this.changed();
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  setSpeed(ticksPerSecond: TicksPerSecond): void {
    if (this.speed === ticksPerSecond) return;
    this.speed = ticksPerSecond;
    this.changed();
  }

  /** One tick now. Returns false if the step threw (the clock is then paused). */
  stepOnce(): boolean {
    if (this.disposed) return false;
    this.pause();
    return this.runSteps(1);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.cancelFrame();
  }

  private changed(): void {
    this.state = { running: this.running, ticksPerSecond: this.speed };
    this.onChange?.();
  }

  private requestFrame(): void {
    this.handle = this.scheduler.request((now) => {
      this.onFrame(now);
    });
  }

  private cancelFrame(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
  }

  private onFrame(nowMs: number): void {
    this.handle = null;
    if (!this.running) return;
    if (this.lastFrameMs !== null) {
      // A clock that goes backwards (tab restore quirks) contributes nothing.
      this.accumulator += Math.max(0, nowMs - this.lastFrameMs) * this.speed;
    }
    this.lastFrameMs = nowMs;
    const due = Math.floor(this.accumulator / 1000);
    const count = Math.min(due, this.maxSteps);
    // Keep the sub-tick fraction; drop any backlog beyond the cap so the UI stays responsive.
    this.accumulator -= due * 1000;
    if (count > 0) this.runSteps(count);
    if (this.isRunning()) this.requestFrame();
  }

  private isRunning(): boolean {
    return this.running;
  }

  private runSteps(count: number): boolean {
    let ok = true;
    try {
      for (let i = 0; i < count; i++) this.stepFn();
    } catch (error) {
      ok = false;
      this.running = false;
      this.cancelFrame();
      this.changed();
      this.onError?.(error);
    }
    this.commitFn();
    return ok;
  }
}

/** Browser scheduler over `requestAnimationFrame`. */
export const browserScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => {
    cancelAnimationFrame(handle);
  },
};
