/** Ledger-derived read helpers (pure, public accounting API only). */
import { buildReport, getLedger } from '@nepo/sim/accounting';
import type { DeepReadonly } from '@nepo/sim/engine';
import { calendarFromTick } from '@nepo/sim/engine';
import type {
  CompanyId,
  EntityLedger,
  PeriodKind,
  PeriodReport,
  WorldState,
} from '@nepo/sim/schema';

export type LedgerView = DeepReadonly<EntityLedger>;

export function ledgerOf(state: WorldState, id: CompanyId | null): LedgerView | null {
  if (id === null || !Object.hasOwn(state.accounting.entities, id)) return null;
  return getLedger(state.accounting, id);
}

/**
 * The live "period to date" report: month-to-date income and cash flow, balance sheet as of now.
 * Cheap (one pass over ~30 accounts), so it is safe to call from selectors every tick.
 */
export function liveReport(state: WorldState, id: CompanyId | null): PeriodReport | null {
  const ledger = ledgerOf(state, id);
  if (ledger === null) return null;
  const date = calendarFromTick(state.tick, state.epochYear);
  return buildReport(ledger, ledger.monthOpening, 'month', date);
}

/** Newest closed report of `kind`, or `null`. */
export function latestReport(
  reports: readonly PeriodReport[],
  kind: PeriodKind,
): PeriodReport | null {
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i];
    if (r?.kind === kind) return r;
  }
  return null;
}
