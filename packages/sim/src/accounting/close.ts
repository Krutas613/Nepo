/**
 * Period close (ARCHITECTURE.md section 8.4, docs/design/accounting.md section 5). Runs in the
 * `close` phase, which is accounting-only (ADR-009); a no-op unless the date is a month end. It relies
 * on every entry of the day already being in the ledger, not on which phase posted it.
 *
 * For each entity in sorted-key order:
 *   1. append a `month` report (movements since `monthOpening`);
 *   2. on a quarter end, append a `quarter` report;
 *   3. on a year end, build the `year` report (movements since `yearOpening`) BEFORE posting the
 *      closing entry (4-7xxx -> 3100), post it, append the year report, roll `yearOpening`;
 *   4. roll `monthOpening` to the current (post-closing) balances;
 *   5. emit `period.closed` once per appended report, in append order.
 *
 * Quarter reports (decided, docs/design/accounting.md section 5; no quarter-opening balances are
 * stored) are the combination (`combineReports`) of the month reports of that quarter already in
 * `ledger.reports` (the current month's included). Every statement figure is linear in the period movements, so summing the month
 * figures equals computing them from the quarter's opening balances; `openingCash` comes from the
 * quarter's first month report, the balance sheet and `closingCash` from the last. An entity opened
 * mid-quarter simply has fewer month reports in that quarter (it had all-zero balances before).
 */
import { InvariantError, type AccountingState, type PeriodReport } from '../schema/index.js';
import { closingEntry } from './builders.js';
import { postEntryOrThrow, snapshotBalances, type LedgerEnv } from './ledger.js';
import { buildReport, combineReports, type ReportDate } from './statements.js';

/** The calendar facts the close needs. The engine's `CalendarDate` satisfies it. */
export interface CloseDate extends ReportDate {
  readonly isMonthEnd: boolean;
  readonly isQuarterEnd: boolean;
  readonly isYearEnd: boolean;
}

const MONTHS_PER_QUARTER = 3;

function quarterMonthReports(reports: readonly PeriodReport[], date: CloseDate): PeriodReport[] {
  const firstMonth = date.month - MONTHS_PER_QUARTER + 1;
  const out: PeriodReport[] = [];
  for (let i = reports.length - 1; i >= 0; i--) {
    const r = reports[i];
    if (r?.kind !== 'month') continue;
    if (r.year !== date.year || r.month < firstMonth || r.month > date.month) break;
    out.push(r);
  }
  return out.reverse();
}

/**
 * Closes the period ending at `date` for every entity. Returns the reports appended (all entities,
 * in append order); returns `[]` when `date` is not a month end.
 */
export function closePeriod(
  state: AccountingState,
  date: CloseDate,
  env: LedgerEnv,
): PeriodReport[] {
  if (!date.isMonthEnd) return [];
  const appended: PeriodReport[] = [];
  // Same order as the engine's `sortedKeys` (UTF-16 code-unit order).
  for (const entityId of Object.keys(state.entities).sort() as (keyof typeof state.entities)[]) {
    const ledger = state.entities[entityId];
    if (ledger === undefined) continue;
    const reports: PeriodReport[] = [];

    const month = buildReport(ledger, ledger.monthOpening, 'month', date);
    ledger.reports.push(month);
    reports.push(month);

    if (date.isQuarterEnd) {
      const months = quarterMonthReports(ledger.reports, date);
      if (months.length === 0) {
        throw new InvariantError('accounting.quarter_without_months', `no month reports`, {
          entityId,
        });
      }
      const quarter = combineReports('quarter', months, date);
      ledger.reports.push(quarter);
      reports.push(quarter);
    }

    if (date.isYearEnd) {
      const year = buildReport(ledger, ledger.yearOpening, 'year', date);
      const closing = closingEntry(ledger);
      if (closing !== null) postEntryOrThrow(state, entityId, closing, env);
      ledger.reports.push(year);
      reports.push(year);
      ledger.yearOpening = snapshotBalances(ledger);
    }

    ledger.monthOpening = snapshotBalances(ledger);

    for (const r of reports) {
      env.emit({
        type: 'period.closed',
        payload: { entityId, kind: r.kind, year: r.year, month: r.month },
      });
      appended.push(r);
    }
  }
  return appended;
}
