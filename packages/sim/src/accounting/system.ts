/**
 * `accountingSystem` (ARCHITECTURE.md sections 6.2, 8, 15).
 *
 * - `init`: opens a ledger for every company in `sortedKeys(state.companies)` and posts its opening
 *   capital (Dr 1000 / Cr 3000) from `scenario.companies[i].startingCash`, matched by index (company
 *   `co_00000{i+1}` is scenario company `i`). A zero `startingCash` posts nothing (a zero line is
 *   invalid).
 * - `phases.close`: `closePeriod` on month ends. `close` is accounting-only (ADR-009; the engine
 *   rejects any other system registering it). Domain systems post period-end entries (depreciation,
 *   rent, payroll runs, tax provisions) in their own phase on the tick whose `ctx.date.isMonthEnd`
 *   (or `isQuarterEnd`/`isYearEnd`); every domain phase precedes `close`, so by the time this runs
 *   the day's books are complete.
 * - Service: `AccountingApi` under `ACCOUNTING_SERVICE`.
 * Handles no commands in M0.
 */
import { sortedKeys, type System } from '../engine/index.js';
import { ZERO_MONEY, type AccountingState } from '../schema/index.js';
import { openingCapital } from './builders.js';
import { closePeriod } from './close.js';
import { createAccountingState, openEntity, postEntryOrThrow, type LedgerEnv } from './ledger.js';
import { ACCOUNTING_SERVICE, createAccountingApi } from './service.js';

export const accountingSystem: System<AccountingState> = {
  id: 'accounting',
  handles: [],
  init(ctx) {
    const state = createAccountingState();
    const env: LedgerEnv = {
      tick: ctx.state.tick,
      issueEntryId: () => ctx.issueId('journalEntry'),
      emit: (event) => {
        ctx.emit(event);
      },
    };
    sortedKeys(ctx.state.companies).forEach((companyId, i) => {
      const company = ctx.state.companies[companyId];
      openEntity(state, companyId, company?.parentId ?? null);
      const startingCash = ctx.scenario.companies[i]?.startingCash ?? ZERO_MONEY;
      if (startingCash > 0) {
        postEntryOrThrow(state, companyId, openingCapital(startingCash, 'accounting'), env);
      }
    });
    return state;
  },
  phases: {
    close(ctx) {
      closePeriod(ctx.slice, ctx.date, {
        tick: ctx.tick,
        issueEntryId: () => ctx.issueId('journalEntry'),
        emit: (event) => {
          ctx.emit(event);
        },
      });
    },
  },
  createService: createAccountingApi,
  serviceKey: ACCOUNTING_SERVICE,
};
