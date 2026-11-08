/**
 * Seeded, serializable RNG (ARCHITECTURE.md section 9, ADR-001, docs/design/engine.md section 1).
 *
 * Generator: xoshiro128** over four u32 words, using only `Math.imul`, shifts and xor, so it is
 * exact on every JS engine without bigint. Each named stream is seeded by splitmix32 over
 * `mix(seed, fnv1a32(name))`, so a stream's sequence depends only on `(seed, name)`: adding a
 * system or creating a stream later never perturbs any other stream.
 *
 * The algorithms here are frozen: their outputs are part of regression snapshots.
 */
import { InvariantError, type RngStreamState } from '../schema/index.js';

const TWO_POW_32 = 4294967296;
const TWO_POW_26 = 67108864;
const TWO_POW_NEG_53 = 1 / 9007199254740992;

export interface Rng {
  /** Uniform u32 in `[0, 2^32)`. The only primitive; everything else derives from it. */
  nextU32(): number;
  /** Uniform float in `[0, 1)` with 53 bits: two draws, `hi` first. */
  nextFloat(): number;
  /** Uniform integer in `[min, max]` inclusive, unbiased (rejection sampling). */
  int(min: number, max: number): number;
  /** `items[int(0, length - 1)]`; `InvariantError('rng.pick_empty')` on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher-Yates from the end using `int(0, i)`; returns the same array. */
  shuffle<T>(items: T[]): T[];
  /** `nextFloat() < p`; always consumes exactly two u32 draws. */
  chance(p: number): boolean;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** FNV-1a 32 over UTF-16 code units (each unit fed as low byte, then high byte). */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h ^= c & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= c >>> 8;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 generator seeded with `a` (docs/design/engine.md section 1). */
export function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** Initial state of stream `name` for world `seed` (a non-negative safe integer). */
export function seedStream(seed: number, name: string): RngStreamState {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new InvariantError('rng.invalid_seed', 'seed must be a non-negative safe integer', {
      seed,
    });
  }
  const lo = seed >>> 0;
  const hi = Math.floor(seed / TWO_POW_32) >>> 0;
  const h = fnv1a32(name);
  let x = (lo ^ h) >>> 0;
  x = (x ^ rotl(hi, 13)) >>> 0;
  const sm = splitmix32(x);
  const s: [number, number, number, number] = [sm(), sm(), sm(), sm()];
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) s[0] = 1;
  return { s };
}

/**
 * Advances `s` in place (xoshiro128**) and returns the next u32. `s` must hold four u32 words.
 */
export function xoshiro128ss(s: [number, number, number, number]): number {
  const s0 = s[0];
  const s1 = s[1];
  let s2 = s[2];
  let s3 = s[3];
  const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  s2 = (s2 ^ s0) >>> 0;
  s3 = (s3 ^ s1) >>> 0;
  const n1 = (s1 ^ s2) >>> 0;
  const n0 = (s0 ^ s3) >>> 0;
  s2 = (s2 ^ t) >>> 0;
  s3 = rotl(s3, 11);
  s[0] = n0;
  s[1] = n1;
  s[2] = s2;
  s[3] = s3;
  return result;
}

/**
 * Builds an `Rng` over a stream whose state is obtained by `getState` on every draw. The state
 * object is mutated in place, so no RNG state lives outside `WorldState`.
 */
export function createRng(getState: () => RngStreamState): Rng {
  const nextU32 = (): number => xoshiro128ss(getState().s);

  const nextFloat = (): number => {
    const hi = nextU32();
    const lo = nextU32();
    return ((hi >>> 5) * TWO_POW_26 + (lo >>> 6)) * TWO_POW_NEG_53;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new InvariantError(
        'rng.invalid_range',
        'int(min, max) needs safe integers, min <= max',
        {
          min,
          max,
        },
      );
    }
    const range = max - min + 1;
    if (range === 1) return min;
    if (range > TWO_POW_32) {
      throw new InvariantError('rng.range_too_large', 'int range exceeds 2^32', { min, max });
    }
    const limit = TWO_POW_32 - (TWO_POW_32 % range);
    let u = nextU32();
    while (u >= limit) u = nextU32();
    return min + (u % range);
  };

  return {
    nextU32,
    nextFloat,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new InvariantError('rng.pick_empty', 'pick from an empty array');
      }
      return items[int(0, items.length - 1)] as T;
    },
    shuffle<T>(items: T[]): T[] {
      for (let i = items.length - 1; i >= 1; i--) {
        const j = int(0, i);
        const tmp = items[i] as T;
        items[i] = items[j] as T;
        items[j] = tmp;
      }
      return items;
    },
    chance(p: number): boolean {
      if (Number.isNaN(p)) {
        throw new InvariantError('rng.invalid_probability', 'chance(p) with NaN');
      }
      return nextFloat() < p;
    },
  };
}

/** A standalone `Rng` over its own state object (handy for tests and tools). */
export function rngFromState(state: RngStreamState): Rng {
  return createRng(() => state);
}
