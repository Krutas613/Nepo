import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CommandInputSchema,
  CommandSchema,
  CompanyIdSchema,
  EMPTY_SCENARIO,
  EventSchema,
  FacilitySchema,
  ID_PREFIX,
  InvariantError,
  MarketSchema,
  MAX_SCENARIO_STARTING_CASH,
  ProductIdSchema,
  ProductSchema,
  RecipeSchema,
  SCHEMA_VERSION,
  SMOKE_SCENARIO,
  SnapshotEnvelopeSchema,
  SnapshotError,
  SnapshotSchema,
  StoreSchema,
  SYSTEM_ORDER,
  SystemIdSchema,
  ScenarioSchema,
  ZERO_MONEY,
  accountCode,
  addMoney,
  addQuantity,
  companyId,
  compareMoney,
  entityIdPattern,
  err,
  invariant,
  journalEntryId,
  money,
  mulMoney,
  negMoney,
  ok,
  quantity,
  subMoney,
  subQuantity,
  sumMoney,
  validateCommandInput,
  type AccountCode,
  type EntityKind,
  type Money,
  type Snapshot,
  type SystemId,
  type WorldState,
} from './index.js';

const MAX = Number.MAX_SAFE_INTEGER;

function expectInvariant(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvariantError);
    expect((e as InvariantError).code).toBe(code);
    return;
  }
  throw new Error(`expected InvariantError(${code})`);
}

describe('money', () => {
  it.each([0.5, -1.25, NaN, Infinity, -Infinity, MAX + 1, -(MAX + 1), 2 ** 60])(
    'money(%s) throws money.unsafe',
    (n) => {
      expectInvariant(() => money(n), 'money.unsafe');
    },
  );

  it('accepts safe integers including the extremes and normalises -0', () => {
    expect(money(MAX)).toBe(MAX);
    expect(money(-MAX)).toBe(-MAX);
    expect(Object.is(money(-0), 0)).toBe(true);
    expect(Object.is(negMoney(ZERO_MONEY), 0)).toBe(true);
    expect(negMoney(money(5))).toBe(-5);
  });

  it('arithmetic helpers', () => {
    expect(subMoney(money(3), money(10))).toBe(-7);
    expect(sumMoney([money(1), money(2), money(3)])).toBe(6);
    expect(mulMoney(money(250), 4)).toBe(1000);
    expectInvariant(() => mulMoney(money(250), 0.5), 'money.unsafe');
    expect(compareMoney(money(1), money(2))).toBe(-1);
    expect(compareMoney(money(2), money(2))).toBe(0);
    expectInvariant(() => addMoney(money(MAX), money(1)), 'money.unsafe');
  });

  it('property: addMoney in range never throws and is commutative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -MAX, max: MAX }),
        fc.integer({ min: -MAX, max: MAX }),
        (a, b) => {
          fc.pre(Number.isSafeInteger(a + b));
          const x = addMoney(money(a), money(b));
          const y = addMoney(money(b), money(a));
          expect(x).toBe(y);
          expect(x).toBe(a + b);
        },
      ),
    );
  });

  it('property: addMoney leaving the safe range throws money.unsafe', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX }), fc.boolean(), (a, negative) => {
        // b chosen so that |a + b| > MAX while b itself is safe.
        const b = MAX - a + 1;
        const [x, y] = negative ? [-a, -b] : [a, b];
        expectInvariant(() => addMoney(money(x), money(y)), 'money.unsafe');
      }),
    );
  });
});

describe('quantity', () => {
  it('rejects negatives and non-integers', () => {
    expectInvariant(() => quantity(-1), 'quantity.negative');
    expectInvariant(() => quantity(1.5), 'quantity.unsafe');
    expectInvariant(() => quantity(NaN), 'quantity.unsafe');
    expect(addQuantity(quantity(2), quantity(3))).toBe(5);
    expectInvariant(() => subQuantity(quantity(2), quantity(3)), 'quantity.negative');
  });
});

describe('ids', () => {
  it('cast helpers return the string unchanged', () => {
    expect(companyId('co_000001')).toBe('co_000001');
    expect(journalEntryId('je_000042')).toBe('je_000042');
    expect(accountCode('1000')).toBe('1000');
  });

  it('entity id patterns follow the registry format', () => {
    const kinds = Object.keys(ID_PREFIX).sort() as EntityKind[];
    expect(new Set(kinds.map((k) => ID_PREFIX[k])).size).toBe(kinds.length);
    for (const kind of kinds) {
      const re = entityIdPattern(kind);
      expect(re.test(`${ID_PREFIX[kind]}_000001`)).toBe(true);
      expect(re.test(`${ID_PREFIX[kind]}_1234567`)).toBe(true);
      expect(re.test(`${ID_PREFIX[kind]}_00001`)).toBe(false);
      expect(re.test(`xx_000001`)).toBe(false);
    }
  });

  it('zod id schemas validate and brand', () => {
    expect(CompanyIdSchema.parse('co_000017')).toBe('co_000017');
    expect(CompanyIdSchema.safeParse('fa_000017').success).toBe(false);
    expect(ProductIdSchema.safeParse('steel_coil').success).toBe(true);
    expect(ProductIdSchema.safeParse('Steel').success).toBe(false);
    expect(ProductIdSchema.safeParse('1steel').success).toBe(false);
  });
});

describe('result and errors', () => {
  it('ok/err', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('x')).toEqual({ ok: false, error: 'x' });
  });

  it('invariant throws InvariantError with code and details', () => {
    expect(() => {
      invariant(true, 'a.b', 'fine');
    }).not.toThrow();
    try {
      invariant(false, 'a.b', 'broken', { n: 1 });
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantError);
      expect((e as InvariantError).code).toBe('a.b');
      expect((e as InvariantError).details).toEqual({ n: 1 });
    }
    const s = new SnapshotError('too_new', { version: 9 });
    expect(s.code).toBe('too_new');
    expect(s.details).toEqual({ version: 9 });
    expect(s.name).toBe('SnapshotError');
  });
});

describe('system order', () => {
  it('contains every SystemId exactly once', () => {
    const all: readonly SystemId[] = SystemIdSchema.options;
    expect(SYSTEM_ORDER.length).toBe(all.length);
    expect(new Set(SYSTEM_ORDER).size).toBe(SYSTEM_ORDER.length);
    expect([...SYSTEM_ORDER].sort()).toEqual([...all].sort());
    expect(SYSTEM_ORDER[0]).toBe('core');
    expect(SYSTEM_ORDER[1]).toBe('accounting');
  });
});

describe('scenario', () => {
  it('accepts the fixtures', () => {
    expect(ScenarioSchema.parse(SMOKE_SCENARIO)).toEqual(SMOKE_SCENARIO);
    expect(ScenarioSchema.parse(EMPTY_SCENARIO)).toEqual(EMPTY_SCENARIO);
    expect(SMOKE_SCENARIO.companies.map((c) => c.controller)).toEqual(['player', 'ai']);
    expect(SMOKE_SCENARIO.companies.every((c) => c.startingCash === 100_000_000)).toBe(true);
    expect(EMPTY_SCENARIO.companies).toEqual([]);
    expect(Object.isFrozen(SMOKE_SCENARIO.companies[0])).toBe(true);
  });

  it.each([
    [
      'float cash',
      { ...SMOKE_SCENARIO, companies: [{ name: 'A', controller: 'ai', startingCash: 1.5 }] },
    ],
    [
      'negative cash',
      { ...SMOKE_SCENARIO, companies: [{ name: 'A', controller: 'ai', startingCash: -1 }] },
    ],
    [
      'npc controller',
      { ...SMOKE_SCENARIO, companies: [{ name: 'A', controller: 'npc', startingCash: 1 }] },
    ],
    [
      'blank name',
      { ...SMOKE_SCENARIO, companies: [{ name: '  ', controller: 'ai', startingCash: 1 }] },
    ],
    ['extra key', { ...EMPTY_SCENARIO, extra: true }],
    ['missing epochYear', { id: 'x', name: 'x', companies: [] }],
    [
      'total cash over 2^50',
      {
        ...SMOKE_SCENARIO,
        companies: [
          { name: 'A', controller: 'player', startingCash: MAX_SCENARIO_STARTING_CASH },
          { name: 'B', controller: 'ai', startingCash: 1 },
        ],
      },
    ],
  ])('rejects %s', (_label, bad) => {
    expect(ScenarioSchema.safeParse(bad).success).toBe(false);
  });
});

describe('commands and events', () => {
  const rename = {
    seq: 1,
    tick: 0,
    issuer: 'co_000001',
    type: 'company.rename',
    payload: { name: 'New Name' },
  };

  it('validates commands and inputs', () => {
    expect(CommandSchema.safeParse(rename).success).toBe(true);
    expect(
      CommandSchema.safeParse({ ...rename, payload: { name: 'x', companyId: 'co_000002' } })
        .success,
    ).toBe(true);
    expect(CommandSchema.safeParse({ ...rename, type: 'company.fly' }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...rename, payload: {} }).success).toBe(false);
    expect(
      CommandSchema.safeParse({ ...rename, payload: { name: 'x', companyId: undefined } }).success,
    ).toBe(false);
    const { seq: _s, tick: _t, ...input } = rename;
    expect(CommandInputSchema.safeParse(input).success).toBe(true);
    expect(CommandInputSchema.safeParse(rename).success).toBe(false);
  });

  it('validateCommandInput returns invalid_shape with issues', () => {
    const r = validateCommandInput({ type: 'company.rename', issuer: 'bad', payload: { name: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_shape');
      expect(r.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('validates events', () => {
    expect(
      EventSchema.safeParse({
        tick: 3,
        seq: 0,
        source: 'core',
        type: 'command.rejected',
        payload: {
          commandSeq: 1,
          commandType: 'company.rename',
          issuer: 'co_000009',
          code: 'unknown_issuer',
          reason: 'no such company',
        },
      }).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse({
        tick: 29,
        seq: 4,
        source: 'accounting',
        type: 'period.closed',
        payload: { entityId: 'co_000001', kind: 'month', year: 2000, month: 13 },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------

const code = (s: string): AccountCode => accountCode(s);
const m = (n: number): Money => money(n);

function minimalState(): WorldState {
  const co1 = companyId('co_000001');
  const cash = code('1000');
  const capital = code('3000');
  return {
    seed: 42,
    tick: 1,
    epochYear: 2000,
    commandSeq: 2,
    pendingCommands: [
      { seq: 2, tick: 1, issuer: co1, type: 'company.rename', payload: { name: 'Renamed' } },
    ],
    registry: { counters: { company: 1, journalEntry: 1 } },
    rng: { core: { s: [1, 2, 3, 4] }, accounting: { s: [0, 4294967295, 7, 9] } },
    companies: {
      [co1]: {
        id: co1,
        name: 'Player Holdings',
        controller: 'player',
        parentId: null,
        foundedTick: 0,
      },
    },
    accounting: {
      entities: {
        [co1]: {
          entityId: co1,
          parentId: null,
          accounts: {
            [cash]: { code: cash, name: 'Cash', type: 'asset', balance: m(100) },
            [capital]: { code: capital, name: 'Share Capital', type: 'equity', balance: m(-100) },
          },
          monthOpening: { [cash]: m(0), [capital]: m(0) },
          yearOpening: { [cash]: m(0), [capital]: m(0) },
          reports: [],
        },
      },
      journal: [
        {
          id: journalEntryId('je_000001'),
          entityId: co1,
          tick: 0,
          memo: 'Opening capital',
          source: 'accounting',
          lines: [
            { account: cash, debit: m(100), credit: m(0) },
            { account: capital, debit: m(0), credit: m(100) },
          ],
        },
      ],
    },
  };
}

function minimalSnapshot(): Snapshot {
  return {
    format: 'nepo/snapshot',
    schemaVersion: SCHEMA_VERSION,
    engineVersion: '0.0.0-test',
    hash: '0123456789abcdef',
    state: minimalState(),
  };
}

type Path = readonly (string | number)[];

/** Sets `value` at `path` inside an untyped JSON tree (bypasses the brands on purpose). */
function setPath(root: unknown, path: Path, value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (last === undefined) throw new Error('empty path');
  node[last] = value;
}

/** JSON round trip of the minimal snapshot with one raw value replaced. */
function mutated(path: Path, value: unknown): unknown {
  const raw: unknown = JSON.parse(JSON.stringify(minimalSnapshot()));
  setPath(raw, path, value);
  return raw;
}

const CO1 = ['state', 'companies', 'co_000001'] as const;
const LEDGER1 = ['state', 'accounting', 'entities', 'co_000001'] as const;
const ENTRY0 = ['state', 'accounting', 'journal', 0] as const;

describe('snapshot', () => {
  it('SCHEMA_VERSION is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('accepts a hand-built minimal M0 snapshot, unchanged', () => {
    const snap = minimalSnapshot();
    const parsed = SnapshotSchema.parse(JSON.parse(JSON.stringify(snap)));
    expect(parsed).toEqual(snap);
  });

  it('accepts a snapshot with a period report', () => {
    const zeroIncome = {
      revenue: 0,
      cogs: 0,
      grossProfit: 0,
      opex: 0,
      operatingIncome: 0,
      otherIncome: 0,
      pretaxIncome: 0,
      incomeTax: 0,
      netIncome: 0,
      byAccount: {},
    };
    const report = {
      kind: 'month',
      year: 2000,
      month: 1,
      tick: 29,
      income: zeroIncome,
      balance: {
        assets: 100,
        liabilities: 0,
        equity: 100,
        byAccount: { '1000': 100, '3000': -100 },
      },
      cashFlow: {
        netIncome: 0,
        operating: 0,
        investing: 0,
        financing: 100,
        netChange: 100,
        openingCash: 0,
        closingCash: 100,
      },
    };
    expect(SnapshotSchema.safeParse(mutated([...LEDGER1, 'reports'], [report])).success).toBe(true);
  });

  const company1 = minimalState().companies[companyId('co_000001')];

  it.each<[string, Path, unknown]>([
    ['NaN balance', [...LEDGER1, 'accounts', '1000', 'balance'], NaN],
    ['Infinity tick', ['state', 'tick'], Infinity],
    ['-0 seed', ['state', 'seed'], -0],
    ['float money', [...ENTRY0, 'lines', 0, 'debit'], 0.5],
    ['Map companies', ['state', 'companies'], new Map([['co_000001', company1]])],
    ['entries-array companies', ['state', 'companies'], [['co_000001', company1]]],
    ['undefined optional', [...ENTRY0, 'ref'], undefined],
    ['unknown key', ['state', 'extra'], 1],
    ['company keyed under another id', ['state', 'companies', 'co_000002'], company1],
    ['bad id format', [...CO1, 'parentId'], 'company1'],
    ['rng word out of u32', ['state', 'rng', 'core', 's', 0], 2 ** 32],
    ['rng wrong arity', ['state', 'rng', 'core', 's'], [1, 2, 3]],
    ['unknown system source', [...ENTRY0, 'source'], 'banking'],
    ['pending seq beyond commandSeq', ['state', 'pendingCommands', 0, 'seq'], 3],
    ['wrong format', ['format'], 'other'],
    ['bad hash', ['hash'], 'xyz'],
  ])('rejects %s', (_label, path, value) => {
    expect(SnapshotSchema.safeParse(mutated(path, value)).success).toBe(false);
  });

  it('envelope schema passes state through unvalidated', () => {
    const raw = mutated(['state'], { legacy: true });
    expect(SnapshotSchema.safeParse(raw).success).toBe(false);
    expect(SnapshotEnvelopeSchema.safeParse(raw).success).toBe(true);
  });
});

describe('content', () => {
  it('accepts valid definitions', () => {
    expect(
      ProductSchema.safeParse({
        id: 'steel',
        name: 'Steel',
        category: 'intermediate',
        unit: 'tonne',
        basePrice: 45000,
      }).success,
    ).toBe(true);
    expect(
      RecipeSchema.safeParse({
        id: 'smelt_steel',
        name: 'Smelt steel',
        facility: 'steel_mill',
        inputs: [{ product: 'iron_ore', quantity: 2 }],
        outputs: [{ product: 'steel', quantity: 1 }],
        durationTicks: 1,
      }).success,
    ).toBe(true);
    expect(
      FacilitySchema.safeParse({
        id: 'steel_mill',
        name: 'Steel mill',
        kind: 'factory',
        buildCost: 1000,
        dailyOperatingCost: 10,
        capacity: 1,
      }).success,
    ).toBe(true);
    expect(
      StoreSchema.safeParse({
        id: 'corner_shop',
        name: 'Corner shop',
        buildCost: 1000,
        dailyOperatingCost: 10,
        shelfCapacity: 500,
        categories: ['consumer'],
      }).success,
    ).toBe(true);
    expect(
      MarketSchema.safeParse({
        id: 'springfield',
        name: 'Springfield',
        city: 'springfield',
        region: 'midwest',
        population: 100000,
        demand: [{ product: 'bread', baseDailyDemand: 500, referencePrice: 250 }],
      }).success,
    ).toBe(true);
  });

  it('rejects invalid definitions', () => {
    expect(
      ProductSchema.safeParse({
        id: 'steel',
        name: 'Steel',
        category: 'intermediate',
        unit: 'tonne',
        basePrice: 0,
      }).success,
    ).toBe(false);
    expect(
      ProductSchema.safeParse({
        id: 'Steel',
        name: 'Steel',
        category: 'intermediate',
        unit: 'tonne',
        basePrice: 1,
      }).success,
    ).toBe(false);
    expect(
      RecipeSchema.safeParse({
        id: 'r',
        name: 'R',
        facility: 'f',
        inputs: [],
        outputs: [],
        durationTicks: 1,
      }).success,
    ).toBe(false);
  });
});
