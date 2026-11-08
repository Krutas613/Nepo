import { describe, expect, it } from 'vitest';
import { InvariantError, money, productId } from '../schema/index.js';
import {
  emptyLot,
  issueCost,
  issueFromLot,
  lotFor,
  receiveIntoLot,
  totalLotValue,
  unitCostOf,
} from './lots.js';

describe('inventory lots (ADR-012)', () => {
  it('receives at cost and tracks counters', () => {
    const lot = emptyLot();
    receiveIntoLot(lot, 10, money(1_000));
    receiveIntoLot(lot, 5, money(600));
    expect(lot).toEqual({ quantity: 15, value: 1_600, received: 15, issued: 0 });
  });

  it('issues at moving weighted average using allocateMoney', () => {
    const lot = emptyLot();
    receiveIntoLot(lot, 3, money(100));
    // 100 over [1, 2]: 33.33 / 66.67 -> largest remainder gives 33 / 67
    expect(issueFromLot(lot, 1)).toBe(33);
    expect(lot).toEqual({ quantity: 2, value: 67, received: 3, issued: 1 });
    expect(issueFromLot(lot, 2)).toBe(67);
    expect(lot).toEqual({ quantity: 0, value: 0, received: 3, issued: 3 });
  });

  it('issuing everything moves every minor unit; a zero issue is free', () => {
    const lot = emptyLot();
    receiveIntoLot(lot, 7, money(1_001));
    expect(issueFromLot(lot, 0)).toBe(0);
    expect(issueCost(lot, 7)).toBe(1_001);
    expect(issueFromLot(lot, 7)).toBe(1_001);
    expect(lot.value).toBe(0);
  });

  it('issueCost does not mutate', () => {
    const lot = emptyLot();
    receiveIntoLot(lot, 4, money(10));
    const before = { ...lot };
    issueCost(lot, 3);
    expect(lot).toEqual(before);
  });

  it('refuses to over-issue or issue a fraction (never goes negative)', () => {
    const lot = emptyLot();
    receiveIntoLot(lot, 2, money(10));
    expect(() => issueFromLot(lot, 3)).toThrow(InvariantError);
    expect(() => issueFromLot(lot, -1)).toThrow(InvariantError);
    expect(() => issueFromLot(lot, 1.5)).toThrow(InvariantError);
    expect(lot.quantity).toBe(2);
  });

  it('refuses value without units and negative cost', () => {
    const lot = emptyLot();
    expect(() => {
      receiveIntoLot(lot, 0, money(5));
    }).toThrow(InvariantError);
    expect(() => {
      receiveIntoLot(lot, 1, money(-1));
    }).toThrow(InvariantError);
    receiveIntoLot(lot, 0, money(0));
    expect(lot).toEqual(emptyLot());
  });

  it('lotFor creates once; unit cost is derived; totals sum in key order', () => {
    const lots = {};
    const a = lotFor(lots, productId('a'));
    expect(lotFor(lots, productId('a'))).toBe(a);
    expect(unitCostOf(a)).toBeNull();
    receiveIntoLot(a, 4, money(10));
    receiveIntoLot(lotFor(lots, productId('b')), 1, money(5));
    expect(unitCostOf(a)).toBe(2.5);
    expect(totalLotValue(lots)).toBe(15);
  });
});
