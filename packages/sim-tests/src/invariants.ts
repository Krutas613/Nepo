/**
 * Invariant framework (ARCHITECTURE.md section 13). An invariant that cannot fail is worthless:
 * every active check has a corruption test in `invariants.test.ts`. Never weaken a check; when one
 * fails, route it to the owner named in `owner`.
 */
import { balanceSheet, checkLedgerInvariants } from '@nepo/sim/accounting';
import {
  calendarFromTick,
  findNonFinite,
  hashState,
  restore,
  snapshot,
  type World,
} from '@nepo/sim/engine';
import type { AccountingState, CompanyId } from '@nepo/sim/schema';
import type { AnySystem } from '@nepo/sim/engine';

export interface Violation {
  invariant: string;
  seed: number;
  tick: number;
  entity?: string;
  detail: string;
}

export interface InvariantContext {
  seed: number;
}

export interface Invariant {
  /** Stable id, e.g. `1-ledger`. */
  id: string;
  title: string;
  /** Directory/agent that owns the bug when this fails. */
  owner: string;
  /** Not applicable worlds are reported as skipped with `skipReason`. */
  applicable(world: World): boolean;
  skipReason?: string;
  check(world: World, ctx: InvariantContext): Violation[];
}

function violation(
  invariant: string,
  ctx: InvariantContext,
  world: World,
  detail: string,
  entity?: string,
): Violation {
  const v: Violation = { invariant, seed: ctx.seed, tick: world.state.tick, detail };
  if (entity !== undefined) v.entity = entity;
  return v;
}

/** Check 1: Σ balance === 0 per entity, every entry balanced (accounting's checker). */
export const ledgerInvariant: Invariant = {
  id: '1-ledger',
  title: 'Ledger: per-entity Σ balance === 0; every journal entry balanced',
  owner: 'packages/sim/src/accounting',
  applicable: () => true,
  check(world, ctx) {
    return checkLedgerInvariants(world.state.accounting).map((v) =>
      violation(this.id, ctx, world, `${v.code}: ${v.message}`, v.entityId),
    );
  },
};

function sumByLead(
  accounting: AccountingState,
  entityId: CompanyId,
): { assets: number; rest: number } {
  const ledger = accounting.entities[entityId];
  let assets = 0;
  let rest = 0;
  if (ledger === undefined) return { assets, rest };
  for (const code of Object.keys(ledger.accounts).sort()) {
    const acct = ledger.accounts[code as keyof typeof ledger.accounts];
    if (acct === undefined) continue;
    if (code.startsWith('1')) assets += acct.balance;
    else rest += acct.balance;
  }
  return { assets, rest };
}

/** Check 2: A = L + E (two independent formulations) and netChange === closing - opening. */
export const balanceSheetInvariant: Invariant = {
  id: '2-balance-sheet',
  title: 'Balance sheet: A = L + E now; every report: netChange === closingCash - openingCash',
  owner: 'packages/sim/src/accounting',
  applicable: () => true,
  check(world, ctx) {
    const out: Violation[] = [];
    const acc = world.state.accounting;
    for (const entityId of Object.keys(acc.entities).sort() as CompanyId[]) {
      const ledger = acc.entities[entityId];
      if (ledger === undefined) continue;
      const bs = balanceSheet(ledger);
      if (bs.assets !== bs.liabilities + bs.equity) {
        out.push(
          violation(
            this.id,
            ctx,
            world,
            `balanceSheet: assets ${bs.assets} !== liabilities ${bs.liabilities} + equity ${bs.equity}`,
            entityId,
          ),
        );
      }
      const raw = sumByLead(acc, entityId);
      if (raw.assets !== -raw.rest) {
        out.push(
          violation(
            this.id,
            ctx,
            world,
            `raw balances: Σ assets ${raw.assets} !== -(Σ non-assets) ${-raw.rest}`,
            entityId,
          ),
        );
      }
      ledger.reports.forEach((r, i) => {
        const cf = r.cashFlow;
        const where = `report #${i} ${r.kind} ${r.year}-${r.month}`;
        if (cf.netChange !== cf.closingCash - cf.openingCash) {
          out.push(
            violation(
              this.id,
              ctx,
              world,
              `${where}: netChange ${cf.netChange} !== closing ${cf.closingCash} - opening ${cf.openingCash}`,
              entityId,
            ),
          );
        }
        if (r.balance.assets !== r.balance.liabilities + r.balance.equity) {
          out.push(violation(this.id, ctx, world, `${where}: report A !== L + E`, entityId));
        }
      });
    }
    return out;
  },
};

/** Check 5: no NaN / Infinity / -0 anywhere in state. */
export const finiteInvariant: Invariant = {
  id: '5-finite',
  title: 'No NaN, Infinity or -0 in state',
  owner: 'the system owning the offending slice (path in detail)',
  applicable: () => true,
  check(world, ctx) {
    return findNonFinite(world.state).map((path) =>
      violation(this.id, ctx, world, `non-finite value at ${path}`),
    );
  },
};

/** True when the tick that just executed was a year end (derived from the calendar). */
export function isFirstTickAfterYearEnd(world: World): boolean {
  return (
    world.state.tick > 0 && calendarFromTick(world.state.tick - 1, world.state.epochYear).isYearEnd
  );
}

/**
 * Check 8: year-end close. `state.tick` is the next tick to execute, so when the tick that just
 * executed (`state.tick - 1`) was a year end, accounting's `close` phase has run and posted the
 * closing entry: every income-statement account (4xxx-7xxx) must be exactly 0 in every entity.
 */
export const yearEndCloseInvariant: Invariant = {
  id: '8-year-end-close',
  title: 'First tick after a year end: every income-statement account (4xxx-7xxx) is 0',
  owner: 'packages/sim/src/accounting',
  applicable: () => true,
  check(world, ctx) {
    const out: Violation[] = [];
    if (!isFirstTickAfterYearEnd(world)) return out;
    const acc = world.state.accounting;
    for (const entityId of Object.keys(acc.entities).sort() as CompanyId[]) {
      const ledger = acc.entities[entityId];
      if (ledger === undefined) continue;
      for (const code of Object.keys(ledger.accounts).sort()) {
        if (!/^[4-7]/.test(code)) continue;
        const bal = ledger.accounts[code as keyof typeof ledger.accounts]?.balance ?? 0;
        if (bal !== 0) {
          out.push(
            violation(
              this.id,
              ctx,
              world,
              `income-statement account ${code} has balance ${bal} after year-end close`,
              entityId,
            ),
          );
        }
      }
    }
    return out;
  },
};

function stub(id: string, title: string, until: string): Invariant {
  return {
    id,
    title,
    owner: 'n/a (stub)',
    applicable: () => false,
    skipReason: `not-applicable-until: ${until}`,
    check: () => [],
  };
}

export const negativeQuantityInvariant = stub(
  '3-non-negative',
  'No negative Quantity; no negative cash without credit',
  'M1 (inventory and credit facilities do not exist yet)',
);
export const goodsConservationInvariant = stub(
  '4-goods-conservation',
  'Goods conserved across production, transit and sales',
  'M1/M2 (manufacturing, logistics, retail checkers)',
);
export const economicSanityInvariant = stub(
  '7-economic-sanity',
  'Bounded price volatility, no permanent collapse, no runaway inflation',
  'M2 (economy system)',
);

/** Check 6 is run by the sweep (hash sequences across repeat runs) and `snapshotEquivalence`. */
export const hashStabilityId = '6-hash-stability';

export const INVARIANTS: readonly Invariant[] = [
  ledgerInvariant,
  balanceSheetInvariant,
  negativeQuantityInvariant,
  goodsConservationInvariant,
  finiteInvariant,
  economicSanityInvariant,
  yearEndCloseInvariant,
];

export interface InvariantRun {
  violations: Violation[];
  skipped: { invariant: string; reason: string }[];
}

export function runInvariants(
  world: World,
  ctx: InvariantContext,
  invariants: readonly Invariant[] = INVARIANTS,
): InvariantRun {
  const violations: Violation[] = [];
  const skipped: { invariant: string; reason: string }[] = [];
  for (const inv of invariants) {
    if (!inv.applicable(world)) {
      skipped.push({ invariant: inv.id, reason: inv.skipReason ?? 'not applicable' });
      continue;
    }
    violations.push(...inv.check(world, ctx));
  }
  return { violations, skipped };
}

/** Ids of the skipped stubs (constant for M0). */
export function skippedInvariants(): { invariant: string; reason: string }[] {
  return INVARIANTS.filter((i) => i.skipReason !== undefined).map((i) => ({
    invariant: i.id,
    reason: i.skipReason ?? '',
  }));
}

/** Compare two hash sequences; returns a violation for the first divergence. */
export function compareHashSequences(
  a: readonly string[],
  b: readonly string[],
  seed: number,
  label: string,
): Violation[] {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return [
        {
          invariant: hashStabilityId,
          seed,
          tick: i,
          detail: `${label}: hash sequences diverge at index ${i}: ${String(a[i])} vs ${String(b[i])} (lengths ${a.length}/${b.length})`,
        },
      ];
    }
  }
  return [];
}

/**
 * Snapshot/restore equivalence: snapshot `world` now (through JSON text), restore it, step both
 * `ticks` more, and compare the hash at every tick.
 * Both worlds are advanced; use throwaway worlds.
 */
export function snapshotEquivalence(
  world: World,
  systems: readonly AnySystem[],
  ticks: number,
  stepFn: (w: World) => void,
  seed: number,
): Violation[] {
  const text = JSON.stringify(snapshot(world));
  const restored = restore(JSON.parse(text) as unknown, systems);
  const a: string[] = [hashState(world.state)];
  const b: string[] = [hashState(restored.state)];
  for (let i = 0; i < ticks; i++) {
    stepFn(world);
    stepFn(restored);
    a.push(hashState(world.state));
    b.push(hashState(restored.state));
  }
  return compareHashSequences(a, b, seed, 'snapshot-restore');
}
