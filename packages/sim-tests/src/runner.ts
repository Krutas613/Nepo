/** Sweep runner: headless sim for N ticks per seed, invariants every tick, repeat-run hashing. */
import { ACCOUNTS } from '@nepo/sim/accounting';
import {
  DAYS_PER_YEAR,
  createWorld,
  hashState,
  step,
  type AnySystem,
  type World,
} from '@nepo/sim/engine';
import type { Scenario } from '@nepo/sim/schema';
import {
  compareHashSequences,
  isFirstTickAfterYearEnd,
  runInvariants,
  skippedInvariants,
  snapshotEquivalence,
  type Violation,
} from './invariants.js';

export interface SweepOptions {
  seeds: readonly number[];
  years: number;
  scenario: Scenario;
  systems: readonly AnySystem[];
  /** Hash every N ticks (1 = every tick). 0 disables hashing except the final hash. */
  hashEvery?: number;
  checkSliceOwnership?: boolean;
  /** Run each seed a second time and compare hash sequences. Default true. */
  repeat?: boolean;
  /** Check snapshot/restore equivalence at the midpoint. Default true. */
  snapshotCheck?: boolean;
}

export interface SeedMetrics {
  ticks: number;
  totalCash: number;
  journalEntries: number;
  reports: number;
  companies: number;
}

export interface SeedResult {
  seed: number;
  ticks: number;
  finalHash: string;
  hashes: string[];
  violations: Violation[];
  skipped: { invariant: string; reason: string }[];
  durationMs: number;
  /** Number of post-year-end ticks at which `8-year-end-close` was evaluated. */
  yearEndChecks: number;
  metrics: SeedMetrics;
}

export interface SweepResult {
  scenario: string;
  years: number;
  hashEvery: number;
  results: SeedResult[];
  pass: boolean;
}

export function metricsOf(world: World): SeedMetrics {
  const acc = world.state.accounting;
  let totalCash = 0;
  let reports = 0;
  const ids = Object.keys(acc.entities).sort();
  for (const id of ids) {
    const ledger = acc.entities[id as keyof typeof acc.entities];
    if (ledger === undefined) continue;
    totalCash += ledger.accounts[ACCOUNTS.CASH]?.balance ?? 0;
    reports += ledger.reports.length;
  }
  return {
    ticks: world.state.tick,
    totalCash,
    journalEntries: acc.journal.length,
    reports,
    companies: Object.keys(world.state.companies).length,
  };
}

interface Pass {
  world: World;
  hashes: string[];
  violations: Violation[];
  skipped: { invariant: string; reason: string }[];
  yearEndChecks: number;
}

function onePass(
  seed: number,
  ticks: number,
  opts: SweepOptions,
  withInvariants: boolean,
  hashEvery: number,
): Pass {
  const world = createWorld({ seed, scenario: opts.scenario, systems: opts.systems });
  const hashes: string[] = [];
  const violations: Violation[] = [];
  let skipped: { invariant: string; reason: string }[] = skippedInvariants();
  const ctx = { seed };
  let yearEndChecks = 0;
  const check = (): void => {
    if (!withInvariants) return;
    if (isFirstTickAfterYearEnd(world)) yearEndChecks++;
    const run = runInvariants(world, ctx);
    violations.push(...run.violations);
    skipped = run.skipped;
  };
  const record = (): void => {
    if (hashEvery > 0 && world.state.tick % hashEvery === 0) hashes.push(hashState(world.state));
  };
  check();
  record();
  const stepOpts = { checkSliceOwnership: opts.checkSliceOwnership ?? false };
  for (let i = 0; i < ticks; i++) {
    step(world, stepOpts);
    check();
    record();
  }
  return { world, hashes, violations, skipped, yearEndChecks };
}

export function runSeed(seed: number, opts: SweepOptions): SeedResult {
  const t0 = performance.now();
  const ticks = Math.round(opts.years * DAYS_PER_YEAR);
  const hashEvery = opts.hashEvery ?? 1;
  const first = onePass(seed, ticks, opts, true, hashEvery);
  const violations = [...first.violations];
  const finalHash = hashState(first.world.state);
  if (opts.repeat ?? true) {
    const second = onePass(seed, ticks, opts, false, hashEvery);
    violations.push(...compareHashSequences(first.hashes, second.hashes, seed, 'repeat-run'));
    const h2 = hashState(second.world.state);
    if (h2 !== finalHash) {
      violations.push({
        invariant: '6-hash-stability',
        seed,
        tick: ticks,
        detail: `repeat-run final hash ${h2} !== ${finalHash}`,
      });
    }
  }
  if (opts.snapshotCheck ?? true) {
    const mid = Math.floor(ticks / 2);
    const w = createWorld({ seed, scenario: opts.scenario, systems: opts.systems });
    for (let i = 0; i < mid; i++) step(w);
    violations.push(
      ...snapshotEquivalence(w, opts.systems, ticks - mid, (x) => void step(x), seed),
    );
  }
  return {
    seed,
    ticks,
    finalHash,
    hashes: first.hashes,
    violations,
    skipped: first.skipped,
    yearEndChecks: first.yearEndChecks,
    durationMs: performance.now() - t0,
    metrics: metricsOf(first.world),
  };
}

export function runSweep(opts: SweepOptions): SweepResult {
  const results = opts.seeds.map((s) => runSeed(s, opts));
  return {
    scenario: opts.scenario.id,
    years: opts.years,
    hashEvery: opts.hashEvery ?? 1,
    results,
    pass: results.every((r) => r.violations.length === 0),
  };
}
