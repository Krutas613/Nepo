import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { money } from '../schema/index.js';
import {
  amortisationSchedule,
  interestFor,
  overdraftInterest,
  principalDue,
  roundRate,
  splitRepayment,
} from './schedule.js';

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe('principalDue / amortisationSchedule', () => {
  it('splits evenly when divisible', () => {
    expect(amortisationSchedule(money(1_200), 12)).toEqual(Array<number>(12).fill(100));
  });

  it('pays the remainder by the largest-remainder rule and the last month takes what is left', () => {
    const s = amortisationSchedule(money(1_000), 3);
    expect(s).toEqual([333, 334, 333]);
    expect(sum(s)).toBe(1_000);
  });

  it('pays everything in the final month', () => {
    expect(principalDue(money(777), 1)).toBe(777);
    expect(principalDue(money(777), 0)).toBe(777);
  });

  it('a principal smaller than the term still sums exactly', () => {
    const s = amortisationSchedule(money(5), 12);
    expect(sum(s)).toBe(5);
    expect(s.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('rejects a bad term or a negative balance', () => {
    expect(() => amortisationSchedule(money(10), 0)).toThrow(/finance.invalid_term/);
    expect(() => principalDue(money(-1), 3)).toThrow(/finance.negative_outstanding/);
  });

  it('property: instalments sum exactly to principal and are near-equal for any principal/term', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 50 }),
        fc.integer({ min: 1, max: 120 }),
        (p, n) => {
          const s = amortisationSchedule(money(p), n);
          expect(s).toHaveLength(n);
          expect(sum(s)).toBe(p);
          const ideal = p / n;
          for (const x of s) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(Math.abs(x - ideal)).toBeLessThanOrEqual(2);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('interest', () => {
  it('prorates simple interest on the 360-day year', () => {
    // 12,000,000 at 6% for 20 days = 40,000
    expect(interestFor(money(12_000_000), 0.06, 20)).toBe(40_000);
    expect(interestFor(money(12_000_000), 0.06, 30)).toBe(60_000);
    expect(interestFor(money(12_000_000), 0.06, 0)).toBe(0);
    expect(interestFor(money(0), 0.06, 30)).toBe(0);
    expect(interestFor(money(100), 0, 30)).toBe(0);
  });

  it('overdraft interest is one day on the negative balance, zero otherwise', () => {
    // 1,000,000 overdrawn at 18% for one day = 500
    expect(overdraftInterest(money(-1_000_000), 0.18)).toBe(500);
    expect(overdraftInterest(money(0), 0.18)).toBe(0);
    expect(overdraftInterest(money(5), 0.18)).toBe(0);
  });

  it('property: interest is never negative and is monotone in days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -(2 ** 40), max: 2 ** 40 }),
        fc.double({ min: -1, max: 2, noNaN: true }),
        fc.integer({ min: -5, max: 30 }),
        (o, r, d) => {
          const i = interestFor(money(o), r, d);
          expect(i).toBeGreaterThanOrEqual(0);
          expect(Object.is(i, -0)).toBe(false);
          if (d >= 0 && d < 30) expect(interestFor(money(o), r, d + 1)).toBeGreaterThanOrEqual(i);
          expect(overdraftInterest(money(o), Math.abs(r))).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('roundRate / splitRepayment', () => {
  it('rounds float sums onto the 1e-6 grid', () => {
    expect(0.04 + 0.035).not.toBe(0.075);
    expect(roundRate(0.04 + 0.035)).toBe(0.075);
    expect(Object.is(roundRate(-0), -0)).toBe(false);
  });

  it('pays interest first, then principal, never more than owed', () => {
    expect(splitRepayment(money(50), money(80), money(1_000))).toEqual({
      interest: 50,
      principal: 0,
    });
    expect(splitRepayment(money(500), money(80), money(1_000))).toEqual({
      interest: 80,
      principal: 420,
    });
    expect(splitRepayment(money(5_000), money(80), money(1_000))).toEqual({
      interest: 80,
      principal: 1_000,
    });
  });
});
