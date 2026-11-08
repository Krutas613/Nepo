import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InvariantError } from '../schema/index.js';
import { calendarFromTick, type CalendarDate } from './calendar.js';

type Row = [
  tick: number,
  year: number,
  month: number,
  day: number,
  quarter: number,
  dayOfYear: number,
  flags: string,
];

// flags: S = month start, M = month end, Q = quarter end, Y = year end
const TABLE: Row[] = [
  [0, 2000, 1, 1, 1, 1, 'S'],
  [1, 2000, 1, 2, 1, 2, ''],
  [29, 2000, 1, 30, 1, 30, 'M'],
  [30, 2000, 2, 1, 1, 31, 'S'],
  [59, 2000, 2, 30, 1, 60, 'M'],
  [89, 2000, 3, 30, 1, 90, 'MQ'],
  [90, 2000, 4, 1, 2, 91, 'S'],
  [179, 2000, 6, 30, 2, 180, 'MQ'],
  [180, 2000, 7, 1, 3, 181, 'S'],
  [269, 2000, 9, 30, 3, 270, 'MQ'],
  [329, 2000, 11, 30, 4, 330, 'M'],
  [359, 2000, 12, 30, 4, 360, 'MQY'],
  [360, 2001, 1, 1, 1, 1, 'S'],
  [719, 2001, 12, 30, 4, 360, 'MQY'],
  [1799, 2004, 12, 30, 4, 360, 'MQY'],
];

function flagsOf(d: CalendarDate): string {
  return (
    (d.isMonthStart ? 'S' : '') +
    (d.isMonthEnd ? 'M' : '') +
    (d.isQuarterEnd ? 'Q' : '') +
    (d.isYearEnd ? 'Y' : '')
  );
}

describe('calendarFromTick', () => {
  it.each(TABLE)(
    'tick %i -> %i-%i-%i q%i doy %i [%s]',
    (tick, year, month, day, quarter, dayOfYear, flags) => {
      const d = calendarFromTick(tick, 2000);
      expect(d).toMatchObject({ tick, year, month, day, quarter, dayOfYear });
      expect(flagsOf(d)).toBe(flags);
    },
  );

  it('rejects negative or fractional ticks', () => {
    expect(() => calendarFromTick(-1, 2000)).toThrow(InvariantError);
    expect(() => calendarFromTick(1.5, 2000)).toThrow(InvariantError);
  });

  it('property: the date round-trips to the tick and fields are in range', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: -5000, max: 5000 }),
        (tick, epoch) => {
          const d = calendarFromTick(tick, epoch);
          return (
            (d.year - epoch) * 360 + (d.month - 1) * 30 + (d.day - 1) === tick &&
            d.month >= 1 &&
            d.month <= 12 &&
            d.day >= 1 &&
            d.day <= 30 &&
            d.quarter === Math.ceil(d.month / 3) &&
            d.dayOfYear === (d.month - 1) * 30 + d.day
          );
        },
      ),
    );
  });
});
