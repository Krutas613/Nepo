import { describe, expect, it } from 'vitest';
import { hashState, restore, snapshot, step } from '@nepo/sim/engine';
import { SMOKE_SCENARIO } from '@nepo/sim/schema';
import { advance, makeWorld, SEEDS, SYSTEMS } from './helpers.js';

describe('snapshot/restore equivalence (5 seeds, 400 -> 1800 ticks)', () => {
  it.each(SEEDS)('seed %i', (seed) => {
    const straight = makeWorld(seed);
    advance(straight, 400);
    const text = JSON.stringify(snapshot(straight));
    advance(straight, 1400);

    const restored = restore(JSON.parse(text) as unknown, SYSTEMS, { scenario: SMOKE_SCENARIO });
    expect(restored.state.tick).toBe(400);
    for (let i = 0; i < 1400; i++) step(restored);
    expect(restored.state.tick).toBe(1800);
    expect(hashState(restored.state)).toBe(hashState(straight.state));
  });
});
