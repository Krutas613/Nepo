import { describe, expect, it } from 'vitest';
import {
  COMMAND_TYPES,
  CommandInputSchema,
  CommandSchema,
  CommandTypeSchema,
  EVENT_TYPES,
  EventSchema,
  validateCommandInput,
  type CommandType,
  type EventType,
} from './index.js';

type Path = readonly (string | number)[];

function withValue(root: unknown, path: Path, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(root)) as unknown;
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (last === undefined) throw new Error('empty path');
  node[last] = value;
  return copy;
}

/** One valid `CommandInput` per command type. */
const COMMAND_INPUTS: Record<CommandType, unknown> = {
  'company.rename': { name: 'Acme', companyId: 'co_000001' },
  'facility.build': { companyId: 'co_000001', facilityTypeId: 'bakery', cityId: 'springfield' },
  'facility.set_recipe': { facilityId: 'fa_000001', recipeId: null },
  'facility.set_production': { facilityId: 'fa_000001', targetBatches: 0 },
  'store.build': { companyId: 'co_000001', storeFormatId: 'grocery', cityId: 'springfield' },
  'store.set_price': { storeId: 'st_000001', productId: 'bread', price: 0 },
  'store.set_restock_policy': {
    storeId: 'st_000001',
    productId: 'bread',
    sourceFacilityId: 'fa_000001',
    targetStock: 100,
  },
  'loan.request': { companyId: 'co_000001', principal: -5, termMonths: 1 },
  'loan.repay': { loanId: 'ln_000001', amount: 0 },
};

const input = (type: CommandType): unknown => ({
  type,
  issuer: 'co_000001',
  payload: COMMAND_INPUTS[type],
});

describe('commands', () => {
  it('COMMAND_TYPES lists every member once, in schema order', () => {
    expect(COMMAND_TYPES).toEqual(CommandTypeSchema.options);
    expect(new Set(COMMAND_TYPES).size).toBe(9);
    expect(Object.keys(COMMAND_INPUTS).sort()).toEqual([...COMMAND_TYPES].sort());
  });

  it.each(COMMAND_TYPES.map((t) => [t]))('%s: input and stamped command validate', (type) => {
    const raw = input(type);
    const r = validateCommandInput(raw);
    expect(r).toEqual({ ok: true, value: raw });
    expect(CommandInputSchema.safeParse(raw).success).toBe(true);
    const stamped = { ...(raw as object), seq: 1, tick: 0 };
    expect(CommandSchema.parse(stamped)).toEqual(stamped);
    expect(CommandInputSchema.safeParse(stamped).success).toBe(false);
  });

  it.each<[CommandType, Path, unknown]>([
    ['facility.build', ['payload', 'companyId'], 'company_1'],
    ['facility.build', ['payload', 'cityId'], 'Springfield'],
    ['facility.build', ['payload', 'extra'], 1],
    ['facility.set_recipe', ['payload', 'recipeId'], undefined],
    ['facility.set_production', ['payload', 'targetBatches'], -1],
    ['facility.set_production', ['payload', 'targetBatches'], 1.5],
    ['store.build', ['payload', 'storeFormatId'], 7],
    ['store.set_price', ['payload', 'price'], 2.5],
    ['store.set_price', ['payload', 'storeId'], 'fa_000001'],
    ['store.set_restock_policy', ['payload', 'sourceFacilityId'], 'st_000001'],
    ['store.set_restock_policy', ['payload', 'targetStock'], -3],
    ['loan.request', ['payload', 'termMonths'], 0],
    ['loan.request', ['payload', 'principal'], NaN],
    ['loan.repay', ['payload', 'loanId'], 'loan-1'],
    ['loan.repay', ['payload', 'amount'], -0],
  ])('%s rejects %j = %s', (type, path, value) => {
    const r = validateCommandInput(withValue(input(type), path, value));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_shape');
      expect(r.error.issues.length).toBeGreaterThan(0);
    }
  });
});

/** One valid payload per event type. */
const EVENT_PAYLOADS: Record<EventType, unknown> = {
  'command.rejected': {
    commandSeq: 1,
    commandType: 'loan.request',
    issuer: 'co_000001',
    code: 'not_owner',
    reason: 'x',
  },
  'company.founded': { companyId: 'co_000001', name: 'A' },
  'company.renamed': { companyId: 'co_000001', name: 'B' },
  'ledger.posted': { entryId: 'je_000001', entityId: 'co_000001', memo: 'm' },
  'period.closed': { entityId: 'co_000001', kind: 'month', year: 2000, month: 1 },
  'market.opened': { marketId: 'springfield_market', cityId: 'springfield' },
  'macro.month_applied': { tick: 30, priceIndex: 1.001 },
  'commodity.purchased': {
    companyId: 'co_000001',
    productId: 'grain',
    quantity: 100,
    unitPrice: 30,
    total: 3000,
  },
  'facility.ordered': {
    facilityId: 'fa_000001',
    companyId: 'co_000001',
    facilityTypeId: 'bakery',
    cityId: 'springfield',
    completesTick: 10,
  },
  'facility.completed': { facilityId: 'fa_000001' },
  'facility.recipe_set': { facilityId: 'fa_000001', recipeId: 'bake_bread' },
  'facility.production_set': { facilityId: 'fa_000001', targetBatches: 3 },
  'production.completed': {
    facilityId: 'fa_000001',
    recipeId: 'bake_bread',
    batches: 2,
    outputs: [{ productId: 'bread', quantity: 200, cost: 13_000 }],
  },
  'production.starved': { facilityId: 'fa_000001', reason: 'no_cash', wanted: 3, started: 1 },
  'store.ordered': {
    storeId: 'st_000001',
    companyId: 'co_000001',
    storeFormatId: 'grocery',
    cityId: 'springfield',
    completesTick: 5,
  },
  'store.opened': { storeId: 'st_000001' },
  'store.price_set': { storeId: 'st_000001', productId: 'bread', price: null },
  'store.restock_policy_set': {
    storeId: 'st_000001',
    productId: 'bread',
    sourceFacilityId: null,
    targetStock: 0,
  },
  'store.restocked': {
    storeId: 'st_000001',
    facilityId: 'fa_000001',
    productId: 'bread',
    quantity: 100,
    cost: 6500,
  },
  'store.restock_failed': { storeId: 'st_000001', productId: 'bread', code: 'not_owner' },
  'store.sold': {
    storeId: 'st_000001',
    productId: 'bread',
    quantity: 50,
    revenue: 12_500,
    cogs: 3250,
    price: 250,
    referencePrice: 250,
    stockout: false,
  },
  'loan.issued': {
    loanId: 'ln_000001',
    companyId: 'co_000001',
    principal: 1_000_000,
    termMonths: 6,
    annualRate: 0.06,
  },
  'loan.payment': { loanId: 'ln_000001', principal: 166_667, interest: 3333, outstanding: 833_333 },
  'loan.payment_missed': { loanId: 'ln_000001', due: 170_000, cash: -4_900_000 },
  'loan.defaulted': { loanId: 'ln_000001' },
  'loan.repaid': { loanId: 'ln_000001', principal: 0, interest: 10 },
  'loan.closed': { loanId: 'ln_000001' },
  'credit.overdrawn': { companyId: 'co_000001', cash: -1 },
  'credit.insolvent': { companyId: 'co_000001', cash: -5_000_001, limit: 5_000_000 },
  'credit.restored': { companyId: 'co_000001' },
};

const event = (type: EventType): unknown => ({
  tick: 3,
  seq: 0,
  source: 'retail',
  type,
  payload: EVENT_PAYLOADS[type],
});

describe('events', () => {
  it('EVENT_TYPES lists 30 distinct members (5 M0 + 25 M1) matching the schema', () => {
    expect(EVENT_TYPES.length).toBe(30);
    expect(new Set(EVENT_TYPES).size).toBe(30);
    expect(Object.keys(EVENT_PAYLOADS).sort()).toEqual([...EVENT_TYPES].sort());
    expect([...EventSchema.options.map((o) => o.shape.type.value)].sort()).toEqual(
      [...EVENT_TYPES].sort(),
    );
  });

  it.each(EVENT_TYPES.map((t) => [t]))('%s validates', (type) => {
    const raw = event(type);
    expect(EventSchema.parse(raw)).toEqual(raw);
  });

  it.each<[EventType, Path, unknown]>([
    ['production.starved', ['payload', 'reason'], 'bored'],
    ['production.completed', ['payload', 'outputs', 0, 'quantity'], -1],
    ['store.sold', ['payload', 'stockout'], undefined],
    ['store.sold', ['payload', 'revenue'], 1.5],
    ['loan.issued', ['payload', 'termMonths'], 0],
    ['loan.issued', ['payload', 'annualRate'], Infinity],
    ['macro.month_applied', ['payload', 'priceIndex'], NaN],
    ['credit.insolvent', ['payload', 'limit'], undefined],
    ['facility.recipe_set', ['payload', 'extra'], true],
    ['market.opened', ['source'], 'markets'],
  ])('%s rejects %j = %s', (type, path, value) => {
    expect(EventSchema.safeParse(withValue(event(type), path, value)).success).toBe(false);
  });
});
