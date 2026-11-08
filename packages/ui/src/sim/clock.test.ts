import { describe, expect, it } from 'vitest';
import { GameClock, type FrameScheduler } from './clock.js';

/** Manual frame scheduler: `frame(ms)` runs the pending callback at that absolute time. */
class FakeScheduler implements FrameScheduler {
  private next = 1;
  private pending = new Map<number, (now: number) => void>();
  request(callback: (nowMs: number) => void): number {
    const handle = this.next++;
    this.pending.set(handle, callback);
    return handle;
  }
  cancel(handle: number): void {
    this.pending.delete(handle);
  }
  get hasPending(): boolean {
    return this.pending.size > 0;
  }
  frame(nowMs: number): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, cb] of entries) cb(nowMs);
  }
}

function setup(opts: { failAt?: number; maxStepsPerFrame?: number } = {}) {
  const scheduler = new FakeScheduler();
  const log = { steps: 0, commits: 0, errors: [] as unknown[], changes: 0 };
  const clock = new GameClock({
    scheduler,
    step: () => {
      log.steps += 1;
      if (opts.failAt !== undefined && log.steps === opts.failAt) throw new Error('boom');
    },
    commit: () => {
      log.commits += 1;
    },
    onError: (e) => log.errors.push(e),
    onChange: () => {
      log.changes += 1;
    },
    ...(opts.maxStepsPerFrame !== undefined ? { maxStepsPerFrame: opts.maxStepsPerFrame } : {}),
  });
  return { scheduler, clock, log };
}

describe('GameClock', () => {
  it('steps exactly floor(elapsed x speed) times over many 16ms frames at 5x', () => {
    const { scheduler, clock, log } = setup();
    clock.setSpeed(5);
    clock.play();
    scheduler.frame(1000); // first frame only anchors time
    let t = 1000;
    for (let i = 0; i < 125; i++) {
      t += 16;
      scheduler.frame(t);
    }
    const elapsed = t - 1000; // 2000 ms
    expect(elapsed).toBe(2000);
    expect(log.steps).toBe(Math.floor((elapsed * 5) / 1000));
    expect(log.steps).toBe(10);
  });

  it('keeps the fractional remainder across frames (1x, 250ms frames)', () => {
    const { scheduler, clock, log } = setup();
    clock.play();
    scheduler.frame(0);
    const stepsAfter: number[] = [];
    for (let t = 250; t <= 2000; t += 250) {
      scheduler.frame(t);
      stepsAfter.push(log.steps);
    }
    expect(stepsAfter).toEqual([0, 0, 0, 1, 1, 1, 1, 2]);
  });

  it('commits once per frame that stepped, not once per tick', () => {
    const { scheduler, clock, log } = setup();
    clock.setSpeed(30);
    clock.play();
    scheduler.frame(0);
    scheduler.frame(1000);
    expect(log.steps).toBe(30);
    expect(log.commits).toBe(1);
  });

  it('caps steps per frame and drops the backlog', () => {
    const { scheduler, clock, log } = setup({ maxStepsPerFrame: 60 });
    clock.setSpeed(30);
    clock.play();
    scheduler.frame(0);
    scheduler.frame(10_000); // a 10 s stall owes 300 ticks
    expect(log.steps).toBe(60);
    scheduler.frame(10_034); // next frame is back to normal pace
    expect(log.steps).toBe(61);
  });

  it('pause stops stepping and cancels the frame request', () => {
    const { scheduler, clock, log } = setup();
    clock.setSpeed(30);
    clock.play();
    scheduler.frame(0);
    scheduler.frame(100);
    const before = log.steps;
    clock.pause();
    expect(scheduler.hasPending).toBe(false);
    scheduler.frame(5000);
    expect(log.steps).toBe(before);
    expect(clock.getState().running).toBe(false);
  });

  it('step advances exactly one tick and pauses a running clock', () => {
    const { scheduler, clock, log } = setup();
    clock.play();
    expect(clock.stepOnce()).toBe(true);
    expect(log.steps).toBe(1);
    expect(log.commits).toBe(1);
    expect(clock.getState().running).toBe(false);
    expect(scheduler.hasPending).toBe(false);
  });

  it('a throwing step pauses, reports once, and still commits', () => {
    const { scheduler, clock, log } = setup({ failAt: 3 });
    clock.setSpeed(30);
    clock.play();
    scheduler.frame(0);
    scheduler.frame(1000);
    expect(log.steps).toBe(3);
    expect(log.errors).toHaveLength(1);
    expect(clock.getState().running).toBe(false);
    expect(scheduler.hasPending).toBe(false);
    expect(log.commits).toBe(1);
  });

  it('ignores a clock that runs backwards', () => {
    const { scheduler, clock, log } = setup();
    clock.setSpeed(30);
    clock.play();
    scheduler.frame(1000);
    scheduler.frame(500);
    expect(log.steps).toBe(0);
  });

  it('speed changes apply to subsequent frames and notify', () => {
    const { scheduler, clock, log } = setup();
    clock.play();
    scheduler.frame(0);
    scheduler.frame(1000);
    expect(log.steps).toBe(1);
    clock.setSpeed(5);
    scheduler.frame(2000);
    expect(log.steps).toBe(6);
    expect(clock.getState().ticksPerSecond).toBe(5);
    expect(log.changes).toBeGreaterThanOrEqual(2);
  });

  it('dispose cancels everything', () => {
    const { scheduler, clock } = setup();
    clock.play();
    clock.dispose();
    expect(scheduler.hasPending).toBe(false);
    clock.play();
    expect(scheduler.hasPending).toBe(false);
  });
});
