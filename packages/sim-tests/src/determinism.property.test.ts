import fc from 'fast-check';
import { describe, it } from 'vitest';
import { hashState } from '@nepo/sim/engine';
import { advance, makeWorld } from './helpers.js';

describe('determinism property', () => {
  it('random seed and tick count: two runs produce identical hashes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.integer({ min: 1, max: 400 }),
        (seed, ticks) => {
          const a = makeWorld(seed);
          const b = makeWorld(seed);
          advance(a, ticks);
          advance(b, ticks);
          return hashState(a.state) === hashState(b.state);
        },
      ),
      { numRuns: 25 },
    );
  });
});
