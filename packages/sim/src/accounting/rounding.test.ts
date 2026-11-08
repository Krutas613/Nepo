import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InvariantError, money } from '../schema/index.js';
import { allocateMoney, roundHalfAwayFromZero, scaleMoney } from './rounding.js';

const amountArb = fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 });

describe('roundHalfAwayFromZero', () => {
  it.each([
    [0, 0],
    [0.4, 0],
    [0.5, 1],
    [1.5, 2],
    [2.5, 3],
    [2.4999, 2],
    [-0.4, 0],
    [-0.5, -1],
    [-1.5, -2],
    [-2.5, -3],
    [-2.6, -3],
    [0.49999999999999994, 0],
    [-0.49999999999999994, 0],
    [4503599627370495.5, 4503599627370496],
  ])('%d -> %d', (x, expected) => {
    const r = roundHalfAwayFromZero(x);
    expect(r).toBe(expected);
    expect(Object.is(r, -0)).toBe(false);
  });

  it('throws on non-finite input', () => {
    expect(() => roundHalfAwayFromZero(Number.NaN)).toThrow(InvariantError);
    expect(() => roundHalfAwayFromZero(Infinity)).toThrow(InvariantError);
  });
});

describe('scaleMoney', () => {
  it.each([
    [100, 0.125, 13], // 12.5 -> 13
    [-100, 0.125, -13], // -12.5 -> -13
    [3, 0.5, 2], // 1.5 -> 2
    [5, 0.5, 3], // 2.5 -> 3 (not banker's 2)
    [-5, 0.5, -3],
    [1000, 0.0333, 33], // 33.3
    [1000, 0, 0],
    [-1, 0.4, 0], // -0.4 -> 0, never -0
    [7, -1, -7],
  ])('scaleMoney(%d, %d) === %d', (amount, ratio, expected) => {
    const r = scaleMoney(money(amount), ratio);
    expect(r).toBe(expected);
    expect(Object.is(r, -0)).toBe(false);
  });

  it('rejects a non-finite ratio and an unsafe result', () => {
    expect(() => scaleMoney(money(1), Number.NaN)).toThrow(/money.non_finite_ratio/);
    expect(() => scaleMoney(money(1), Infinity)).toThrow(/money.non_finite_ratio/);
    expect(() => scaleMoney(money(Number.MAX_SAFE_INTEGER), 2)).toThrow(/money.unsafe/);
  });

  it('property: within 0.5 of the exact product and sign-symmetric', () => {
    fc.assert(
      fc.property(amountArb, fc.double({ min: -10, max: 10, noNaN: true }), (a, ratio) => {
        const r = scaleMoney(money(a), ratio);
        expect(Number.isSafeInteger(r)).toBe(true);
        expect(Math.abs(r - a * ratio)).toBeLessThanOrEqual(0.5);
        expect(scaleMoney(money(-a), ratio)).toBe(r === 0 ? 0 : 0 - r);
      }),
    );
  });
});

describe('allocateMoney', () => {
  it.each([
    [100, [1, 1, 1], [34, 33, 33]], // tie: lowest index gets the extra unit
    [-100, [1, 1, 1], [-34, -33, -33]],
    [2, [1, 1, 1], [1, 1, 0]],
    [10, [1, 2, 3, 4], [1, 2, 3, 4]],
    [10, [0, 1], [0, 10]],
    [7, [0.5, 0.25, 0.25], [3, 2, 2]], // raw 3.5, 1.75, 1.75: leftover 2 to the 0.75 remainders
    [0, [3, 1], [0, 0]],
    [1, [1, 0, 1], [1, 0, 0]],
    [5, [1], [5]],
  ])('allocateMoney(%d, %j) -> %j', (total, weights, expected) => {
    expect(allocateMoney(money(total), weights)).toEqual(expected);
  });

  it('gives leftover units to the largest remainders first', () => {
    // raw: 1.2, 2.7, 3.1 -> base 1,2,3 (sum 6), 1 leftover to idx1 (0.7)
    expect(allocateMoney(money(7), [12, 27, 31])).toEqual([1, 3, 3]);
  });

  it('rejects invalid weights', () => {
    for (const w of [[], [0, 0], [-1, 2], [Number.NaN], [Infinity, 1]]) {
      expect(() => allocateMoney(money(10), w)).toThrow(/money.invalid_weights/);
    }
  });

  const weightsArb = fc
    .array(
      fc.oneof(
        fc.constant(0),
        fc.integer({ min: 1, max: 1000 }),
        fc.double({ min: 0, max: 1e6, noNaN: true }),
      ),
      {
        minLength: 1,
        maxLength: 12,
      },
    )
    .filter((ws) => ws.reduce((s, w) => s + w, 0) > 0);

  it('property: parts sum to total, each within 1 of its exact share, zero weights get 0', () => {
    fc.assert(
      fc.property(amountArb, weightsArb, (total, weights) => {
        const parts = allocateMoney(money(total), weights);
        expect(parts).toHaveLength(weights.length);
        expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
        const sumW = weights.reduce((s, w) => s + w, 0);
        parts.forEach((p, i) => {
          const w = weights[i] ?? 0;
          expect(Number.isSafeInteger(p)).toBe(true);
          expect(Object.is(p, -0)).toBe(false);
          expect(Math.abs(p - (total * w) / sumW)).toBeLessThan(1 + 1e-6);
          if (w === 0) expect(p).toBe(0);
          if (total >= 0) expect(p).toBeGreaterThanOrEqual(0);
          else expect(p).toBeLessThanOrEqual(0);
        });
      }),
    );
  });

  it('property: deterministic and sign-symmetric; equal weights differ by at most 1, lower index first', () => {
    fc.assert(
      fc.property(amountArb, fc.integer({ min: 1, max: 20 }), (total, n) => {
        const weights = Array.from({ length: n }, () => 1);
        const parts = allocateMoney(money(total), weights);
        expect(allocateMoney(money(total), weights)).toEqual(parts);
        expect(allocateMoney(money(-total), weights)).toEqual(
          parts.map((p) => (p === 0 ? 0 : 0 - p)),
        );
        // Non-increasing in magnitude: the extra units go to the lowest indices.
        for (let i = 1; i < parts.length; i++) {
          expect(Math.abs(parts[i - 1] ?? 0)).toBeGreaterThanOrEqual(Math.abs(parts[i] ?? 0));
          expect(Math.abs(parts[i - 1] ?? 0) - Math.abs(parts[i] ?? 0)).toBeLessThanOrEqual(1);
        }
      }),
    );
  });
});
