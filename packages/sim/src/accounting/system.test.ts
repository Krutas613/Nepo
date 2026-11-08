/** Integration with the real engine: init, the service, and period close over 2 simulated years. */
import { describe, expect, it } from 'vitest';
import {
  createWorld,
  hashState,
  restore,
  snapshot,
  sortedKeys,
  step,
  type AnySystem,
  type System,
  type World,
} from '../engine/index.js';
import {
  AccountingStateSchema,
  SMOKE_SCENARIO,
  companyId,
  money,
  type AccountCode,
  type CompanyId,
  type Event,
  type Scenario,
} from '../schema/index.js';
import { ACCOUNTS, isIncomeAccount } from './chart.js';
import {
  cashPurchase,
  cashSale,
  depreciation,
  interestAccrual,
  loanDrawdown,
  loanRepayment,
  payroll,
} from './builders.js';
import { checkLedgerInvariants } from './invariants.js';
import { ACCOUNTING_SERVICE } from './service.js';
import { accountingSystem } from './system.js';

const P = companyId('co_000001');
const R = companyId('co_000002');

/**
 * Test-only domain system (id 'retail', empty slice) that posts a scripted, RNG-driven set of
 * entries every day through the AccountingApi, the way a real domain system would.
 */
const scriptedPoster: System<Record<string, never>> = {
  id: 'retail',
  handles: [],
  init: () => ({}),
  phases: {
    market(ctx) {
      const api = ctx.services.get(ACCOUNTING_SERVICE);
      for (const id of sortedKeys(ctx.state.companies)) {
        const cost = ctx.rng.int(1_000, 50_000);
        const price = cost + ctx.rng.int(0, 20_000);
        api.postOrThrow(id, cashPurchase(ACCOUNTS.INVENTORY_FINISHED, money(cost), 'retail'));
        api.postOrThrow(id, cashSale(money(price), money(cost), 'retail'));
        api.postOrThrow(id, payroll(money(ctx.rng.int(500, 5_000)), 'retail'));
        api.postOrThrow(id, interestAccrual(money(ctx.rng.int(1, 100)), 'retail'));
        if (ctx.date.isMonthStart) {
          api.postOrThrow(id, cashPurchase(ACCOUNTS.PPE, money(120_000), 'retail'));
          api.postOrThrow(id, depreciation(money(2_000), 'retail'));
        }
        if (ctx.date.dayOfYear === 10)
          api.postOrThrow(id, loanDrawdown(money(1_000_000), 'retail'));
        if (ctx.date.dayOfYear === 200)
          api.postOrThrow(id, loanRepayment(money(250_000), money(1_500), 'retail'));
      }
    },
  },
};

function newWorld(
  scenario: Scenario = SMOKE_SCENARIO,
  extra: AnySystem[] = [scriptedPoster],
): World {
  return createWorld({ seed: 7, scenario, systems: [...extra, accountingSystem] });
}

function incomeBalancesZero(world: World, id: CompanyId): boolean {
  const ledger = world.state.accounting.entities[id];
  if (ledger === undefined) return false;
  return (Object.keys(ledger.accounts) as AccountCode[])
    .filter(isIncomeAccount)
    .every((c) => ledger.accounts[c]?.balance === 0);
}

describe('accountingSystem init', () => {
  it('opens one ledger per company and posts opening capital Dr 1000 / Cr 3000', () => {
    const world = newWorld(SMOKE_SCENARIO, []);
    const acc = world.state.accounting;
    expect(Object.keys(acc.entities).sort()).toEqual([P, R]);
    expect(acc.journal.map((e) => [e.id, e.entityId, e.tick, e.source])).toEqual([
      ['je_000001', P, 0, 'accounting'],
      ['je_000002', R, 0, 'accounting'],
    ]);
    for (const id of [P, R]) {
      expect(acc.entities[id]?.accounts[ACCOUNTS.CASH]?.balance).toBe(100_000_000);
      expect(acc.entities[id]?.accounts[ACCOUNTS.SHARE_CAPITAL]?.balance).toBe(-100_000_000);
      expect(acc.entities[id]?.parentId).toBeNull();
    }
    const posted = world.lastEvents.filter((e) => e.type === 'ledger.posted');
    expect(posted.map((e) => e.source)).toEqual(['accounting', 'accounting']);
    expect(checkLedgerInvariants(acc)).toEqual([]);
  });

  it('matches startingCash by index and skips a zero opening capital', () => {
    const scenario: Scenario = {
      id: 'mixed',
      name: 'Mixed',
      epochYear: 1990,
      companies: [
        { name: 'Zero', controller: 'player', startingCash: money(0) },
        { name: 'Some', controller: 'ai', startingCash: money(123) },
      ],
    };
    const world = newWorld(scenario, []);
    expect(world.state.accounting.entities[P]?.accounts[ACCOUNTS.CASH]?.balance).toBe(0);
    expect(world.state.accounting.entities[R]?.accounts[ACCOUNTS.CASH]?.balance).toBe(123);
    expect(world.state.accounting.journal).toHaveLength(1);
    expect(world.state.accounting.journal[0]?.entityId).toBe(R);
  });

  it('works with no companies', () => {
    const world = createWorld({
      seed: 1,
      scenario: { id: 'e', name: 'E', epochYear: 2000, companies: [] },
      systems: [accountingSystem],
    });
    expect(world.state.accounting).toEqual({ entities: {}, journal: [] });
    for (let i = 0; i < 30; i++) step(world);
  });
});

describe('AccountingApi service', () => {
  it('exposes balance, cash, hasEntity, post, postOrThrow and openEntity inside a phase', () => {
    let ran = false;
    const probe: System<Record<string, never>> = {
      id: 'finance',
      handles: [],
      init: () => ({}),
      phases: {
        apply(ctx) {
          if (ctx.tick !== 0) return;
          ran = true;
          const service = ctx.services.get(ACCOUNTING_SERVICE);
          expect(service.hasEntity(P)).toBe(true);
          expect(service.hasEntity(companyId('co_000009'))).toBe(false);
          expect(service.cash(P)).toBe(100_000_000);
          expect(service.balance(P, ACCOUNTS.SHARE_CAPITAL)).toBe(-100_000_000);

          const bad = service.post(P, { memo: 'x', source: 'finance', lines: [] });
          expect(!bad.ok && bad.error.code).toBe('empty');
          expect(() => service.postOrThrow(P, payroll(money(0), 'finance'))).toThrow(
            /accounting.post_failed/,
          );

          const good = service.post(P, payroll(money(10), 'finance'));
          expect(good.ok && [good.value.id, good.value.tick]).toEqual(['je_000003', 0]);
          expect(service.cash(P)).toBe(100_000_000 - 10);

          const sub = companyId('co_000003');
          service.openEntity(sub, P);
          expect(service.hasEntity(sub)).toBe(true);
          expect(service.cash(sub)).toBe(0);
          expect(() => {
            service.openEntity(sub);
          }).toThrow(/accounting.entity_exists/);
        },
      },
    };
    const world = newWorld(SMOKE_SCENARIO, [probe]);
    const result = step(world, { checkSliceOwnership: true });
    expect(ran).toBe(true);
    expect(world.state.accounting.entities[companyId('co_000003')]?.parentId).toBe(P);
    expect(result.events.filter((e) => e.type === 'ledger.posted').map((e) => e.source)).toEqual([
      'accounting',
    ]);
  });
});

describe('period close over 2 simulated years with the real engine', () => {
  it('produces 24 month, 8 quarter and 2 year reports per company, all reconciling', () => {
    const world = newWorld();
    const closedEvents: Event[] = [];
    for (let i = 0; i < 720; i++) {
      const result = step(world, { checkSliceOwnership: i < 40, checkFinite: i % 90 === 0 });
      closedEvents.push(...result.events.filter((e) => e.type === 'period.closed'));
      expect(checkLedgerInvariants(world.state.accounting)).toEqual([]);
      if (result.date.isYearEnd) {
        expect(incomeBalancesZero(world, P)).toBe(true);
        expect(incomeBalancesZero(world, R)).toBe(true);
      }
      if (result.date.isMonthEnd) {
        // accounting closes before every later system in the close phase; no closing on other days
        expect(result.events.some((e) => e.type === 'period.closed')).toBe(true);
      } else {
        expect(result.events.some((e) => e.type === 'period.closed')).toBe(false);
      }
    }
    expect(world.state.tick).toBe(720);

    for (const id of [P, R]) {
      const reports = world.state.accounting.entities[id]?.reports ?? [];
      const count = (k: string): number => reports.filter((r) => r.kind === k).length;
      expect(count('month')).toBe(24);
      expect(count('quarter')).toBe(8);
      expect(count('year')).toBe(2);
      for (const r of reports) {
        expect(r.cashFlow.netChange).toBe(r.cashFlow.closingCash - r.cashFlow.openingCash);
        expect(r.balance.assets).toBe(r.balance.liabilities + r.balance.equity);
        expect(r.income.revenue).toBeGreaterThan(0);
      }
      const years = reports.filter((r) => r.kind === 'year');
      expect(years.map((r) => [r.year, r.month, r.tick])).toEqual([
        [2000, 12, 359],
        [2001, 12, 719],
      ]);
      // First year opens with zero cash and includes the opening capital as financing.
      expect(years[0]?.cashFlow.openingCash).toBe(0);
      expect(years[1]?.cashFlow.openingCash).toBe(years[0]?.cashFlow.closingCash);
      expect(years[0]?.cashFlow.financing).toBe(100_000_000 + 1_000_000 - 250_000);
      expect(years[0]?.cashFlow.investing).toBe(-12 * 120_000);
    }
    expect(
      closedEvents.filter((e) => e.type === 'period.closed' && e.payload.kind === 'month'),
    ).toHaveLength(48);
    expect(closedEvents.every((e) => e.source === 'accounting')).toBe(true);
  });

  it('the accounting slice satisfies the strict schema and survives snapshot/restore', () => {
    // The scripted poster adds a non-schema `retail` slice, so validate the accounting slice directly.
    const busy = newWorld();
    for (let i = 0; i < 400; i++) step(busy);
    expect(AccountingStateSchema.safeParse(busy.state.accounting).success).toBe(true);

    // Full snapshot round trip on an accounting-only world (state passes the strict WorldState schema).
    const a = newWorld(SMOKE_SCENARIO, []);
    for (let i = 0; i < 400; i++) step(a);
    const b = restore(snapshot(a), [accountingSystem]);
    for (let i = 0; i < 400; i++) {
      step(a);
      step(b);
    }
    expect(hashState(b.state)).toBe(hashState(a.state));
    expect(b.state.accounting.entities[P]?.reports).toHaveLength(
      a.state.accounting.entities[P]?.reports.length ?? -1,
    );
  });

  it('is deterministic: identical state hashes for the same seed', () => {
    const a = newWorld();
    const b = newWorld();
    for (let i = 0; i < 100; i++) {
      step(a);
      step(b);
    }
    expect(hashState(a.state)).toBe(hashState(b.state));
  });
});
