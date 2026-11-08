/**
 * Stability proofs as fast-check properties (ADR-011 "why it cannot oscillate"):
 *
 * - bounded: for any admissible (alpha, beta, kappa), any start inside the band and any input
 *   sequence x_t in [-1, 1], every level is in [1 - kappa, 1 + kappa] and |xbar| <= 1;
 * - step-bounded: |Δlevel| <= 2 alpha kappa (plus one ulp of slack for the final addition);
 * - by construction, not by clamp: the unclamped update never leaves the band by more than 1e-12;
 * - fixed point: a constant input x drives the level to 1 + kappa x;
 * - no oscillation: under a constant input the level's direction changes at most once.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clamp,
  levelBounds,
  levelTarget,
  maxLevelStep,
  relaxLevel,
  updateImbalanceEma,
} from './pricing.js';

const rateArb = fc.double({ min: 0.001, max: 0.999, noNaN: true, noDefaultInfinity: true });
const kappaArb = fc.double({ min: 0.001, max: 0.5, noNaN: true, noDefaultInfinity: true });
const unitArb = fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true });

interface Params {
  alpha: number;
  beta: number;
  kappa: number;
  /** Start level as a fraction of the band: level0 = 1 + kappa * u. */
  u: number;
  ema0: number;
}

const paramsArb: fc.Arbitrary<Params> = fc.record({
  alpha: rateArb,
  beta: rateArb,
  kappa: kappaArb,
  u: unitArb,
  ema0: unitArb,
});

describe('price level stability (property)', () => {
  it('bounded: level stays in [1 - kappa, 1 + kappa], |xbar| <= 1, and |Δlevel| <= 2 alpha kappa', () => {
    fc.assert(
      fc.property(paramsArb, fc.array(unitArb, { maxLength: 300 }), (p, xs) => {
        const { lo, hi } = levelBounds(p.kappa);
        const maxStep = maxLevelStep(p.alpha, p.kappa);
        let level = 1 + p.kappa * p.u;
        let ema = p.ema0;
        for (const x of xs) {
          ema = updateImbalanceEma(ema, x, p.beta);
          const next = relaxLevel(level, ema, p.alpha, p.kappa);
          expect(Math.abs(ema)).toBeLessThanOrEqual(1);
          expect(next).toBeGreaterThanOrEqual(lo);
          expect(next).toBeLessThanOrEqual(hi);
          expect(Math.abs(next - level)).toBeLessThanOrEqual(maxStep + 1e-12);
          expect(Number.isFinite(next)).toBe(true);
          level = next;
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('by construction: the unclamped convex update leaves the band by at most float noise', () => {
    fc.assert(
      fc.property(paramsArb, fc.array(unitArb, { maxLength: 300 }), (p, xs) => {
        const { lo, hi } = levelBounds(p.kappa);
        let level = 1 + p.kappa * p.u;
        let ema = p.ema0;
        for (const x of xs) {
          const rawEma = ema + p.beta * (x - ema);
          expect(Math.abs(rawEma)).toBeLessThanOrEqual(1 + 1e-12);
          ema = clamp(rawEma, -1, 1);
          const raw = level + p.alpha * (levelTarget(ema, p.kappa) - level);
          expect(raw).toBeGreaterThanOrEqual(lo - 1e-12);
          expect(raw).toBeLessThanOrEqual(hi + 1e-12);
          const clamped = relaxLevel(level, ema, p.alpha, p.kappa);
          expect(Math.abs(clamped - raw)).toBeLessThanOrEqual(1e-12);
          level = clamped;
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('fixed point: a constant imbalance x drives the level to 1 + kappa x', () => {
    const slowRateArb = fc.double({ min: 0.01, max: 0.999, noNaN: true, noDefaultInfinity: true });
    fc.assert(
      fc.property(
        fc.record({ alpha: slowRateArb, beta: slowRateArb, kappa: kappaArb, u: unitArb, ema0: unitArb }),
        unitArb,
        (p, x) => {
          let level = 1 + p.kappa * p.u;
          let ema = p.ema0;
          for (let t = 0; t < 3000; t++) {
            ema = updateImbalanceEma(ema, x, p.beta);
            level = relaxLevel(level, ema, p.alpha, p.kappa);
          }
          expect(Math.abs(level - levelTarget(x, p.kappa))).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('no oscillation: under a constant imbalance the level changes direction at most once', () => {
    fc.assert(
      fc.property(paramsArb, unitArb, fc.integer({ min: 10, max: 2000 }), (p, x, steps) => {
        let level = 1 + p.kappa * p.u;
        let ema = p.ema0;
        let changes = 0;
        let lastSign = 0;
        for (let t = 0; t < steps; t++) {
          ema = updateImbalanceEma(ema, x, p.beta);
          const next = relaxLevel(level, ema, p.alpha, p.kappa);
          const d = next - level;
          level = next;
          if (Math.abs(d) < 1e-12) continue;
          const sign = d > 0 ? 1 : -1;
          if (lastSign !== 0 && sign !== lastSign) changes += 1;
          lastSign = sign;
        }
        expect(changes).toBeLessThanOrEqual(1);
      }),
      { numRuns: 1000 },
    );
  });
});
