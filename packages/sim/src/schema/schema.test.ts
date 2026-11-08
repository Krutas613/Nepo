import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CommandInputSchema,
  CommandSchema,
  CompanyIdSchema,
  AccountCodeSchema,
  BankIdSchema,
  CityIdSchema,
  EMPTY_SCENARIO,
  EMPTY_TYPED_SLICES,
  FacilityIdSchema,
  FacilityTypeIdSchema,
  LoanIdSchema,
  MarketIdSchema,
  RecipeIdSchema,
  RecordKeySchema,
  RegionIdSchema,
  StoreFormatIdSchema,
  StoreIdSchema,
  JsonValueSchema,
  EventSchema,
  ID_PREFIX,
  InvariantError,
  MAX_SCENARIO_STARTING_CASH,
  ProductIdSchema,
  SCHEMA_VERSION,
  SMOKE_SCENARIO,
  SnapshotEnvelopeSchema,
  SnapshotError,
  SnapshotSchema,
  WorldStateSchema,
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
    expect(accountCode('a1000')).toBe('a1000');
  });

  it('AccountCodeSchema takes the stored letter-prefixed form only (schema v2)', () => {
    for (const good of ['a1000', 'a1205', 'a1230', 'a2500', 'a7999']) {
      expect(AccountCodeSchema.parse(good)).toBe(good);
    }
    for (const bad of ['1000', 'a0999', 'a8000', 'A1000', 'a100', 'a10000', 'b1000', ' a1000']) {
      expect(AccountCodeSchema.safeParse(bad).success).toBe(false);
    }
    // String order of the stored form equals numeric order of the code.
    expect(['a5000', 'a1230', 'a1205', 'a4000'].sort()).toEqual([
      'a1205',
      'a1230',
      'a4000',
      'a5000',
    ]);
  });

  it('RecordKeySchema rejects integer-like keys', () => {
    for (const bad of ['0', '7', '1000', '007'])
      expect(RecordKeySchema.safeParse(bad).success).toBe(false);
    for (const good of ['core', 'a1000', '1a', '-1', '1.5', '']) {
      expect(RecordKeySchema.safeParse(good).success).toBe(true);
    }
  });

  it('property: no record key schema used in state accepts an integer-like string', () => {
    const keySchemas = [
      RecordKeySchema,
      AccountCodeSchema,
      CompanyIdSchema,
      FacilityIdSchema,
      StoreIdSchema,
      LoanIdSchema,
      ProductIdSchema,
      MarketIdSchema,
      CityIdSchema,
      RegionIdSchema,
      RecipeIdSchema,
      FacilityTypeIdSchema,
      StoreFormatIdSchema,
      BankIdSchema,
    ];
    fc.assert(
      fc.property(fc.stringMatching(/^\d{1,12}$/), (key) => {
        for (const schema of keySchemas) expect(schema.safeParse(key).success).toBe(false);
      }),
    );
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
    expect(Object.keys(SMOKE_SCENARIO.content.products)).toEqual([]);
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
  const cash = code('a1000');
  const capital = code('a3000');
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
    economy: EMPTY_TYPED_SLICES.economy,
    manufacturing: EMPTY_TYPED_SLICES.manufacturing,
    retail: EMPTY_TYPED_SLICES.retail,
    finance: EMPTY_TYPED_SLICES.finance,
  };
}

function minimalSnapshot(): Snapshot {
  return {
    format: 'nepo/snapshot',
    schemaVersion: SCHEMA_VERSION,
    engineVersion: '0.0.0-test',
    hash: '0123456789abcdef',
    scenario: SMOKE_SCENARIO,
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
  it('SCHEMA_VERSION is 2', () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('accepts a hand-built minimal v2 snapshot (all EMPTY_ typed slices), unchanged', () => {
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
        byAccount: { a1000: 100, a3000: -100 },
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
    ['NaN balance', [...LEDGER1, 'accounts', 'a1000', 'balance'], NaN],
    [
      'v1 account key',
      [...LEDGER1, 'accounts', '1000'],
      { code: 'a1000', name: 'Cash', type: 'asset', balance: 0 },
    ],
    ['v1 account code value', [...LEDGER1, 'accounts', 'a1000', 'code'], '1000'],
    ['v1 monthOpening key', [...LEDGER1, 'monthOpening', '1000'], 0],
    ['v1 yearOpening key', [...LEDGER1, 'yearOpening', '3000'], 0],
    ['v1 journal line account', [...ENTRY0, 'lines', 0, 'account'], '1000'],
    ['integer-like rng stream key', ['state', 'rng', '0'], { s: [1, 2, 3, 4] }],
    ['integer-like key inside an untyped slice', ['state', 'logistics'], { '42': 1 }],
    ['missing economy slice', ['state', 'economy'], undefined],
    ['missing manufacturing slice', ['state', 'manufacturing'], undefined],
    ['missing retail slice', ['state', 'retail'], undefined],
    ['missing finance slice', ['state', 'finance'], undefined],
    ['untyped JSON under a now-typed key', ['state', 'retail'], { price: 1 }],
    ['malformed economy slice', ['state', 'economy', 'macro'], {}],
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
    ['invalid scenario', ['scenario', 'companies', 0, 'startingCash'], -1],
    ['scenario with extra key', ['scenario', 'extra'], true],
    ['non-SystemId top-level key', ['state', 'bogus'], {}],
    ['core as an untyped slice (its typed slice is companies)', ['state', 'core'], {}],
    ['malformed typed slice', ['state', 'accounting'], { entities: {} }],
    ['typed slice with an extra key', ['state', 'accounting', 'extra'], []],
    ['NaN inside an untyped slice', ['state', 'logistics'], { price: NaN }],
    ['-0 inside an untyped slice', ['state', 'ai'], [1, -0]],
    ['undefined inside an untyped slice', ['state', 'hr'], { x: undefined }],
    ['Map as an untyped slice', ['state', 'hr'], new Map()],
    ['Set inside an untyped slice', ['state', 'ai'], { ids: new Set([1]) }],
    [
      'class instance as an untyped slice',
      ['state', 'logistics'],
      new (class Box {
        x = 1;
      })(),
    ],
  ])('rejects %s', (_label, path, value) => {
    expect(SnapshotSchema.safeParse(mutated(path, value)).success).toBe(false);
  });

  it('rejects a snapshot whose state lacks a typed slice (key deleted)', () => {
    for (const key of ['accounting', 'economy', 'manufacturing', 'retail', 'finance']) {
      const raw = JSON.parse(JSON.stringify(minimalSnapshot())) as {
        state: Record<string, unknown>;
      };
      Reflect.deleteProperty(raw.state, key);
      expect(SnapshotSchema.safeParse(raw).success).toBe(false);
    }
  });

  it('requires scenario in both the snapshot and the envelope', () => {
    const { scenario: _scenario, ...rest } = minimalSnapshot();
    const raw: unknown = JSON.parse(JSON.stringify(rest));
    expect(SnapshotSchema.safeParse(raw).success).toBe(false);
    expect(SnapshotEnvelopeSchema.safeParse(raw).success).toBe(false);
    expect(SnapshotEnvelopeSchema.safeParse(mutated(['scenario'], null)).success).toBe(false);
  });

  it('envelope schema passes state through unvalidated', () => {
    const raw = mutated(['state'], { legacy: true });
    expect(SnapshotSchema.safeParse(raw).success).toBe(false);
    expect(SnapshotEnvelopeSchema.safeParse(raw).success).toBe(true);
  });
});

describe('world state: untyped slices', () => {
  const typed: readonly SystemId[] = [
    'core',
    'accounting',
    'economy',
    'manufacturing',
    'retail',
    'finance',
  ];
  const untypedIds = SYSTEM_ORDER.filter((id) => !typed.includes(id));

  it('only logistics, ai and hr remain untyped', () => {
    expect(untypedIds).toEqual(['logistics', 'ai', 'hr']);
  });

  it('accepts `logistics: {}` and returns it unchanged', () => {
    const raw = { ...minimalState(), logistics: {} };
    expect(WorldStateSchema.parse(raw)).toEqual(raw);
  });

  it('accepts arbitrary plain JSON under every untyped SystemId', () => {
    const value = { a: [1, 'two', null, true, { nested: -3.5 }], b: {} };
    for (const id of untypedIds) {
      expect(WorldStateSchema.safeParse({ ...minimalState(), [id]: value }).success).toBe(true);
    }
    const all = Object.fromEntries(untypedIds.map((id) => [id, 0]));
    expect(WorldStateSchema.safeParse({ ...minimalState(), ...all }).success).toBe(true);
  });

  it('rejects `bogus: {}` (not a SystemId)', () => {
    expect(WorldStateSchema.safeParse({ ...minimalState(), bogus: {} }).success).toBe(false);
  });

  it('still rejects a badly shaped typed slice', () => {
    const state = minimalState();
    expect(
      WorldStateSchema.safeParse({ ...state, accounting: { ...state.accounting, journal: {} } })
        .success,
    ).toBe(false);
    expect(WorldStateSchema.safeParse({ ...state, accounting: {} }).success).toBe(false);
  });

  it('property: JsonValueSchema accepts every JSON round-trip value without integer-like keys', () => {
    const noIntegerLikeKeys = (v: unknown): boolean =>
      Array.isArray(v)
        ? v.every(noIntegerLikeKeys)
        : typeof v === 'object' && v !== null
          ? Object.keys(v).every(
              (k) => !/^\d+$/.test(k) && noIntegerLikeKeys((v as Record<string, unknown>)[k]),
            )
          : true;
    fc.assert(
      fc.property(fc.jsonValue().filter(noIntegerLikeKeys), (v) => {
        // The round trip turns -0 into 0, which state forbids anyway.
        const value: unknown = JSON.parse(JSON.stringify(v));
        expect(JsonValueSchema.safeParse(value).success).toBe(true);
      }),
    );
  });
});
