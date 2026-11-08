/**
 * Calendar derived from ticks (ARCHITECTURE.md section 5, ADR-005).
 *
 * 1 tick = 1 day. Fixed 360-day year: 12 months of 30 days, 4 quarters of 90 days. No weekends,
 * no leap years. Tick 0 is day 1 of month 1 of `epochYear`.
 */
import { InvariantError } from '../schema/index.js';

export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const MONTHS_PER_QUARTER = 3;
export const DAYS_PER_QUARTER = DAYS_PER_MONTH * MONTHS_PER_QUARTER; // 90
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 360

export interface CalendarDate {
  tick: number;
  /** `epochYear + floor(tick / 360)`. */
  year: number;
  /** 1..12 */
  month: number;
  /** 1..30 */
  day: number;
  /** 1..4 */
  quarter: number;
  /** 1..360 */
  dayOfYear: number;
  /** `day === 1` */
  isMonthStart: boolean;
  /** `day === 30` */
  isMonthEnd: boolean;
  /** `isMonthEnd && month % 3 === 0` */
  isQuarterEnd: boolean;
  /** `isMonthEnd && month === 12` */
  isYearEnd: boolean;
}

/** Maps a tick to its calendar date. Throws `InvariantError('calendar.invalid_tick')` for a bad tick. */
export function calendarFromTick(tick: number, epochYear: number): CalendarDate {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new InvariantError('calendar.invalid_tick', `tick must be a non-negative safe integer`, {
      tick,
    });
  }
  if (!Number.isSafeInteger(epochYear)) {
    throw new InvariantError('calendar.invalid_epoch', `epochYear must be a safe integer`, {
      epochYear,
    });
  }
  const yearIndex = Math.floor(tick / DAYS_PER_YEAR);
  const dayIndex = tick - yearIndex * DAYS_PER_YEAR; // 0..359
  const monthIndex = Math.floor(dayIndex / DAYS_PER_MONTH); // 0..11
  const day = dayIndex - monthIndex * DAYS_PER_MONTH + 1;
  const month = monthIndex + 1;
  const isMonthEnd = day === DAYS_PER_MONTH;
  return {
    tick,
    year: epochYear + yearIndex,
    month,
    day,
    quarter: Math.floor(monthIndex / MONTHS_PER_QUARTER) + 1,
    dayOfYear: dayIndex + 1,
    isMonthStart: day === 1,
    isMonthEnd,
    isQuarterEnd: isMonthEnd && month % MONTHS_PER_QUARTER === 0,
    isYearEnd: isMonthEnd && month === MONTHS_PER_YEAR,
  };
}
