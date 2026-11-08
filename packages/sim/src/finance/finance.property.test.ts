/**
 * finance.md section 12: random `loan.request`/`loan.repay` sequences (and a random daily cash flow
 * that drives companies in and out of overdraft) over 720 ticks keep invariants 1-4, the ledger
 * invariants and valid status transitions after every tick.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { accountingSystem, checkLedgerInvariants } from '../accounting/index.js';
import { ECONOMY_SERVICE, economySystem } from '../economy/index.js';
import { createWorld, step, submit, type AnySystem } from '../engine/index.js';
import {
  VERTICAL_SLICE_SCENARIO,
  loanId,
  money,
  type CommandInput,
  type FinanceState,
} from '../schema/index.js';
import { checkFinanceInvariants, checkLoanTransitions } from './invariants.js';
import { financeSystem } from './system.js';
import { annualRateFor } from './underwriting.js';
import { PLAYER, cashScriptSystem } from './test-helpers.js';

const TICKS = 720;

const commandArb = fc.oneof(
  fc.record({
    kind: fc.constant('request' as const),
    principal: fc.integer({ min: 50_000, max: 60_000_000 }),
    term: fc.integer({ min: 4, max: 64 }),
  }),
  fc.record({
    kind: fc.constant('repay' as const),
    loan: fc.integer({ min: 1, max: 6 }),
    amount: fc.integer({ min: -5, max: 30_000_000 }),
  }),
);

function toCommand(c: CommandSpec): CommandInput {
  return c.kind === 'request'
    ? {
        type: 'loan.request',
        issuer: PLAYER,
        payload: { companyId: PLAYER, principal: money(c.principal), termMonths: c.term },
      }
    : {
        type: 'loan.repay',
        issuer: PLAYER,
        payload: {
          loanId: loanId(`ln_${String(c.loan).padStart(6, '0')}`),
          amount: money(c.amount),
        },
      };
}

type CommandSpec =
  | { kind: 'request'; principal: number; term: number }
  | { kind: 'repay'; loan: number; amount: number };

describe('finance property (engine, 720 ticks)', () => {
  it('invariants hold every tick under random commands and cash flows', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: TICKS - 1 }), commandArb), { maxLength: 25 }),
        fc.array(fc.integer({ min: -3_000_000, max: 2_500_000 }), { minLength: 1, maxLength: 24 }),
        (commands, monthlyDailyFlow) => {
          // Daily cash flow for the player, piecewise constant per month.
          const flow = (tick: number): number =>
            monthlyDailyFlow[Math.floor(tick / 30) % monthlyDailyFlow.length] ?? 0;
          const world = createWorld({
            seed: 11,
            scenario: VERTICAL_SLICE_SCENARIO,
            systems: [
              accountingSystem,
              financeSystem,
              cashScriptSystem((t, c) => (c === PLAYER ? flow(t) : 0)),
            ],
          });
          const byTick = new Map<number, CommandInput[]>();
          for (const [t, c] of commands) byTick.set(t, [...(byTick.get(t) ?? []), toCommand(c)]);
          for (let t = 0; t < TICKS; t++) {
            for (const cmd of byTick.get(t) ?? []) submit(world, cmd);
            const before = JSON.parse(JSON.stringify(world.state.finance)) as FinanceState;
            step(world);
            const fin = checkFinanceInvariants(world.state, world.scenario.content);
            if (fin.length > 0) throw new Error(`tick ${String(t)}: ${JSON.stringify(fin)}`);
            const led = checkLedgerInvariants(world.state.accounting);
            if (led.length > 0) throw new Error(`tick ${String(t)}: ${JSON.stringify(led)}`);
            const tr = checkLoanTransitions(before, world.state.finance);
            if (tr.length > 0) throw new Error(`tick ${String(t)}: ${JSON.stringify(tr)}`);
          }
        },
      ),
      { numRuns: 12 },
    );
  });

  it('with the economy system registered the rate is EconomyApi.policyRate() + spread', () => {
    const world = createWorld({
      seed: 3,
      scenario: VERTICAL_SLICE_SCENARIO,
      systems: [accountingSystem, economySystem, financeSystem] as AnySystem[],
    });
    submit(world, {
      type: 'loan.request',
      issuer: PLAYER,
      payload: { companyId: PLAYER, principal: money(10_000_000), termMonths: 12 },
    });
    const events = step(world).events;
    const issued = events.find((e) => e.type === 'loan.issued');
    expect(issued?.type === 'loan.issued' && issued.payload.annualRate).toBe(
      annualRateFor(world.state.economy.macro.policyRate, 0.02),
    );
    expect(ECONOMY_SERVICE).toBe('economy');
    expect(checkFinanceInvariants(world.state, world.scenario.content)).toEqual([]);
  });
});
