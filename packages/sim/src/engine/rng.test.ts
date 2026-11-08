import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InvariantError, type RngStreamState } from '../schema/index.js';
import { fnv1a32, rngFromState, seedStream, xoshiro128ss } from './rng.js';

function freshState(s: [number, number, number, number]): RngStreamState {
  return { s: [...s] };
}

describe('xoshiro128** known-answer tests', () => {
  it('state [1, 2, 3, 4] -> first four outputs of the reference implementation', () => {
    // Values from the reference C xoshiro128** (Blackman & Vigna), recomputed with an independent
    // BigInt port: result = rotl(s1 * 5, 7) * 9.
    const s: [number, number, number, number] = [1, 2, 3, 4];
    expect([xoshiro128ss(s), xoshiro128ss(s), xoshiro128ss(s), xoshiro128ss(s)]).toEqual([
      11520, 0, 5927040, 70819200,
    ]);
  });

  it("seedStream(42, 'accounting') state and first four outputs are pinned", () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('accounting')).toBe(3165821668);
    const state = seedStream(42, 'accounting');
    expect(state.s).toEqual([3391659675, 2267818377, 2822910481, 2729959403]);
    const rng = rngFromState(state);
    expect([rng.nextU32(), rng.nextU32(), rng.nextU32(), rng.nextU32()]).toEqual([
      1638305113, 2997929381, 4116012097, 1815886744,
    ]);
  });

  it('uses the high 32 bits of seeds above 2^32', () => {
    expect(seedStream(2 ** 32, 'x').s).not.toEqual(seedStream(0, 'x').s);
    expect(seedStream(Number.MAX_SAFE_INTEGER, 'x').s.every((w) => w >>> 0 === w)).toBe(true);
  });

  it('rejects invalid seeds', () => {
    expect(() => seedStream(-1, 'x')).toThrow(InvariantError);
    expect(() => seedStream(1.5, 'x')).toThrow(InvariantError);
  });
});

describe('stream independence', () => {
  it("a stream's sequence depends only on (seed, name)", () => {
    const a1 = rngFromState(seedStream(7, 'accounting'));
    const expected = [a1.nextU32(), a1.nextU32(), a1.nextU32()];

    // Interleave with another stream: accounting must not move.
    const econ = rngFromState(seedStream(7, 'economy'));
    const a2 = rngFromState(seedStream(7, 'accounting'));
    econ.nextU32();
    const got = [a2.nextU32(), econ.nextU32(), a2.nextU32(), econ.int(0, 9), a2.nextU32()];
    expect([got[0], got[2], got[4]]).toEqual(expected);
  });

  it('different names and different seeds give different streams', () => {
    expect(seedStream(7, 'accounting').s).not.toEqual(seedStream(7, 'economy').s);
    expect(seedStream(7, 'accounting').s).not.toEqual(seedStream(8, 'accounting').s);
  });
});

describe('derived operations', () => {
  it('nextFloat is in [0, 1) and draws hi first', () => {
    const state = freshState([1, 2, 3, 4]);
    const f = rngFromState(state).nextFloat();
    const hi = 11520;
    const lo = 0;
    expect(f).toBe(((hi >>> 5) * 67108864 + (lo >>> 6)) * 2 ** -53);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });

  it('int with range 1 draws nothing', () => {
    const state = freshState([1, 2, 3, 4]);
    const rng = rngFromState(state);
    expect(rng.int(5, 5)).toBe(5);
    expect(state.s).toEqual([1, 2, 3, 4]);
  });

  it('int rejects bad ranges; pick rejects empty arrays', () => {
    const rng = rngFromState(seedStream(1, 't'));
    expect(() => rng.int(3, 2)).toThrow(InvariantError);
    expect(() => rng.int(0.5, 2)).toThrow(InvariantError);
    expect(() => rng.int(0, 2 ** 32)).toThrow(InvariantError);
    try {
      rng.pick([]);
      expect.unreachable();
    } catch (e) {
      expect((e as InvariantError).code).toBe('rng.pick_empty');
    }
  });

  it('chance consumes exactly two draws, even for p <= 0', () => {
    const a = seedStream(3, 'c');
    const b = seedStream(3, 'c');
    expect(rngFromState(a).chance(0)).toBe(false);
    rngFromState(b).nextFloat();
    expect(a.s).toEqual(b.s);
    expect(rngFromState(a).chance(1)).toBe(true);
  });

  it('property: int(min, max) is always within bounds', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 4_000_000_000 }),
        (seed, min, span) => {
          const rng = rngFromState(seedStream(seed, 'prop'));
          for (let i = 0; i < 20; i++) {
            const v = rng.int(min, min + span);
            if (!Number.isInteger(v) || v < min || v > min + span) return false;
          }
          return true;
        },
      ),
    );
  });

  it('property: shuffle is an in-place permutation and deterministic per seed', () => {
    fc.assert(
      fc.property(fc.nat(), fc.array(fc.integer(), { maxLength: 50 }), (seed, items) => {
        const a = [...items];
        const result = rngFromState(seedStream(seed, 'shuffle')).shuffle(a);
        const b = rngFromState(seedStream(seed, 'shuffle')).shuffle([...items]);
        const sortNum = (xs: number[]): number[] => [...xs].sort((x, y) => x - y);
        expect(result).toBe(a);
        expect(sortNum(a)).toEqual(sortNum(items));
        expect(a).toEqual(b);
      }),
    );
  });

  it('property: nextFloat is always in [0, 1)', () => {
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        const rng = rngFromState(seedStream(seed, 'f'));
        for (let i = 0; i < 20; i++) {
          const f = rng.nextFloat();
          if (!(f >= 0 && f < 1)) return false;
        }
        return true;
      }),
    );
  });
});
