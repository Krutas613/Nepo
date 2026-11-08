import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SMOKE_SCENARIO } from '@nepo/sim/schema';
import type { RegressionFile } from './cli.js';
import { runSeed } from './runner.js';
import { SEEDS, SYSTEMS } from './helpers.js';

const path = new URL('./regression/hashes.json', import.meta.url);
const update = process.env['UPDATE_SNAPSHOTS'] === '1';

// A hash change means sim behaviour changed. It needs a deliberate, reviewed update (see README).
describe('regression: final state hash per seed (smoke, 5 years)', () => {
  const file = JSON.parse(readFileSync(path, 'utf8')) as RegressionFile;
  const observed: Record<string, string> = {};

  it.each(SEEDS)('seed %i', (seed) => {
    const r = runSeed(seed, {
      seeds: [seed],
      years: 5,
      scenario: SMOKE_SCENARIO,
      systems: SYSTEMS,
      hashEvery: 0,
      repeat: false,
      snapshotCheck: false,
    });
    observed[String(seed)] = r.finalHash;
    if (!update) expect(r.finalHash).toBe(file.hashes[String(seed)]);
  });

  it.runIf(update)('rewrites hashes.json (UPDATE_SNAPSHOTS=1)', () => {
    writeFileSync(path, JSON.stringify({ ...file, hashes: observed }, null, 2) + '\n');
  });
});
