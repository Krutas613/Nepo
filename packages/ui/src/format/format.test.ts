import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatPeriod,
  formatQty,
  parseSeedText,
} from './index.js';

describe('formatMoney', () => {
  it('formats minor units with grouping and two decimals', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(5)).toBe('$0.05');
    expect(formatMoney(100)).toBe('$1.00');
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(100_000_000)).toBe('$1,000,000.00');
    expect(formatMoney(123_456_789_012)).toBe('$1,234,567,890.12');
  });

  it('uses a minus sign by default and parentheses on request', () => {
    expect(formatMoney(-123456)).toBe('-$1,234.56');
    expect(formatMoney(-123456, { negative: 'parens' })).toBe('($1,234.56)');
    expect(formatMoney(123456, { negative: 'parens' })).toBe('$1,234.56 ');
  });

  it('never prints a negative zero', () => {
    expect(formatMoney(-0)).toBe('$0.00');
    expect(formatMoney(-0.2)).toBe('$0.00');
  });

  it('supports no symbol and no cents', () => {
    expect(formatMoney(-123456, { symbol: '', negative: 'parens' })).toBe('(1,234.56)');
    expect(formatMoney(123456, { cents: false })).toBe('$1,235');
  });

  it('shows a dash for non-finite input', () => {
    expect(formatMoney(Number.NaN)).toBe('—');
  });

  it('is a stable round trip for safe integers', () => {
    const text = formatMoney(Number.MAX_SAFE_INTEGER);
    expect(text.replace(/[^\d]/g, '')).toBe(String(Number.MAX_SAFE_INTEGER));
  });
});

describe('formatMoneyCompact', () => {
  it('keeps full precision below one million dollars', () => {
    expect(formatMoneyCompact(99_999_999)).toBe('$999,999.99');
  });
  it('abbreviates large values', () => {
    expect(formatMoneyCompact(100_000_000)).toBe('$1.00M');
    expect(formatMoneyCompact(-1_234_000_000)).toBe('-$12.3M');
    expect(formatMoneyCompact(250_000_000_000)).toBe('$2.50B');
  });
});

describe('formatQty / percent / date', () => {
  it('formats quantities', () => {
    expect(formatQty(0)).toBe('0');
    expect(formatQty(1234567)).toBe('1,234,567');
    expect(formatQty(-1200, 'kg')).toBe('-1,200 kg');
  });
  it('formats percents', () => {
    expect(formatPercent(0.1234)).toBe('12.3%');
    expect(formatPercent(-0.0001)).toBe('0.0%');
  });
  it('formats dates and periods', () => {
    expect(formatDate({ year: 2000, month: 7, day: 2 })).toBe('Y2000 M07 D02');
    expect(formatPeriod('month', 2000, 3)).toBe('Y2000 M03');
    expect(formatPeriod('quarter', 2000, 6)).toBe('Y2000 Q2');
    expect(formatPeriod('year', 2001, 12)).toBe('Y2001');
  });
  it('parses seeds', () => {
    expect(parseSeedText(' 42 ')).toBe(42);
    expect(parseSeedText('-1')).toBeNull();
    expect(parseSeedText('1.5')).toBeNull();
    expect(parseSeedText('')).toBeNull();
    expect(parseSeedText('1234567890123456')).toBeNull();
  });
});
