/** Narrow selector hooks used by several views. Each returns a primitive or a stable reference. */
import { calendarFromTick } from '@nepo/sim/engine';
import type { CompanyId, PeriodReport } from '@nepo/sim/schema';
import type { CalendarDate } from '@nepo/sim/engine';
import { useSelector } from './hooks.js';
import { ledgerOf } from './queries.js';
import { cashOf, playerCompany, playerCompanyId } from './selectors.js';

export function usePlayerId(): CompanyId | null {
  return useSelector((v) => playerCompanyId(v.world.state));
}

export function usePlayerName(): string {
  return useSelector((v) => playerCompany(v.world.state)?.name ?? 'No company');
}

export function usePlayerCash(): number | null {
  return useSelector((v) => {
    const id = playerCompanyId(v.world.state);
    return id === null ? null : cashOf(v.world.state, id);
  });
}

export function useCalendar(): CalendarDate {
  const tick = useSelector((v) => v.tick);
  const epoch = useSelector((v) => v.world.state.epochYear);
  return calendarFromTick(tick, epoch);
}

/** The player's closed-period reports. The array is append-only and mutated in place by the sim. */
export function usePlayerReports(): { reports: readonly PeriodReport[]; count: number } {
  return useSelector(
    (v) => {
      const ledger = ledgerOf(v.world.state, playerCompanyId(v.world.state));
      const reports = ledger?.reports ?? [];
      return { reports, count: reports.length };
    },
    (a, b) => a.reports === b.reports && a.count === b.count,
  );
}
