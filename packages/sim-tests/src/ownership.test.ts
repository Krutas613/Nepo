import { describe, expect, it } from 'vitest';
import { findNonFinite, step } from '@nepo/sim/engine';
import { makeWorld } from './helpers.js';

describe('slice ownership + finite checks', () => {
  it('1 seed x 1 year with checkSliceOwnership and checkFinite does not throw', () => {
    const world = makeWorld(1);
    expect(() => {
      for (let i = 0; i < 360; i++) step(world, { checkSliceOwnership: true, checkFinite: true });
    }).not.toThrow();
    expect(world.state.tick).toBe(360);
    expect(findNonFinite(world.state)).toEqual([]);
  });
});
