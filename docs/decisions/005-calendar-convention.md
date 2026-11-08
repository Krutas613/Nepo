# ADR-005: 360-day year, 30-day months, no weekends

**Status:** Accepted (Milestone 0)

## Context
1 tick = 1 day and months, quarters and years derive from ticks. A real Gregorian calendar brings
uneven month lengths, leap years and weekends, which make monthly statements non-comparable, daily
accrual rates inexact (annual/365 vs 366), and add logic with no gameplay value.

## Decision
- Fixed calendar: 12 months x 30 days = 360 days; quarters are 90 days. Tick 0 is day 1, month 1 of
  `scenario.epochYear`. Every day is a business day.
- `CalendarDate` carries `year, month, day, quarter, dayOfYear` and boolean flags `isMonthStart`,
  `isMonthEnd`, `isQuarterEnd`, `isYearEnd`.
- Period-end work runs in the `close` phase of the tick flagged `isMonthEnd` (day 30), after all
  economic activity of the day. Year-end closing entries run when `isYearEnd` (month 12, day 30).
- Daily rates are `annualRate / 360`.

## Consequences
- Every month is identical in length, so month-over-month comparisons and accruals are exact and
  simple; a "year" is exactly 360 ticks (`--years 5` = 1800 ticks).
- The UI may display dates as `Y3 M07 D12` or map them onto a nominal real calendar for flavour; the
  sim never does.
- Seasonal effects, if wanted later, key off `month`/`dayOfYear`, not real dates.
