/** Unit tests for the pure price-discovery functions (economy.md 4.2-4.3, 9). */
import { describe, expect, it } from 'vitest';
import { money } from '../schema/index.js';
import {
  captureFraction,
  clamp,
  demandResponse,
  imbalance,
  levelBounds,
  levelTarget,
  maxLevelStep,
  priceAtLevel,
  relaxLevel,
  updateImbalanceEma,
} from './pricing.js';

const ALPHA = 0.05;
const BETA = 0.25;
const KAPPA = 0.3;

/** Runs the two-filter cascade for `steps` ticks with a constant imbalance `x`. */
function run(
  x: number,
  steps: number,
  start: { level: number; ema: number } = { level: 1, ema: 0 },
): { levels: number[]; level: number; ema: number } {
  let { level, ema } = start;
  const levels: number[] = [level];
  for (let t = 0; t < steps; t++) {
    ema = updateImbalanceEma(ema, x, BETA);
    level = relaxLevel(level, ema, ALPHA, KAPPA);
    levels.push(level);
  }
  return { levels, level, ema };
}

/** Number of sign changes of consecutive differences, ignoring sub-1e-12 float noise. */
function signChanges(series: readonly number[]): number {
  let changes = 0;
  let last = 0;
  for (let i = 1; i < series.length; i++) {
    const d = (series[i] ?? 0) - (series[i - 1] ?? 0);
    if (Math.abs(d) < 1e-12) continue;
    const sign = d > 0 ? 1 : -1;
    if (last !== 0 && sign !== last) changes += 1;
    last = sign;
  }
  return changes;
}

describe('clamp / imbalance', () => {
  it('clamps to the closed interval', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('imbalance is (D - S) / max(D, S, 1) in [-1, 1]', () => {
    expect(imbalance(100, 100)).toBe(0);
    expect(imbalance(100, 0)).toBe(1);
    expect(imbalance(0, 100)).toBe(-1);
    expect(imbalance(0, 0)).toBe(0);
    expect(imbalance(100, 200)).toBe(-0.5);
    expect(imbalance(100, 50)).toBe(0.5);
    expect(imbalance(0.5, 0)).toBe(0.5); // denominator floored at 1
  });
});

describe('relaxation filters', () => {
  it('a balanced market at level 1 stays exactly at 1', () => {
    const { levels } = run(0, 500);
    expect(levels.every((l) => l === 1)).toBe(true);
  });

  it('target and bounds', () => {
    expect(levelTarget(1, KAPPA)).toBe(1 + KAPPA);
    expect(levelTarget(-1, KAPPA)).toBe(1 - KAPPA);
    expect(levelBounds(KAPPA)).toEqual({ lo: 1 - KAPPA, hi: 1 + KAPPA });
    expect(maxLevelStep(ALPHA, KAPPA)).toBe(2 * ALPHA * KAPPA);
  });

  it('unserved market (x = +1): level rises monotonically to 1 + kappa', () => {
    const { levels, level } = run(1, 720);
    expect(signChanges(levels)).toBe(0);
    expect(levels.every((l, i) => i === 0 || l >= (levels[i - 1] ?? 0))).toBe(true);
    expect(Math.abs(level - (1 + KAPPA))).toBeLessThan(1e-3);
    expect(level).toBeLessThanOrEqual(1 + KAPPA);
  });

  it('flooded market (x = -1): level falls monotonically to 1 - kappa and never below', () => {
    const { levels, level } = run(-1, 720);
    expect(signChanges(levels)).toBe(0);
    expect(Math.abs(level - (1 - KAPPA))).toBeLessThan(1e-3);
    expect(levels.every((l) => l >= 1 - KAPPA)).toBe(true);
  });

  it('converges to 1 from a perturbed start with at most one sign change (no oscillation)', () => {
    // Start at the top of the band with the EMA saturated: the target decays first, the level lags.
    const high = run(0, 720, { level: 1 + KAPPA, ema: 1 });
    expect(Math.abs(high.level - 1)).toBeLessThan(1e-3);
    expect(signChanges(high.levels)).toBe(0);
    // Start at 1 with a saturated EMA: the level first rises toward the decaying target, then falls.
    const bump = run(0, 720, { level: 1, ema: 1 });
    expect(Math.abs(bump.level - 1)).toBeLessThan(1e-3);
    expect(signChanges(bump.levels)).toBe(1);
    expect(Math.max(...bump.levels)).toBeLessThanOrEqual(1 + KAPPA);
  });

  it('shock and recovery: 100 days of 2x supply then balance, bounded, no overshoot below 1', () => {
    let level = 1;
    let ema = 0;
    const levels: number[] = [level];
    for (let t = 0; t < 720; t++) {
      const x = t >= 100 && t < 200 ? imbalance(100, 200) : 0;
      ema = updateImbalanceEma(ema, x, BETA);
      level = relaxLevel(level, ema, ALPHA, KAPPA);
      levels.push(level);
    }
    const during = levels.slice(100, 201);
    expect(during.every((l, i) => i === 0 || l <= (during[i - 1] ?? 0))).toBe(true);
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(1 - KAPPA);
    // 2x supply gives x = -0.5, so the floor of the excursion is 1 - 0.5 kappa, never lower.
    expect(Math.min(...levels)).toBeGreaterThan(1 - 0.5 * KAPPA - 1e-12);
    // After the shock the level bottoms out once (lag) and then recovers monotonically; it never
    // overshoots above 1 on the way back.
    const after = levels.slice(200);
    expect(signChanges(after)).toBeLessThanOrEqual(1);
    expect(Math.max(...after)).toBeLessThanOrEqual(1);
    expect(Math.abs((levels[720] ?? 0) - 1)).toBeLessThan(1e-3);
  });

  it('a level outside the band is pulled onto the band edge', () => {
    expect(relaxLevel(2, 0, ALPHA, KAPPA)).toBe(1 + KAPPA);
    expect(relaxLevel(0, 0, ALPHA, KAPPA)).toBe(1 - KAPPA);
  });
});

describe('demand response g(r) (economy.md 4.3, clearing table)', () => {
  const EPS = 1.5;
  const MAX = 1.5;

  it('table at r in {0.5, 1, 1 + 1/eps, 2}', () => {
    expect(captureFraction(0.5, EPS, MAX)).toBe(1.5); // 1.75 clamped to maxCapture
    expect(captureFraction(1, EPS, MAX)).toBe(1);
    expect(captureFraction(1 + 1 / EPS, EPS, MAX)).toBeCloseTo(0, 12);
    expect(captureFraction(2, EPS, MAX)).toBe(0);
  });

  it('is exactly 1 at the reference price and monotone non-increasing in price', () => {
    const ref = money(250);
    expect(demandResponse(EPS, ref, ref, { maxCapture: MAX })).toBe(1);
    let last = Infinity;
    for (let p = 1; p <= 600; p += 7) {
      const g = demandResponse(EPS, money(p), ref, { maxCapture: MAX });
      expect(g).toBeLessThanOrEqual(last);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(MAX);
      last = g;
    }
  });

  it('elasticity 0 means every price captures the baseline', () => {
    expect(demandResponse(0, money(10_000), money(1), { maxCapture: 3 })).toBe(1);
  });
});

describe('priceAtLevel', () => {
  it('rounds once via scaleMoney and floors at one minor unit', () => {
    expect(priceAtLevel(money(250), 1)).toBe(250);
    expect(priceAtLevel(money(250), 1.3)).toBe(325);
    expect(priceAtLevel(money(250), 0.7)).toBe(175);
    expect(priceAtLevel(money(1), 0.7)).toBe(1); // 0.7 rounds to 1
    expect(priceAtLevel(money(1), 0.4)).toBe(1); // 0.4 rounds to 0, floored to 1
    expect(priceAtLevel(money(3), 0.5)).toBe(2); // 1.5 rounds half away from zero
  });
});
