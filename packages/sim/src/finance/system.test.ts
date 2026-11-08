/** Integration with the real engine and accounting: loan life, insolvency path, determinism. */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  accountingSystem,
  checkLedgerInvariants,
  getBalance,
} from '../accounting/index.js';
import {
  createWorld,
  hashState,
  restore,
  snapshot,
  step,
  submit,
  type AnySystem,
  type ServiceRegistry,
  type World,
} from '../engine/index.js';
import {
  SMOKE_SCENARIO,
  VERTICAL_SLICE_SCENARIO,
  accountCode,
  loanId,
  money,
  negMoney,
  type CommandInput,
  type Event,
  type FinanceState,
  type LoanId,
  type Scenario,
} from '../schema/index.js';
import { checkFinanceInvariants, checkLoanTransitions } from './invariants.js';
import { FINANCE_SERVICE, type FinanceApi } from './service.js';
import { financeSystem } from './system.js';
import { BANK, PLAYER, RIVAL, cashScriptSystem, type CashScript } from './test-helpers.js';

/**
 * Probe (id `ai`, an untyped slice): its `init` runs after finance's (SYSTEM_ORDER), so it can hand
 * the test the world's service registry, the way a UI adapter would hold `FinanceApi`.
 */
function probeSystem(sink: { services: ServiceRegistry | null }): AnySystem {
  return {
    id: 'ai',
    handles: [],
    init: (ctx) => {
      sink.services = ctx.services;
      return {};
    },
    phases: {},
  };
}

interface Built {
  world: World;
  api: FinanceApi;
}

function build(scenario: Scenario = VERTICAL_SLICE_SCENARIO, script?: CashScript): Built {
  const sink: { services: ServiceRegistry | null } = { services: null };
  const systems: AnySystem[] = [accountingSystem, financeSystem, probeSystem(sink)];
  if (script !== undefined) systems.push(cashScriptSystem(script));
  const world = createWorld({ seed: 7, scenario, systems });
  if (sink.services === null) throw new Error('probe did not run');
  return { world, api: sink.services.get(FINANCE_SERVICE) };
}

type Script = Partial<Record<number, CommandInput[]>>;

/** Steps until `state.tick === until`, submitting `script[tick]` first and checking every tick. */
function run(
  world: World,
  until: number,
  script: Script = {},
  onTick?: (events: readonly Event[]) => void,
): Event[] {
  const events: Event[] = [];
  while (world.state.tick < until) {
    for (const cmd of script[world.state.tick] ?? []) expect(submit(world, cmd).ok).toBe(true);
    const before = JSON.parse(JSON.stringify(world.state.finance)) as FinanceState;
    const result = step(world, { checkSliceOwnership: true, checkFinite: true });
    events.push(...result.events);
    onTick?.(result.events);
    const { finance, accounting } = world.state;
    expect(checkLedgerInvariants(accounting)).toEqual([]);
    expect(checkFinanceInvariants(world.state, world.scenario.content)).toEqual([]);
    expect(checkLoanTransitions(before, finance)).toEqual([]);
  }
  return events;
}

const request = (principal: number, termMonths: number): CommandInput => ({
  type: 'loan.request',
  issuer: PLAYER,
  payload: { companyId: PLAYER, principal: money(principal), termMonths },
});

const repay = (id: LoanId, amount: number): CommandInput => ({
  type: 'loan.repay',
  issuer: PLAYER,
  payload: { loanId: id, amount: money(amount) },
});

const ofType = <T extends Event['type']>(events: readonly Event[], type: T) =>
  events.filter((e): e is Extract<Event, { type: T }> => e.type === type);

const LN1 = loanId('ln_000001');

describe('financeSystem init and service', () => {
  it('creates one credit record per company and no loans', () => {
    const { world } = build(SMOKE_SCENARIO);
    const clean = { overdrawnSince: null, insolventSince: null, overdraftAccrued: 0 };
    expect(world.state.finance).toEqual({
      loans: {},
      credit: {
        [PLAYER]: { companyId: PLAYER, ...clean },
        [RIVAL]: { companyId: RIVAL, ...clean },
      },
    });
  });

  it('FinanceApi: reads work at once; quotes need content bound by the first phase', () => {
    const { world, api } = build();
    expect(api.loansOf(PLAYER)).toEqual([]);
    expect(api.credit(PLAYER)?.overdrawnSince).toBeNull();
    expect(api.credit(RIVAL)).toBeNull();
    expect(api.totalDebt(PLAYER)).toBe(0);
    expect(() => api.availableCredit(PLAYER)).toThrow(/finance.content_unbound/);
    run(world, 1);
    expect(api.availableCredit(PLAYER)).toBe(50_000_000);
    const quote = api.quoteLoan(PLAYER, money(30_000_000), 24);
    expect(quote.ok && quote.value.annualRate).toBe(0.075); // leverage 0.6 -> tier 2, policy 4%
    const no = api.quoteLoan(PLAYER, money(50_000_001), 24);
    expect(no.ok ? null : no.error.code).toBe('principal_too_large');
  });

  it('rejects bad commands through command.rejected and changes nothing', () => {
    const { world } = build(SMOKE_SCENARIO);
    const events = run(world, 2, {
      0: [
        request(1_000_000, 12), // SMOKE content has no bank
        {
          type: 'loan.request',
          issuer: RIVAL,
          payload: { companyId: PLAYER, principal: money(1_000_000), termMonths: 12 },
        },
        repay(LN1, 5),
      ],
    });
    expect(ofType(events, 'command.rejected').map((e) => e.payload.code)).toEqual([
      'no_bank',
      'not_owner',
      'unknown_loan',
    ]);
    expect(world.state.finance.loans).toEqual({});
  });
});

describe('a 24-month loan on the vertical slice', () => {
  it('2500 tracks outstanding every tick, interest posts monthly, the loan closes at term', () => {
    const { world, api } = build();
    const principal = 24_000_000;
    let monthsWithInterest = 0;
    const events = run(world, 9 + 25 * 30, { 9: [request(principal, 24)] }, (tickEvents) => {
      const l = world.state.finance.loans[LN1];
      const payable = negMoney(getBalance(world.state.accounting, PLAYER, ACCOUNTS.LOANS));
      expect(payable).toBe(l === undefined || l.status === 'closed' ? 0 : l.outstanding);
      if (tickEvents.some((e) => e.type === 'period.closed' && e.payload.kind === 'month')) {
        const report = world.state.accounting.entities[PLAYER]?.reports.at(-1);
        expect(report?.balance.assets).toBe(
          (report?.balance.liabilities ?? 0) + (report?.balance.equity ?? 0),
        );
        if ((report?.income.byAccount[accountCode('a7000')] ?? 0) > 0) monthsWithInterest += 1;
      }
    });
    const issued = ofType(events, 'loan.issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]?.tick).toBe(9);
    expect(issued[0]?.payload.annualRate).toBe(0.06); // leverage 0.48 -> tier 1
    const payments = ofType(events, 'loan.payment');
    expect(payments).toHaveLength(24);
    expect(payments.map((e) => e.tick)).toEqual(Array.from({ length: 24 }, (_, i) => 29 + 30 * i));
    expect(payments.reduce((a, e) => a + e.payload.principal, 0)).toBe(principal);
    expect(payments[0]?.payload.interest).toBe(80_000); // 20 days at 6% on 24M
    expect(monthsWithInterest).toBe(24);
    expect(ofType(events, 'loan.closed').map((e) => e.tick)).toEqual([29 + 30 * 23]);
    expect(world.state.finance.loans[LN1]).toMatchObject({ status: 'closed', outstanding: 0 });
    // Interest expense equals what was paid; nothing left owed.
    const interest = payments.reduce((a, e) => a + e.payload.interest, 0);
    const accounting = world.state.accounting;
    expect(getBalance(accounting, PLAYER, ACCOUNTS.INTEREST_PAYABLE)).toBe(0);
    expect(getBalance(accounting, PLAYER, ACCOUNTS.CASH)).toBe(50_000_000 - interest);
    expect(api.totalDebt(PLAYER)).toBe(0);
    expect(api.loansOf(PLAYER).map((l) => l.status)).toEqual(['closed']);
    // The year-end report (tick 359) shows the year's interest in other income/expense.
    const year = accounting.entities[PLAYER]?.reports.find((r) => r.kind === 'year');
    expect(year?.income.otherIncome).toBeLessThan(0);
    expect(ofType(events, 'loan.payment_missed')).toEqual([]);
    expect(ofType(events, 'credit.overdrawn')).toEqual([]);
  });

  it('early repayment through commands: partial, insufficient cash, full (reschedules instalments)', () => {
    const { world } = build();
    const events = run(world, 100, {
      0: [request(12_000_000, 12)],
      40: [repay(LN1, 3_000_000), repay(LN1, 999_000_000)],
      70: [repay(LN1, 20_000_000)],
    });
    expect(ofType(events, 'loan.repaid').map((e) => e.payload)).toEqual([
      { loanId: LN1, principal: 3_000_000, interest: 0 },
      { loanId: LN1, principal: 7_272_727, interest: 0 },
    ]);
    expect(ofType(events, 'command.rejected').map((e) => [e.tick, e.payload.code])).toEqual([
      [40, 'insufficient_cash'],
    ]);
    // After the prepayment, 8M over 11 remaining months -> 727,273 at tick 59.
    expect(ofType(events, 'loan.payment').map((e) => e.payload.principal)).toEqual([
      1_000_000, 727_273,
    ]);
    expect(ofType(events, 'loan.closed').map((e) => e.tick)).toEqual([70]);
    expect(world.state.finance.loans[LN1]?.status).toBe('closed');
  });
});

describe('insolvency path', () => {
  // 20M for 12 months drawn at tick 0; the player then burns 1.5M a day from tick 31 until tick 200,
  // after which revenue of 3M a day comes in. Cash 70M lasts ~45 days of burn plus repayments.
  const BURN_FROM = 31;
  const RECOVER_FROM = 200;
  const script: CashScript = (tick, company) => {
    if (company !== PLAYER) return 0;
    if (tick >= RECOVER_FROM) return 3_000_000;
    return tick >= BURN_FROM ? -1_500_000 : 0;
  };

  it('overdraft, insolvency, missed payments and default keep the ledger intact, then recover', () => {
    const { world, api } = build(VERTICAL_SLICE_SCENARIO, script);
    const repaid: { at: number | null } = { at: null };
    const commands: Script = { 0: [request(20_000_000, 12)] };
    const events = run(world, 420, commands, () => {
      // Once the books recover, repay everything still owed (a scripted player decision).
      const loan = world.state.finance.loans[LN1];
      const t = world.state.tick;
      if (
        t > RECOVER_FROM &&
        repaid.at === null &&
        loan !== undefined &&
        loan.status !== 'closed'
      ) {
        const owed = loan.outstanding + loan.accruedInterest;
        const cash = getBalance(world.state.accounting, PLAYER, ACCOUNTS.CASH);
        if (cash >= owed) {
          commands[t] = [repay(LN1, owed)];
          repaid.at = t;
        }
      }
    });

    const overdrawn = ofType(events, 'credit.overdrawn');
    const insolvent = ofType(events, 'credit.insolvent');
    const missed = ofType(events, 'loan.payment_missed');
    const defaulted = ofType(events, 'loan.defaulted');
    expect(overdrawn.length).toBeGreaterThanOrEqual(1);
    expect(insolvent.length).toBeGreaterThanOrEqual(1);
    expect(insolvent[0]?.payload.limit).toBe(BANK.overdraftLimit);
    expect(insolvent[0]?.payload.cash).toBeLessThan(negMoney(BANK.overdraftLimit));
    expect(overdrawn[0]?.tick).toBeLessThanOrEqual(insolvent[0]?.tick ?? 0);
    expect(missed.length).toBeGreaterThanOrEqual(BANK.defaultAfterMissed);
    expect(defaulted).toHaveLength(1);
    expect(defaulted[0]?.tick).toBe(missed[BANK.defaultAfterMissed - 1]?.tick);
    // Daily overdraft interest was charged (Dr 7000 / Cr 2100) and settled monthly.
    const overdraftEntries = world.state.accounting.journal.filter(
      (e) => e.ref?.kind === 'credit' && e.memo === 'Overdraft interest',
    );
    expect(overdraftEntries.length).toBeGreaterThan(30);

    // Recovery: credit restored, then the defaulted loan repaid in full and closed.
    const restored = ofType(events, 'credit.restored');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.tick).toBeGreaterThan(RECOVER_FROM);
    expect(repaid.at).not.toBeNull();
    expect(ofType(events, 'loan.closed')).toHaveLength(1);
    expect(world.state.finance.loans[LN1]?.status).toBe('closed');
    expect(world.state.finance.credit[PLAYER]).toMatchObject({
      overdrawnSince: null,
      insolventSince: null,
    });
    expect(api.totalDebt(PLAYER)).toBe(0);
    expect(getBalance(world.state.accounting, PLAYER, ACCOUNTS.LOANS)).toBe(0);
  });
});

describe('determinism', () => {
  const script: CashScript = (tick, company) =>
    company === PLAYER ? (tick % 7 === 0 ? -9_000_000 : 1_000_000) : 0;
  const commands: Script = {
    0: [request(30_000_000, 18)],
    45: [request(5_000_000, 6)],
    100: [repay(LN1, 2_500_000)],
  };

  function hashes(world: World, until: number): string[] {
    const out: string[] = [];
    while (world.state.tick < until) {
      for (const cmd of commands[world.state.tick] ?? []) submit(world, cmd);
      step(world);
      out.push(hashState(world.state));
    }
    return out;
  }

  it('two runs from the same seed hash identically every tick', () => {
    const a = hashes(build(VERTICAL_SLICE_SCENARIO, script).world, 400);
    const b = hashes(build(VERTICAL_SLICE_SCENARIO, script).world, 400);
    expect(a).toEqual(b);
  });

  it('snapshot/restore mid-run continues identically', () => {
    const full = build(VERTICAL_SLICE_SCENARIO, script).world;
    const expected = hashes(full, 300);

    const first = build(VERTICAL_SLICE_SCENARIO, script).world;
    const head = hashes(first, 137);
    const snap = JSON.parse(JSON.stringify(snapshot(first))) as unknown;
    const sink: { services: ServiceRegistry | null } = { services: null };
    const restored = restore(snap, [
      accountingSystem,
      financeSystem,
      probeSystem(sink),
      cashScriptSystem(script),
    ]);
    const tail = hashes(restored, 300);
    expect([...head, ...tail]).toEqual(expected);
    expect(restored.state.finance).toEqual(full.state.finance);
  });
});
