import { describe, expect, it } from 'vitest';
import { accountCode, type AccountCode } from '../schema/index.js';
import {
  ACCOUNTS,
  STANDARD_CHART,
  accountNumber,
  accountTypeOf,
  cashFlowSectionOf,
  incomeLineOf,
  isIncomeAccount,
} from './chart.js';

describe('STANDARD_CHART', () => {
  it('has unique a-prefixed four-digit codes in ascending order', () => {
    const codes = STANDARD_CHART.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
    for (const c of codes) expect(c).toMatch(/^a[1-7][0-9]{3}$/);
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
      expect(row.type).toBe(expected[row.code.charAt(1)] ?? 'expense');
      expect(accountTypeOf(row.code)).toBe(row.type);
    }
    expect(ACCOUNTS.ACCUM_DEPRECIATION).toBe('a1590');
    expect(accountTypeOf(ACCOUNTS.INTEREST_INCOME)).toBe('expense');
  });

  it('accountTypeOf rejects codes outside 1-7xxx', () => {
    expect(() => accountTypeOf(accountCode('a8000'))).toThrow(/accounting.invalid_account_code/);
    expect(() => accountTypeOf(accountCode('100'))).toThrow(/accounting.invalid_account_code/);
    // The v1 unprefixed form is no longer a valid code.
    expect(() => accountTypeOf(accountCode('1000'))).toThrow(/accounting.invalid_account_code/);
    expect(() => accountTypeOf(accountCode('a0999'))).toThrow(/accounting.invalid_account_code/);
  });

  it('accountNumber parses the digits after the prefix', () => {
    expect(accountNumber(ACCOUNTS.CASH)).toBe(1000);
    expect(accountNumber(ACCOUNTS.INVENTORY_WIP)).toBe(1205);
    expect(accountNumber(ACCOUNTS.INCOME_TAX)).toBe(7900);
    expect(() => accountNumber(accountCode('a12345'))).toThrow(/accounting.invalid_account_code/);
  });

  it('has the M1 inventory holder accounts (ADR-012)', () => {
    expect(ACCOUNTS.INVENTORY_WIP).toBe('a1205');
    expect(ACCOUNTS.INVENTORY_MERCHANDISE).toBe('a1230');
    const names = new Map(STANDARD_CHART.map((r) => [r.code, r]));
    expect(names.get(ACCOUNTS.INVENTORY_WIP)?.type).toBe('asset');
    expect(names.get(ACCOUNTS.INVENTORY_MERCHANDISE)?.type).toBe('asset');
    expect(cashFlowSectionOf(ACCOUNTS.INVENTORY_WIP)).toBe('operating');
    expect(cashFlowSectionOf(ACCOUNTS.INVENTORY_MERCHANDISE)).toBe('operating');
    expect(incomeLineOf(ACCOUNTS.INVENTORY_WIP)).toBeNull();
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
      'a1100',
      'a1200',
      'a1205',
      'a1210',
      'a1220',
      'a1230',
      'a1590',
      'a1900',
      'a2000',
      'a2100',
      'a2200',
      'a2900',
    ];
    const investing = ['a1500', 'a1800'];
    const financing = ['a2500', 'a3000', 'a3100'];
    for (const row of STANDARD_CHART) {
      const s = cashFlowSectionOf(row.code);
      if (row.code === ACCOUNTS.CASH) expect(s).toBe('cash');
      else if (operating.includes(row.code)) expect(s).toBe('operating');
      else if (investing.includes(row.code)) expect(s).toBe('investing');
      else if (financing.includes(row.code)) expect(s).toBe('financing');
      else expect(s, row.code).toBeNull();
    }
    expect(cashFlowSectionOf(code('a4000'))).toBeNull();
  });
});
