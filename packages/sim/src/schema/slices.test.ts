import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AccountingStateSchema,
  EconomyStateSchema,
  EMPTY_ACCOUNTING_STATE,
  EMPTY_ECONOMY_STATE,
  EMPTY_FINANCE_STATE,
  EMPTY_LOT,
  EMPTY_MANUFACTURING_STATE,
  EMPTY_RETAIL_STATE,
  EMPTY_TYPED_SLICES,
  FinanceStateSchema,
  InventoryLotSchema,
  ManufacturingStateSchema,
  RetailStateSchema,
  SYSTEM_ORDER,
  type EconomyState,
  type FinanceState,
  type ManufacturingState,
  type RetailState,
  type TypedDomainSliceId,
} from './index.js';

type Path = readonly (string | number)[];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withValue(root: unknown, path: Path, value: unknown): unknown {
  const copy = clone(root);
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (last === undefined) throw new Error('empty path');
  node[last] = value;
  return copy;
}

const lot = (quantity: number, value: number, received: number, issued: number): unknown => ({
  quantity,
  value,
  received,
  issued,
});

// Raw JSON fixtures (validated below, so the brands come from parsing).
const economy = {
  macro: { priceIndex: 1.02, policyRate: 0.04, demandIndex: 1, lastMonthApplied: 30 },
  markets: {
    springfield_market: {
      id: 'springfield_market',
      city: 'springfield',
      region: 'heartland',
      products: {
        bread: {
          level: 1.01,
          imbalanceEma: -0.2,
          referencePrice: 252,
          demandToday: 400,
          demandRemaining: 120,
          offeredToday: 312.5,
          soldToday: 280,
          lastDemand: 400,
          lastOffered: 401.25,
          lastSold: 395,
        },
      },
    },
  },
  commodities: {
    grain: { level: 1.1, volumeEma: 0.3, unitPrice: 33, purchasedToday: 50, lastPurchased: 0 },
  },
};

const facility = {
  id: 'fa_000001',
  ownerId: 'co_000001',
  typeId: 'bakery',
  cityId: 'springfield',
  status: 'operating',
  orderedTick: 0,
  completesTick: 10,
  recipeId: 'bake_bread',
  targetBatches: 2,
  wip: [
    { recipeId: 'bake_bread', batches: 1, startedTick: 11, completesTick: 13, value: 6500 },
    { recipeId: 'bake_bread', batches: 1, startedTick: 12, completesTick: 14, value: 6500 },
  ],
  inputs: { grain: lot(0, 0, 100, 100) },
  outputs: { bread: lot(150, 9750, 200, 50) },
  cost: 5_000_000,
  accumulatedDepreciation: 41_666,
  starvedReason: 'capacity',
};
const manufacturing = { facilities: { fa_000001: facility } };

const store = {
  id: 'st_000001',
  ownerId: 'co_000001',
  formatId: 'grocery',
  cityId: 'springfield',
  marketId: 'springfield_market',
  status: 'operating',
  orderedTick: 0,
  completesTick: 5,
  shelves: {
    bread: {
      lot: lot(30, 1950, 80, 50),
      price: null,
      restock: { sourceFacilityId: 'fa_000001', targetStock: 100 },
      soldToday: 50,
      revenueToday: 12_600,
      unmetToday: 0,
      shrunk: 0,
    },
  },
  cost: 2_000_000,
  accumulatedDepreciation: 0,
  brand: 0,
};
const retail = { stores: { st_000001: store } };

const loan = {
  id: 'ln_000001',
  borrowerId: 'co_000001',
  bankId: 'first_national',
  principal: 1_000_000,
  outstanding: 833_334,
  accruedInterest: 0,
  annualRate: 0.06,
  termMonths: 6,
  monthsRemaining: 5,
  drawnTick: 10,
  lastAccrualTick: 29,
  missedPayments: 0,
  consecutiveMissed: 0,
  status: 'active',
};
const finance = {
  loans: { ln_000001: loan },
  credit: {
    co_000001: {
      companyId: 'co_000001',
      overdrawnSince: null,
      insolventSince: null,
      overdraftAccrued: 0,
    },
  },
};

describe('inventory lots', () => {
  it('EMPTY_LOT validates and is frozen', () => {
    expect(InventoryLotSchema.parse(EMPTY_LOT)).toEqual({
      quantity: 0,
      value: 0,
      received: 0,
      issued: 0,
    });
    expect(Object.isFrozen(EMPTY_LOT)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['received - issued !== quantity', lot(5, 10, 5, 1)],
    ['negative value', lot(1, -1, 1, 0)],
    ['negative quantity', lot(-1, 0, 0, 1)],
    ['fractional quantity', lot(0.5, 0, 0.5, 0)],
    ['extra key', { ...(lot(0, 0, 0, 0) as object), unitCost: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(InventoryLotSchema.safeParse(value).success).toBe(false);
  });

  it('property: a lot validates iff received - issued === quantity (value >= 0)', () => {
    const n = fc.integer({ min: 0, max: 1_000_000_000 });
    fc.assert(
      fc.property(n, n, n, n, (quantity, value, received, issued) => {
        expect(InventoryLotSchema.safeParse(lot(quantity, value, received, issued)).success).toBe(
          received - issued === quantity,
        );
      }),
    );
  });

  it('property: receive/issue sequences (ADR-012 rules) always yield a valid lot', () => {
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('receive' as const),
        q: fc.integer({ min: 0, max: 10_000 }),
        cost: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      fc.record({
        kind: fc.constant('issue' as const),
        fraction: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const l = { quantity: 0, value: 0, received: 0, issued: 0 };
        for (const o of ops) {
          if (o.kind === 'receive') {
            l.quantity += o.q;
            l.value += o.cost;
            l.received += o.q;
          } else {
            const n = Math.floor(l.quantity * o.fraction);
            // allocateMoney(value, [n, quantity - n])[0], floor variant (exact for this check)
            const cost =
              l.quantity === 0
                ? 0
                : n === l.quantity
                  ? l.value
                  : Math.floor((l.value * n) / l.quantity);
            l.quantity -= n;
            l.value -= cost;
            l.issued += n;
          }
          expect(InventoryLotSchema.safeParse(l).success).toBe(true);
        }
      }),
    );
  });
});

describe('typed slices accept populated values', () => {
  it.each<[string, { parse: (v: unknown) => unknown }, unknown]>([
    ['economy', EconomyStateSchema, economy],
    ['manufacturing', ManufacturingStateSchema, manufacturing],
    ['retail', RetailStateSchema, retail],
    ['finance', FinanceStateSchema, finance],
  ])('%s', (_label, schema, value) => {
    expect(schema.parse(clone(value))).toEqual(value);
  });

  it('typed results are usable as slice types', () => {
    const e: EconomyState = EconomyStateSchema.parse(economy);
    const m: ManufacturingState = ManufacturingStateSchema.parse(manufacturing);
    const r: RetailState = RetailStateSchema.parse(retail);
    const f: FinanceState = FinanceStateSchema.parse(finance);
    expect([
      e.macro.priceIndex,
      Object.keys(m.facilities),
      Object.keys(r.stores),
      Object.keys(f.loans),
    ]).toEqual([1.02, ['fa_000001'], ['st_000001'], ['ln_000001']]);
  });
});

const M = ['markets', 'springfield_market'] as const;
const PM = [...M, 'products', 'bread'] as const;
const F = ['facilities', 'fa_000001'] as const;
const S = ['stores', 'st_000001'] as const;
const SH = [...S, 'shelves', 'bread'] as const;
const L = ['loans', 'ln_000001'] as const;

describe('typed slices reject', () => {
  it.each<[string, Path, unknown]>([
    ['market keyed under another id', [...M, 'id'], 'other_market'],
    ['demandRemaining > demandToday', [...PM, 'demandRemaining'], 401],
    ['NaN level', [...PM, 'level'], NaN],
    ['Infinity imbalanceEma', [...PM, 'imbalanceEma'], Infinity],
    ['negative offeredToday', [...PM, 'offeredToday'], -1],
    ['referencePrice 0', [...PM, 'referencePrice'], 0],
    ['commodity unitPrice 0', ['commodities', 'grain', 'unitPrice'], 0],
    ['priceIndex 0', ['macro', 'priceIndex'], 0],
    [
      'integer-like product key',
      [...M, 'products', '7'],
      economy.markets.springfield_market.products.bread,
    ],
    ['missing macro', ['macro'], undefined],
  ])('economy: %s', (_label, path, value) => {
    expect(EconomyStateSchema.safeParse(withValue(economy, path, value)).success).toBe(false);
  });

  it.each<[string, Path, unknown]>([
    ['facility keyed under another id', [...F, 'id'], 'fa_000002'],
    ['wip out of completesTick order', [...F, 'wip', 1, 'completesTick'], 12],
    ['bad lot', [...F, 'outputs', 'bread'], lot(150, 9750, 200, 49)],
    ['negative lot value', [...F, 'inputs', 'grain', 'value'], -1],
    ['unknown status', [...F, 'status'], 'closed'],
    ['unknown starvedReason', [...F, 'starvedReason'], 'tired'],
    ['negative cost', [...F, 'cost'], -1],
    ['store id as facility id', [...F, 'id'], 'st_000001'],
  ])('manufacturing: %s', (_label, path, value) => {
    expect(ManufacturingStateSchema.safeParse(withValue(manufacturing, path, value)).success).toBe(
      false,
    );
  });

  it.each<[string, Path, unknown]>([
    ['store keyed under another id', [...S, 'id'], 'st_000002'],
    ['price 0', [...SH, 'price'], 0],
    ['fractional price', [...SH, 'price'], 1.5],
    ['bad shelf lot', [...SH, 'lot', 'received'], 81],
    ['restock source not a facility id', [...SH, 'restock', 'sourceFacilityId'], 'bakery'],
    ['unknown status', [...S, 'status'], 'closed'],
    ['NaN brand', [...S, 'brand'], NaN],
  ])('retail: %s', (_label, path, value) => {
    expect(RetailStateSchema.safeParse(withValue(retail, path, value)).success).toBe(false);
  });

  it.each<[string, Path, unknown]>([
    ['loan keyed under another id', [...L, 'id'], 'ln_000002'],
    ['credit keyed under another company', ['credit', 'co_000001', 'companyId'], 'co_000002'],
    ['unknown loan status', [...L, 'status'], 'paid'],
    ['negative outstanding', [...L, 'outstanding'], -1],
    ['termMonths 0', [...L, 'termMonths'], 0],
    ['NaN annualRate', [...L, 'annualRate'], NaN],
    ['bank id not a slug', [...L, 'bankId'], 'First National'],
    ['fractional overdrawnSince', ['credit', 'co_000001', 'overdrawnSince'], 1.5],
  ])('finance: %s', (_label, path, value) => {
    expect(FinanceStateSchema.safeParse(withValue(finance, path, value)).success).toBe(false);
  });
});

describe('empty slices', () => {
  it.each<[string, { parse: (v: unknown) => unknown }, unknown]>([
    ['accounting', AccountingStateSchema, EMPTY_ACCOUNTING_STATE],
    ['economy', EconomyStateSchema, EMPTY_ECONOMY_STATE],
    ['manufacturing', ManufacturingStateSchema, EMPTY_MANUFACTURING_STATE],
    ['retail', RetailStateSchema, EMPTY_RETAIL_STATE],
    ['finance', FinanceStateSchema, EMPTY_FINANCE_STATE],
  ])('EMPTY %s validates and is deep-frozen', (_label, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value as Record<string, unknown>)) {
      expect(Object.isFrozen(child)).toBe(true);
    }
  });

  it('EMPTY_ECONOMY_STATE matches schema-m1.md section 5', () => {
    expect(EMPTY_ECONOMY_STATE).toEqual({
      macro: { priceIndex: 1, policyRate: 0, demandIndex: 1, lastMonthApplied: 0 },
      markets: {},
      commodities: {},
    });
    expect(EMPTY_MANUFACTURING_STATE).toEqual({ facilities: {} });
    expect(EMPTY_RETAIL_STATE).toEqual({ stores: {} });
    expect(EMPTY_FINANCE_STATE).toEqual({ loans: {}, credit: {} });
  });

  it('EMPTY_TYPED_SLICES has exactly the typed domain slices, in SYSTEM_ORDER, as the constants', () => {
    const expected: readonly TypedDomainSliceId[] = [
      'accounting',
      'economy',
      'manufacturing',
      'retail',
      'finance',
    ];
    expect(Object.keys(EMPTY_TYPED_SLICES)).toEqual(expected);
    expect(SYSTEM_ORDER.filter((id) => (expected as readonly string[]).includes(id))).toEqual(
      expected,
    );
    expect(EMPTY_TYPED_SLICES.accounting).toBe(EMPTY_ACCOUNTING_STATE);
    expect(EMPTY_TYPED_SLICES.economy).toBe(EMPTY_ECONOMY_STATE);
    expect(EMPTY_TYPED_SLICES.manufacturing).toBe(EMPTY_MANUFACTURING_STATE);
    expect(EMPTY_TYPED_SLICES.retail).toBe(EMPTY_RETAIL_STATE);
    expect(EMPTY_TYPED_SLICES.finance).toBe(EMPTY_FINANCE_STATE);
    expect(Object.isFrozen(EMPTY_TYPED_SLICES)).toBe(true);
    // The type schema-m1.md names is satisfied.
    const loose: Readonly<Record<TypedDomainSliceId, unknown>> = EMPTY_TYPED_SLICES;
    expect(loose).toBe(EMPTY_TYPED_SLICES);
  });
});
