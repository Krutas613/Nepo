import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateMoney } from '../accounting/index.js';
import { money, type InventoryLot } from '../schema/index.js';
import { emptyLot, issueFromLot, receiveIntoLot } from './lots.js';

type Op = { kind: 'receive'; qty: number; cost: number } | { kind: 'issue'; fraction: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('receive' as const),
    qty: fc.integer({ min: 0, max: 5_000 }),
    cost: fc.integer({ min: 0, max: 2_000_000 }),
  }),
  fc.record({
    kind: fc.constant('issue' as const),
    fraction: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
);

describe('inventory lot properties', () => {
  it('random receive/issue sequences keep received - issued === quantity, value >= 0, and conserve value', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        const lot: InventoryLot = emptyLot();
        let valueIn = 0;
        let valueOut = 0;
        for (const op of ops) {
          if (op.kind === 'receive') {
            // a receipt with no units must be free
            const cost = op.qty === 0 ? 0 : op.cost;
            receiveIntoLot(lot, op.qty, money(cost));
            valueIn += cost;
          } else {
            const n = Math.floor(op.fraction * lot.quantity);
            valueOut += issueFromLot(lot, n);
          }
          expect(lot.received - lot.issued).toBe(lot.quantity);
          expect(lot.quantity).toBeGreaterThanOrEqual(0);
          expect(lot.value).toBeGreaterThanOrEqual(0);
          if (lot.quantity === 0) expect(lot.value).toBe(0);
          expect(valueIn - valueOut).toBe(lot.value);
        }
        // drain: every minor unit leaves with the last unit
        valueOut += issueFromLot(lot, lot.quantity);
        expect(valueIn).toBe(valueOut);
        expect(lot.value).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it('splitting a lot into issues conserves total value (any split of the units)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 12 }),
        (qty, cost, chunks) => {
          const lot = emptyLot();
          receiveIntoLot(lot, qty, money(cost));
          let out = 0;
          for (const c of chunks) {
            const n = Math.min(c, lot.quantity);
            out += issueFromLot(lot, n);
          }
          expect(out + lot.value).toBe(cost);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('allocateMoney of a batch cost across outputs sums exactly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.array(
          fc.tuple(fc.integer({ min: 1, max: 1_000 }), fc.integer({ min: 1, max: 100_000 })),
          {
            minLength: 1,
            maxLength: 5,
          },
        ),
        (total, lines) => {
          const weights = lines.map(([qty, price]) => qty * price);
          const parts = allocateMoney(money(total), weights);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
          for (const p of parts) expect(p).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});
