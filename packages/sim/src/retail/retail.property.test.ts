/**
 * Property tests (retail.md section 10): lot conservation, COGS allocation sums exactly to the issued
 * value, and sales never exceed stock or demand.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '../accounting/index.js';
import { M1_CONTENT_PACK, money, quantity, type Event, type StoreId } from '../schema/index.js';
import { checkRetailInvariants } from './invariants.js';
import { lotInvariantErrors, receiveInto } from './lots.js';
import { applyShrinkage, newShelfLine, restockQuantity, settleSale } from './store.js';
import { BREAD, STORE_1 } from './test-helpers.js';
import { balance, newWorld, run, seedStore } from './test-world.js';

type Op =
  | { kind: 'restock'; target: number; available: number; cost: number }
  | { kind: 'sell'; pct: number; price: number }
  | { kind: 'shrink'; perMille: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('restock' as const),
    target: fc.integer({ min: 0, max: 1000 }),
    available: fc.integer({ min: 0, max: 1500 }),
    cost: fc.integer({ min: 1, max: 5_000_000 }),
  }),
  fc.record({
    kind: fc.constant('sell' as const),
    pct: fc.integer({ min: 0, max: 100 }),
    price: fc.integer({ min: 1, max: 100_000 }),
  }),
  fc.record({ kind: fc.constant('shrink' as const), perMille: fc.integer({ min: 0, max: 100 }) }),
);

describe('shelf property: random restock / sale / shrink sequences', () => {
  it('keeps lot invariants and conserves value: Σ cogs + Σ writeOff + lot.value === Σ transfer cost', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 80 }), (ops) => {
        const capacity = 1000;
        const line = newShelfLine();
        let transferred = 0;
        let cogs = 0;
        let writeOff = 0;
        let unitsIn = 0;
        let unitsSold = 0;
        for (const op of ops) {
          if (op.kind === 'restock') {
            const q = restockQuantity(
              op.target,
              line.lot.quantity,
              capacity - line.lot.quantity,
              op.available,
            );
            if (q >= 1) {
              receiveInto(line.lot, q, money(op.cost));
              transferred += op.cost;
              unitsIn += q;
            }
          } else if (op.kind === 'sell') {
            const sold = quantity(Math.floor((line.lot.quantity * op.pct) / 100));
            const before = line.lot.quantity;
            const sale = settleSale(line, sold, money(op.price));
            expect(sale.quantity).toBeLessThanOrEqual(before);
            expect(sale.revenue).toBe(op.price * sold);
            cogs += sale.cogs;
            unitsSold += sold;
          } else {
            writeOff += applyShrinkage(line, op.perMille).cost;
          }
          expect(lotInvariantErrors(line.lot)).toEqual([]);
          expect(line.lot.quantity).toBeLessThanOrEqual(capacity);
          expect(line.shrunk).toBeLessThanOrEqual(line.lot.issued);
          expect(cogs + writeOff + line.lot.value).toBe(transferred);
          expect(line.lot.received - line.lot.issued).toBe(line.lot.quantity);
        }
        expect(line.lot.received).toBe(unitsIn);
        expect(line.lot.issued).toBe(unitsSold + line.shrunk);
      }),
      { numRuns: 300 },
    );
  });

  it('COGS of a partial sale is exactly the allocateMoney share and never exceeds the lot value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 1000 }),
        (stock, value, soldRaw) => {
          const sold = Math.min(stock, soldRaw);
          const line = newShelfLine();
          receiveInto(line.lot, quantity(stock), money(value));
          const sale = settleSale(line, quantity(sold), money(7));
          expect(sale.cogs + line.lot.value).toBe(value);
          expect(sale.cogs).toBeGreaterThanOrEqual(0);
          expect(sale.cogs).toBeLessThanOrEqual(value);
          if (sold === stock) expect(line.lot.value).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('sales against the real economy: property', () => {
  const demand =
    M1_CONTENT_PACK.markets['springfield_market' as never]?.demand[0]?.baseDailyDemand ?? 0;
  const maxCapture = M1_CONTENT_PACK.economy.pricing.maxCapture;

  it('never sell more than stock or the demand ceiling; books stay reconciled', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.option(fc.integer({ min: 1, max: 800 }), { nil: null }),
        fc.integer({ min: 1, max: 5 }),
        (stock, price, days) => {
          const world = newWorld();
          seedStore(world, { stock, value: stock === 0 ? 0 : stock * 137 + 11, price });
          const events: Event[] = [];
          for (let d = 0; d < days; d += 1) {
            events.push(...run(world, 1));
            expect(checkRetailInvariants(world.state, world.scenario.content)).toEqual([]);
          }
          const line = world.state.retail.stores[STORE_1]?.shelves[BREAD];
          let sold = 0;
          let revenue = 0;
          for (const e of events) {
            if (e.type !== 'store.sold') continue;
            expect(e.payload.quantity).toBeGreaterThanOrEqual(1);
            expect(e.payload.quantity).toBeLessThanOrEqual(Math.floor(demand * maxCapture));
            sold += e.payload.quantity;
            revenue += e.payload.revenue;
          }
          expect(sold).toBeLessThanOrEqual(stock);
          expect(line?.lot.quantity).toBe(stock - sold);
          expect(balance(world, ACCOUNTS.SALES)).toBe(0 - revenue);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('competition: stores in one market share one clearing', () => {
  const second = 'st_000002' as StoreId;

  it('the cheaper store captures more and together they cannot exceed the demand ceiling', () => {
    const world = newWorld();
    seedStore(world, { stock: 1000, value: 100_000, price: 200, id: STORE_1 });
    seedStore(world, { stock: 1000, value: 100_000, price: 300, id: second });
    const sold = run(world, 1).filter((e) => e.type === 'store.sold');
    const qty = (id: StoreId) =>
      sold.reduce((a, e) => (e.payload.storeId === id ? a + e.payload.quantity : a), 0);
    const cheap = qty(STORE_1);
    const dear = qty(second);
    expect(cheap).toBeGreaterThan(dear);
    expect(cheap + dear).toBeLessThanOrEqual(
      Math.floor(400 * M1_CONTENT_PACK.economy.pricing.maxCapture),
    );
    expect(checkRetailInvariants(world.state, world.scenario.content)).toEqual([]);
  });

  it('a rival lowering its price takes sales from an unchanged store', () => {
    const salesOfFirst = (rivalPrice: number | null) => {
      const world = newWorld();
      seedStore(world, { stock: 1000, value: 100_000, price: null, id: STORE_1 });
      if (rivalPrice !== null)
        seedStore(world, { stock: 1000, value: 100_000, price: rivalPrice, id: second });
      return run(world, 1).reduce(
        (a, e) =>
          e.type === 'store.sold' && e.payload.storeId === STORE_1 ? a + e.payload.quantity : a,
        0,
      );
    };
    const alone = salesOfFirst(null);
    const withCheapRival = salesOfFirst(150);
    expect(withCheapRival).toBeLessThan(alone);
  });
});
