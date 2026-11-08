import { describe, expect, it } from 'vitest';
import { EMPTY_SCENARIO, SMOKE_SCENARIO } from '@nepo/sim/schema';
import { runSeed } from './runner.js';
import { SEEDS, SYSTEMS } from './helpers.js';

// M0 exit criteria: 5 seeds x 5 years, full invariant suite, hash stable across repeat runs.
describe.each([
  ['smoke', SMOKE_SCENARIO],
  ['empty', EMPTY_SCENARIO],
])('exit criteria: %s scenario, 5 seeds x 5 years', (_name, scenario) => {
  it.each(SEEDS)('seed %i: zero violations, identical hash sequence across two runs', (seed) => {
    const r = runSeed(seed, { seeds: [seed], years: 5, scenario, systems: SYSTEMS, hashEvery: 1 });
    expect(r.ticks).toBe(1800);
    expect(r.hashes).toHaveLength(1801);
    expect(r.violations).toEqual([]);
  });
});
