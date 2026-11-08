import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateMoney } from '../accounting/index.js';
import { money, quantity } from '../schema/index.js';
import { emptyLot, issueFrom, lotInvariantErrors, receiveInto } from './lots.js';

describe('lots', () => {
  it('receipt adds quantity, value and received', () => {
    const lot = emptyLot();
    receiveInto(lot, quantity(10), money(1234));
    expect(lot).toEqual({ quantity: 10, value: 1234, received: 10, issued: 0 });
  });

  it('issue uses the allocateMoney split and tracks issued', () => {
    const lot = emptyLot();
    receiveInto(lot, quantity(7), money(100));
    const cost = issueFrom(lot, quantity(3));
    expect(cost).toBe(allocateMoney(money(100), [3, 4])[0]);
    expect(lot).toEqual({ quantity: 4, value: 100 - cost, received: 7, issued: 3 });
  });

  it('issuing everything empties the value; issuing 0 is a no-op', () => {
    const lot = emptyLot();
    receiveInto(lot, quantity(3), money(10));
    expect(issueFrom(lot, quantity(0))).toBe(0);
    expect(issueFrom(lot, quantity(3))).toBe(10);
    expect(lot.value).toBe(0);
    expect(lotInvariantErrors(lot)).toEqual([]);
  });

  it('rejects over-issue and negative receipts', () => {
    const lot = emptyLot();
    receiveInto(lot, quantity(2), money(5));
    expect(() => issueFrom(lot, quantity(3))).toThrow(/issue_exceeds_stock/);
    expect(() => {
      receiveInto(lot, -1 as never, money(1));
    }).toThrow(/bad_receipt/);
    expect(() => {
      receiveInto(lot, quantity(1), -1 as never);
    }).toThrow(/bad_receipt/);
    expect(() => {
      receiveInto(lot, quantity(0), money(1));
    }).toThrow(/bad_receipt/);
  });

  it('lotInvariantErrors flags each broken rule', () => {
    expect(
      lotInvariantErrors({ quantity: 0, value: 5, received: 1, issued: 1 } as never),
    ).toContain('empty lot has non-zero value');
    expect(
      lotInvariantErrors({ quantity: 1, value: 5, received: 3, issued: 1 } as never),
    ).toContain('received - issued !== quantity');
    expect(
      lotInvariantErrors({ quantity: -1, value: -5, received: 0, issued: 1 } as never),
    ).toEqual(expect.arrayContaining(['quantity < 0', 'value < 0']));
  });

  it('property: receive/issue sequences keep the lot sound and conserve total value', () => {
    const step = fc.oneof(
      fc.record({
        kind: fc.constant('r' as const),
        q: fc.integer({ min: 0, max: 500 }),
        cost: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      fc.record({ kind: fc.constant('i' as const), pct: fc.integer({ min: 0, max: 100 }) }),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const lot = emptyLot();
        let receivedValue = 0;
        let issuedValue = 0;
        for (const s of steps) {
          if (s.kind === 'r') {
            const cost = s.q === 0 ? 0 : s.cost;
            receiveInto(lot, quantity(s.q), money(cost));
            receivedValue += cost;
          } else {
            issuedValue += issueFrom(lot, quantity(Math.floor((lot.quantity * s.pct) / 100)));
          }
          expect(lotInvariantErrors(lot)).toEqual([]);
        }
        expect(receivedValue - issuedValue).toBe(lot.value);
        issuedValue += issueFrom(lot, lot.quantity);
        expect(issuedValue).toBe(receivedValue);
        expect(lot.value).toBe(0);
      }),
    );
  });
});
