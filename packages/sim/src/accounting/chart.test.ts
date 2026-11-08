import { describe, expect, it } from 'vitest';
import { accountCode, type AccountCode } from '../schema/index.js';
import {
  ACCOUNTS,
  STANDARD_CHART,
  accountTypeOf,
  cashFlowSectionOf,
  incomeLineOf,
  isIncomeAccount,
} from './chart.js';

describe('STANDARD_CHART', () => {
  it('has unique four-digit codes in ascending order', () => {
    const codes = STANDARD_CHART.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
    for (const c of codes) expect(c).toMatch(/^[1-7][0-9]{3}$/);
  });

  it('contains exactly the ACCOUNTS constants', () => {
    const fromConstants = Object.values(ACCOUNTS).sort();
    expect(STANDARD_CHART.map((r) => r.code)).toEqual(fromConstants);
  });

  it('types follow the leading digit (design doc table)', () => {
    const expected: Record<string, string> = {
      '1': 'asset',
      '2': 'liability',
      '3': 'equity',
      '4': 'revenue',
    };
    for (const row of STANDARD_CHART) {
      expect(row.type).toBe(expected[row.code.charAt(0)] ?? 'expense');
      expect(accountTypeOf(row.code)).toBe(row.type);
    }
    expect(ACCOUNTS.ACCUM_DEPRECIATION).toBe('1590');
    expect(accountTypeOf(ACCOUNTS.INTEREST_INCOME)).toBe('expense');
  });

  it('accountTypeOf rejects codes outside 1-7xxx', () => {
    expect(() => accountTypeOf(accountCode('8000'))).toThrow(/accounting.invalid_account_code/);
    expect(() => accountTypeOf(accountCode('100'))).toThrow(/accounting.invalid_account_code/);
  });
});

describe('statement classification', () => {
  const code = (s: string): AccountCode => accountCode(s);

  it('income lines', () => {
    expect(incomeLineOf(ACCOUNTS.SALES)).toBe('revenue');
    expect(incomeLineOf(ACCOUNTS.INTERCO_SALES)).toBe('revenue');
    expect(incomeLineOf(ACCOUNTS.COGS)).toBe('cogs');
    expect(incomeLineOf(ACCOUNTS.WAGES)).toBe('opex');
    expect(incomeLineOf(ACCOUNTS.INTEREST_EXPENSE)).toBe('other');
    expect(incomeLineOf(ACCOUNTS.INTEREST_INCOME)).toBe('other');
    expect(incomeLineOf(ACCOUNTS.DISPOSAL_GAIN_LOSS)).toBe('other');
    expect(incomeLineOf(ACCOUNTS.INCOME_TAX)).toBe('tax');
    expect(incomeLineOf(ACCOUNTS.CASH)).toBeNull();
    expect(isIncomeAccount(ACCOUNTS.RETAINED_EARNINGS)).toBe(false);
  });

  it('cash-flow sections match the design doc sets for the standard chart', () => {
    const operating = [
      '1100',
      '1200',
      '1210',
      '1220',
      '1590',
      '1900',
      '2000',
      '2100',
      '2200',
      '2900',
    ];
    const investing = ['1500', '1800'];
    const financing = ['2500', '3000', '3100'];
    for (const row of STANDARD_CHART) {
      const s = cashFlowSectionOf(row.code);
      if (row.code === ACCOUNTS.CASH) expect(s).toBe('cash');
      else if (operating.includes(row.code)) expect(s).toBe('operating');
      else if (investing.includes(row.code)) expect(s).toBe('investing');
      else if (financing.includes(row.code)) expect(s).toBe('financing');
      else expect(s, row.code).toBeNull();
    }
    expect(cashFlowSectionOf(code('4000'))).toBeNull();
  });
});
