/**
 * Test-only helpers shared by the accounting tests (not exported from the module barrel).
 * Deliberately engine-free so the ledger-core tests do not depend on the engine.
 */
import { journalEntryId, type EventInput } from '../schema/index.js';
import type { CloseDate } from './close.js';
import type { LedgerEnv } from './ledger.js';

/** A mutable LedgerEnv recording issued IDs and emitted events. */
export interface TestEnv extends LedgerEnv {
  tick: number;
  issued: number;
  events: EventInput[];
}

export function makeTestEnv(tick = 0): TestEnv {
  const env: TestEnv = {
    tick,
    issued: 0,
    events: [],
    issueEntryId() {
      env.issued += 1;
      return journalEntryId(`je_${String(env.issued).padStart(6, '0')}`);
    },
    emit(e) {
      env.events.push(e);
    },
  };
  return env;
}

/** The ADR-005 360-day calendar facts needed by `closePeriod` (independent re-statement). */
export function testCloseDate(tick: number, epochYear = 2000): CloseDate {
  const year = epochYear + Math.floor(tick / 360);
  const dayOfYear = tick % 360;
  const month = Math.floor(dayOfYear / 30) + 1;
  const day = (dayOfYear % 30) + 1;
  const isMonthEnd = day === 30;
  return {
    tick,
    year,
    month,
    isMonthEnd,
    isQuarterEnd: isMonthEnd && month % 3 === 0,
    isYearEnd: isMonthEnd && month === 12,
  };
}
