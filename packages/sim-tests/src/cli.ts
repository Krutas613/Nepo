/** Headless sweep CLI. Owned by the `qa` agent. See ../README.md. */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { accountingSystem } from '@nepo/sim/accounting';
import { EMPTY_SCENARIO, SMOKE_SCENARIO, type Scenario } from '@nepo/sim/schema';
import { runSweep, type SweepResult } from './runner.js';

export const HASHES_PATH = new URL('./regression/hashes.json', import.meta.url);

export function parseSeeds(spec: string): number[] {
  if (spec.includes(',')) {
    return spec.split(',').map((s) => {
      const n = Number(s.trim());
      if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad seed: ${s}`);
      return n;
    });
  }
  const n = Number(spec);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--seeds must be a count >= 1 or a list`);
  return Array.from({ length: n }, (_, i) => i + 1);
}

export function scenarioByName(name: string): Scenario {
  if (name === 'smoke') return SMOKE_SCENARIO;
  if (name === 'empty') return EMPTY_SCENARIO;
  throw new Error(`unknown scenario "${name}" (smoke|empty)`);
}

export interface RegressionFile {
  description: string;
  scenario: string;
  years: number;
  hashes: Record<string, string>;
}

function formatTable(res: SweepResult): string {
  const header = ['seed', 'ticks', 'final hash', 'cash', 'entries', 'reports', 'ms', 'viol'];
  const rows = res.results.map((r) => [
    String(r.seed),
    String(r.ticks),
    r.finalHash,
    String(r.metrics.totalCash),
    String(r.metrics.journalEntries),
    String(r.metrics.reports),
    r.durationMs.toFixed(0),
    String(r.violations.length),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [fmt(header), ...rows.map(fmt)].join('\n');
}

function main(): number {
  const { values } = parseArgs({
    options: {
      seeds: { type: 'string', default: '5' },
      years: { type: 'string', default: '5' },
      scenario: { type: 'string', default: 'smoke' },
      'hash-every': { type: 'string', default: '1' },
      'check-ownership': { type: 'boolean', default: false },
      'no-repeat': { type: 'boolean', default: false },
      json: { type: 'string' },
      'update-snapshots': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    args: process.argv.slice(2).filter((a) => a !== '--'),
  });
  const scenario = scenarioByName(values.scenario);
  const years = Number(values.years);
  const hashEvery = Number(values['hash-every']);
  const seeds = parseSeeds(values.seeds);
  const res = runSweep({
    seeds,
    years,
    scenario,
    systems: [accountingSystem],
    hashEvery,
    checkSliceOwnership: values['check-ownership'],
    repeat: !values['no-repeat'],
  });

  console.log(`scenario=${res.scenario} years=${years} hashEvery=${hashEvery}`);
  console.log(formatTable(res));
  const skipped = res.results[0]?.skipped ?? [];
  for (const s of skipped) console.log(`SKIPPED ${s.invariant}: ${s.reason}`);
  for (const r of res.results) {
    console.log(`seed=${r.seed} 8-year-end-close evaluated at ${r.yearEndChecks} year ends`);
  }
  for (const r of res.results) {
    for (const v of r.violations.slice(0, 20)) {
      console.log(
        `VIOLATION seed=${v.seed} tick=${v.tick} ${v.invariant}${v.entity ? ` entity=${v.entity}` : ''}: ${v.detail}`,
      );
    }
    if (r.violations.length > 20)
      console.log(`... ${r.violations.length - 20} more (seed ${r.seed})`);
  }

  if (values.json !== undefined) {
    writeFileSync(values.json, JSON.stringify(res, null, 2) + '\n');
    console.log(`wrote ${values.json}`);
  }

  if (values['update-snapshots']) {
    let file: RegressionFile;
    try {
      file = JSON.parse(readFileSync(HASHES_PATH, 'utf8')) as RegressionFile;
    } catch {
      file = { description: '', scenario: 'smoke', years: 5, hashes: {} };
    }
    if (res.scenario !== 'smoke' || years !== 5) {
      console.log('--update-snapshots requires --scenario smoke --years 5; not written');
    } else if (!res.pass) {
      console.log('refusing to update snapshots while violations exist');
    } else {
      file.hashes = Object.fromEntries(res.results.map((r) => [String(r.seed), r.finalHash]));
      writeFileSync(HASHES_PATH, JSON.stringify(file, null, 2) + '\n');
      console.log('updated src/regression/hashes.json');
    }
  }

  console.log(res.pass ? 'PASS' : 'FAIL');
  return res.pass ? 0 : 1;
}

process.exitCode = main();
