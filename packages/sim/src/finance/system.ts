/**
 * `financeSystem` (docs/design/finance.md, ADR-014): a thin adapter from the engine's `TickContext`
 * to the pure transitions in `loans.ts`.
 *
 * - `init`: one `CreditState` per company, no loans.
 * - `apply`: `loan.request` and `loan.repay`, in ascending `seq`; each is fully applied or rejected.
 * - `finance`: overdraft check (daily), loan accrual and scheduled payments (month end), credit flags.
 * - Service: `FinanceApi` under `FINANCE_SERVICE` (read-only).
 *
 * The policy rate comes from `EconomyApi.policyRate()` when the economy system is registered, else
 * from the scenario's macro tunables (`policyRateOf`). No RNG is used.
 */
import { ACCOUNTING_SERVICE } from '../accounting/index.js';
import { ECONOMY_SERVICE } from '../economy/index.js';
import { sortedKeys, type System, type TickContext } from '../engine/index.js';
import type { FinanceState } from '../schema/index.js';
import {
  createFinanceState,
  repayLoan,
  requestLoan,
  runFinanceDay,
  type FinanceEnv,
} from './loans.js';
import { FINANCE_SERVICE, createFinanceApi, type FinanceApiInternal } from './service.js';

function envOf(ctx: TickContext<FinanceState>): FinanceEnv {
  return {
    tick: ctx.tick,
    accounting: ctx.services.get(ACCOUNTING_SERVICE),
    emit: (event) => {
      ctx.emit(event);
    },
    issueLoanId: () => ctx.issueId('loan'),
  };
}

function policyRate(ctx: TickContext<FinanceState>): number {
  return ctx.services.has(ECONOMY_SERVICE)
    ? ctx.services.get(ECONOMY_SERVICE).policyRate()
    : ctx.scenario.content.economy.macro.policyRate;
}

function bindService(ctx: TickContext<FinanceState>): void {
  (ctx.services.get(FINANCE_SERVICE) as FinanceApiInternal).bind(
    ctx.scenario.content,
    ctx.services.has(ECONOMY_SERVICE),
  );
}

export const financeSystem: System<FinanceState> = {
  id: 'finance',
  handles: ['loan.request', 'loan.repay'],
  init(ctx) {
    return createFinanceState(sortedKeys(ctx.state.companies));
  },
  phases: {
    apply(ctx) {
      bindService(ctx);
      if (ctx.commands.length === 0) return;
      const env = envOf(ctx);
      for (const command of ctx.commands) {
        switch (command.type) {
          case 'loan.request': {
            const result = requestLoan(
              ctx.slice,
              env,
              ctx.scenario.content,
              policyRate(ctx),
              command.issuer,
              command.payload,
            );
            if (!result.ok) ctx.reject(command, result.error.code, result.error.message);
            break;
          }
          case 'loan.repay': {
            const result = repayLoan(ctx.slice, env, command.issuer, command.payload);
            if (!result.ok) ctx.reject(command, result.error.code, result.error.message);
            break;
          }
          case 'company.rename':
          case 'facility.build':
          case 'facility.set_recipe':
          case 'facility.set_production':
          case 'store.build':
          case 'store.set_price':
          case 'store.set_restock_policy':
            // Routed here only if `handles` and this switch disagree: a bug.
            ctx.reject(command, 'no_handler', `finance does not handle ${command.type}`);
        }
      }
    },
    finance(ctx) {
      bindService(ctx);
      runFinanceDay(
        ctx.slice,
        envOf(ctx),
        ctx.scenario.content,
        sortedKeys(ctx.state.companies),
        ctx.date.isMonthEnd,
      );
    },
  },
  createService: createFinanceApi,
  serviceKey: FINANCE_SERVICE,
};
