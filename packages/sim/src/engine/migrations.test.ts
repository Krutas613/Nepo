import { describe, expect, it } from 'vitest';
import { STANDARD_CHART } from '../accounting/chart.js';
import { accountingSystem } from '../accounting/index.js';
import {
  ACCOUNT_CODE_PATTERN,
  EMPTY_CONTENT_PACK,
  EMPTY_TYPED_SLICES,
  SCHEMA_VERSION,
  SnapshotError,
  SnapshotSchema,
  WorldStateSchema,
  type WorldState,
} from '../schema/index.js';
import { hashState } from './hash.js';
import {
  addChartAccountsV2,
  migrateSnapshot,
  migrateV1ToV2,
  MIGRATIONS,
  rekeyAccountCode,
  rekeyAccountCodesV2,
  V2_ADDED_ACCOUNTS,
} from './migrations.js';
import { restore, snapshot } from './snapshot.js';
import { step } from './world.js';

/**
 * A hand-written schema-v1 save: one entity (co_000001) with 4-digit account codes, two month
 * reports, a three-entry journal (opening capital; inventory purchase; a sale with its COGS),
 * untyped `economy`/`retail` values (legal in v1; step 1 must replace them) and an untyped `ai`
 * slice (must survive). Balances: 1000 = 100,000,000 - 4,000,000 + 5,000,000; 1210 = 4,000,000 -
 * 3,000,000; 3000 = -100,000,000; 4000 = -5,000,000; 5000 = 3,000,000 (sum 0). The scenario has no
 * `content` (v1). The hash is deliberately not the state's: it is not checked after a migration.
 */
const V1_SNAPSHOT_JSON = `{
  "format": "nepo/snapshot",
  "schemaVersion": 1,
  "engineVersion": "0.1.0",
  "hash": "0123456789abcdef",
  "scenario": {
    "id": "smoke",
    "name": "Smoke test",
    "epochYear": 2000,
    "companies": [{ "name": "Player Holdings", "controller": "player", "startingCash": 100000000 }]
  },
  "state": {
    "seed": 7,
    "tick": 61,
    "epochYear": 2000,
    "commandSeq": 0,
    "pendingCommands": [],
    "registry": { "counters": { "company": 1, "journalEntry": 3 } },
    "rng": { "ai": { "s": [1, 2, 3, 4] } },
    "companies": {
      "co_000001": {
        "id": "co_000001",
        "name": "Player Holdings",
        "controller": "player",
        "parentId": null,
        "foundedTick": 0
      }
    },
    "economy": { "legacy": [1, 2, 3] },
    "retail": "untyped v1 value",
    "ai": { "decisions": 3 },
    "accounting": {
      "entities": {
        "co_000001": {
          "entityId": "co_000001",
          "parentId": null,
          "accounts": {
            "1000": { "code": "1000", "name": "Cash", "type": "asset", "balance": 101000000 },
            "1100": { "code": "1100", "name": "Accounts Receivable", "type": "asset", "balance": 0 },
            "1210": { "code": "1210", "name": "Inventory - Finished Goods", "type": "asset", "balance": 1000000 },
            "2000": { "code": "2000", "name": "Accounts Payable", "type": "liability", "balance": 0 },
            "3000": { "code": "3000", "name": "Share Capital", "type": "equity", "balance": -100000000 },
            "3100": { "code": "3100", "name": "Retained Earnings", "type": "equity", "balance": 0 },
            "4000": { "code": "4000", "name": "Sales Revenue", "type": "revenue", "balance": -5000000 },
            "5000": { "code": "5000", "name": "Cost of Goods Sold", "type": "expense", "balance": 3000000 }
          },
          "monthOpening": {
            "1000": 101000000, "1100": 0, "1210": 1000000, "2000": 0,
            "3000": -100000000, "3100": 0, "4000": -5000000, "5000": 3000000
          },
          "yearOpening": {
            "1000": 0, "1100": 0, "1210": 0, "2000": 0, "3000": 0, "3100": 0, "4000": 0, "5000": 0
          },
          "reports": [
            {
              "kind": "month", "year": 2000, "month": 1, "tick": 29,
              "income": {
                "revenue": 0, "cogs": 0, "grossProfit": 0, "opex": 0, "operatingIncome": 0,
                "otherIncome": 0, "pretaxIncome": 0, "incomeTax": 0, "netIncome": 0,
                "byAccount": { "4000": 0, "5000": 0 }
              },
              "balance": {
                "assets": 100000000, "liabilities": 0, "equity": 100000000,
                "byAccount": { "1000": 100000000, "1100": 0, "1210": 0, "2000": 0, "3000": -100000000, "3100": 0 }
              },
              "cashFlow": {
                "netIncome": 0, "operating": 0, "investing": 0, "financing": 100000000,
                "netChange": 100000000, "openingCash": 0, "closingCash": 100000000
              }
            },
            {
              "kind": "month", "year": 2000, "month": 2, "tick": 59,
              "income": {
                "revenue": 5000000, "cogs": 3000000, "grossProfit": 2000000, "opex": 0,
                "operatingIncome": 2000000, "otherIncome": 0, "pretaxIncome": 2000000,
                "incomeTax": 0, "netIncome": 2000000,
                "byAccount": { "4000": 5000000, "5000": 3000000 }
              },
              "balance": {
                "assets": 102000000, "liabilities": 0, "equity": 102000000,
                "byAccount": { "1000": 101000000, "1100": 0, "1210": 1000000, "2000": 0, "3000": -100000000, "3100": 0 }
              },
              "cashFlow": {
                "netIncome": 2000000, "operating": 1000000, "investing": 0, "financing": 0,
                "netChange": 1000000, "openingCash": 100000000, "closingCash": 101000000
              }
            }
          ]
        }
      },
      "journal": [
        {
          "id": "je_000001", "entityId": "co_000001", "tick": 0, "memo": "Opening capital",
          "source": "accounting",
          "lines": [
            { "account": "1000", "debit": 100000000, "credit": 0 },
            { "account": "3000", "debit": 0, "credit": 100000000 }
          ]
        },
        {
          "id": "je_000002", "entityId": "co_000001", "tick": 31, "memo": "Inventory purchase",
          "source": "accounting", "ref": { "kind": "test", "id": "purchase-1" },
          "lines": [
            { "account": "1210", "debit": 4000000, "credit": 0 },
            { "account": "1000", "debit": 0, "credit": 4000000 }
          ]
        },
        {
          "id": "je_000003", "entityId": "co_000001", "tick": 35, "memo": "Sale",
          "source": "accounting",
          "lines": [
            { "account": "1000", "debit": 5000000, "credit": 0 },
            { "account": "4000", "debit": 0, "credit": 5000000 },
            { "account": "5000", "debit": 3000000, "credit": 0 },
            { "account": "1210", "debit": 0, "credit": 3000000 }
          ]
        }
      ]
    }
  }
}`;

interface V1Ledger {
  accounts: Record<string, { code: string; balance: number }>;
  monthOpening: Record<string, number>;
  yearOpening: Record<string, number>;
  reports: {
    income: { byAccount: Record<string, number> };
    balance: { byAccount: Record<string, number> };
  }[];
}

function v1Snapshot(): { state: Record<string, unknown> } & Record<string, unknown> {
  return JSON.parse(V1_SNAPSHOT_JSON) as { state: Record<string, unknown> } & Record<
    string,
    unknown
  >;
}

function v1State(): Record<string, unknown> {
  return v1Snapshot().state;
}

function v1Ledger(): V1Ledger {
  const accounting = v1State()['accounting'] as { entities: Record<string, V1Ledger> };
  return accounting.entities['co_000001']!;
}

function migrated(): WorldState {
  return migrateV1ToV2(v1State()) as WorldState;
}

const prefixed = (record: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [`a${k}`, v]));

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

describe('MIGRATIONS[1] (v1 -> v2)', () => {
  it('is registered as the only step and SCHEMA_VERSION is 2', () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(Object.keys(MIGRATIONS)).toEqual(['1']);
    expect(MIGRATIONS[1]).toBe(migrateV1ToV2);
  });

  it('the fixture is a v1 state: 4-digit codes, untyped economy/retail, no manufacturing/finance', () => {
    const state = v1State();
    expect(WorldStateSchema.safeParse(state).success).toBe(false);
    expect(Object.keys(v1Ledger().accounts).every((k) => /^[0-9]{4}$/.test(k))).toBe(true);
    expect(state['manufacturing']).toBeUndefined();
  });

  it('step 1: installs fresh copies of EMPTY_TYPED_SLICES, replacing untyped values', () => {
    const state = migrated();
    for (const id of ['economy', 'manufacturing', 'retail', 'finance'] as const) {
      expect(state[id]).toEqual(EMPTY_TYPED_SLICES[id]);
      expect(state[id]).not.toBe(EMPTY_TYPED_SLICES[id]);
      expect(Object.isFrozen(state[id])).toBe(false);
    }
    // Untouched: the untyped `ai` slice and every core field.
    const before = v1State();
    expect(state.ai).toEqual({ decisions: 3 });
    for (const key of [
      'seed',
      'tick',
      'epochYear',
      'commandSeq',
      'pendingCommands',
      'registry',
      'rng',
      'companies',
    ]) {
      expect((state as unknown as Record<string, unknown>)[key]).toEqual(before[key]);
    }
    expect(Object.keys(state).sort()).toEqual(
      [...new Set([...Object.keys(before), 'manufacturing', 'finance'])].sort(),
    );
  });

  it('step 2: prefixes every account code (accounts, openings, both report byAccounts, journal)', () => {
    const old = v1Ledger();
    const ledger = migrated().accounting.entities['co_000001' as never]!;
    for (const [code, account] of Object.entries(old.accounts)) {
      expect(ledger.accounts[`a${code}` as never]).toEqual({ ...account, code: `a${code}` });
    }
    for (const [key, account] of Object.entries(ledger.accounts)) {
      expect(key).toMatch(ACCOUNT_CODE_PATTERN);
      expect(account.code).toBe(key);
    }
    expect(ledger.reports).toHaveLength(2);
    ledger.reports.forEach((report, i) => {
      expect(report.income.byAccount).toEqual(prefixed(old.reports[i]!.income.byAccount));
      expect(report.balance.byAccount).toEqual(prefixed(old.reports[i]!.balance.byAccount));
    });
    const journal = migrated().accounting.journal;
    expect(journal.flatMap((e) => e.lines.map((l) => l.account))).toEqual(
      ['1000', '3000', '1210', '1000', '1000', '4000', '5000', '1210'].map((c) => `a${c}`),
    );
    // Everything but the codes is unchanged.
    const oldJournal = (v1State()['accounting'] as { journal: { lines: { account: string }[] }[] })
      .journal;
    expect(journal).toEqual(
      oldJournal.map((e) => ({
        ...e,
        lines: e.lines.map((l) => ({ ...l, account: `a${l.account}` })),
      })),
    );
  });

  it('step 3: adds a1205/a1230 with balance 0 and zero openings; reports untouched', () => {
    const old = v1Ledger();
    const ledger = migrated().accounting.entities['co_000001' as never]!;
    expect(ledger.accounts['a1205' as never]).toEqual({
      code: 'a1205',
      name: 'Inventory - Work in Progress',
      type: 'asset',
      balance: 0,
    });
    expect(ledger.accounts['a1230' as never]).toEqual({
      code: 'a1230',
      name: 'Inventory - Merchandise',
      type: 'asset',
      balance: 0,
    });
    expect(ledger.monthOpening).toEqual({ ...prefixed(old.monthOpening), a1205: 0, a1230: 0 });
    expect(ledger.yearOpening).toEqual({ ...prefixed(old.yearOpening), a1205: 0, a1230: 0 });
    expect(Object.keys(ledger.accounts)).toHaveLength(Object.keys(old.accounts).length + 2);
    for (const report of ledger.reports) {
      expect(Object.keys(report.balance.byAccount)).not.toContain('a1205');
      expect(Object.keys(report.balance.byAccount)).not.toContain('a1230');
    }
  });

  it("V2_ADDED_ACCOUNTS equals accounting's STANDARD_CHART rows", () => {
    for (const row of V2_ADDED_ACCOUNTS) {
      expect(STANDARD_CHART.find((c) => c.code === row.code)).toEqual(row);
    }
    expect(V2_ADDED_ACCOUNTS.map((r) => r.code)).toEqual(['a1205', 'a1230']);
  });

  it('keeps the per-entity sum of balances (and each balance) unchanged', () => {
    const old = v1Ledger();
    const ledger = migrated().accounting.entities['co_000001' as never]!;
    const oldBalances = Object.values(old.accounts).map((a) => a.balance);
    expect(sum(oldBalances)).toBe(0);
    expect(sum(Object.values(ledger.accounts).map((a) => a.balance))).toBe(sum(oldBalances));
    for (const [code, account] of Object.entries(old.accounts)) {
      expect(ledger.accounts[`a${code}` as never]?.balance).toBe(account.balance);
    }
  });

  it('the migrated snapshot passes SnapshotSchema (scenario content defaults to empty)', () => {
    const snap = v1Snapshot();
    const result = SnapshotSchema.safeParse({ ...snap, schemaVersion: 2, state: migrated() });
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data?.scenario.content).toEqual(EMPTY_CONTENT_PACK);
  });

  it('steps 2-3 are idempotent, and re-running the whole step on its output is a no-op', () => {
    const once = migrated();
    expect(addChartAccountsV2(rekeyAccountCodesV2(once))).toEqual(once);
    expect(rekeyAccountCodesV2(once)).toEqual(once);
    expect(addChartAccountsV2(once)).toEqual(once);
    // Step 1 is also a fixed point here because the migrated typed slices are empty.
    expect(migrateV1ToV2(once)).toEqual(once);
    expect(hashState(migrateV1ToV2(once) as WorldState)).toBe(hashState(once));
  });

  it('step 3 keeps an existing a1205/a1230 account and its openings', () => {
    const state = v1State();
    const ledger = (state['accounting'] as { entities: Record<string, V1Ledger> }).entities[
      'co_000001'
    ]!;
    ledger.accounts['1205'] = { code: '1205', balance: 7 };
    ledger.monthOpening['1205'] = 5;
    const out = migrateV1ToV2(state) as WorldState;
    const migratedLedger = out.accounting.entities['co_000001' as never]!;
    expect(migratedLedger.accounts['a1205' as never]).toEqual({ code: 'a1205', balance: 7 });
    expect(migratedLedger.monthOpening['a1205' as never]).toBe(5);
    expect(migratedLedger.accounts['a1230' as never]?.balance).toBe(0);
  });

  it('does not mutate its input and tolerates malformed input (validation rejects it later)', () => {
    const state = v1State();
    const copy = JSON.parse(JSON.stringify(state)) as unknown;
    migrateV1ToV2(state);
    expect(state).toEqual(copy);
    for (const bad of [null, 3, 'x', [], {}, { accounting: 1 }, { accounting: { entities: [] } }]) {
      expect(() => migrateV1ToV2(bad)).not.toThrow();
    }
    const odd = migrateV1ToV2({
      accounting: {
        entities: { x: { accounts: { '1000': 5 }, reports: [null] } },
        journal: [{ lines: [1] }],
      },
    });
    expect(odd).toMatchObject({
      accounting: {
        entities: { x: { accounts: { a1000: 5 }, reports: [null] } },
        journal: [{ lines: [1] }],
      },
    });
  });

  it('rekeyAccountCode prefixes exactly four digits', () => {
    expect(rekeyAccountCode('1000')).toBe('a1000');
    expect(rekeyAccountCode('a1000')).toBe('a1000');
    expect(rekeyAccountCode('100')).toBe('100');
    expect(rekeyAccountCode('10000')).toBe('10000');
    expect(rekeyAccountCode('x100')).toBe('x100');
  });

  it('migrateSnapshot runs it for v1 and nothing for v2', () => {
    expect(migrateSnapshot(v1State(), 1)).toEqual({ state: migrated(), steps: 1 });
    const once = migrated();
    expect(migrateSnapshot(once, 2).steps).toBe(0);
  });
});

describe('restore of a v1 snapshot', () => {
  it('migrates, skips the hash check, validates and yields a v2 world', () => {
    const world = restore(JSON.parse(V1_SNAPSHOT_JSON) as unknown, []);
    expect(world.state).toEqual(migrated());
    expect(world.scenario.content).toEqual(EMPTY_CONTENT_PACK);
    const resaved = snapshot(world);
    expect(resaved.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SnapshotSchema.safeParse(resaved).success).toBe(true);
    // The v2 resave round-trips with the hash check on.
    expect(hashState(restore(resaved, []).state)).toBe(hashState(world.state));
  });

  it('the hash is still checked for v2 snapshots', () => {
    const resaved = snapshot(restore(JSON.parse(V1_SNAPSHOT_JSON) as unknown, []));
    const tampered = { ...resaved, hash: '0123456789abcdef' };
    expect(() => restore(tampered, [])).toThrow(SnapshotError);
  });

  it('a migrated ledger works with the accounting system across a month close', () => {
    const world = restore(JSON.parse(V1_SNAPSHOT_JSON) as unknown, [accountingSystem]);
    while (world.state.tick < 95) step(world, { checkFinite: true });
    const ledger = world.state.accounting.entities['co_000001' as never]!;
    expect(ledger.reports.length).toBeGreaterThan(2);
    const latest = ledger.reports[ledger.reports.length - 1]!;
    expect(latest.balance.byAccount['a1230' as never] ?? 0).toBe(0);
    expect(sum(Object.values(ledger.accounts).map((a) => a.balance))).toBe(0);
    expect(WorldStateSchema.safeParse(world.state).success).toBe(true);
  });

  it('an invalid v1 state is rejected as invalid after migration', () => {
    const snap = v1Snapshot();
    snap.state['tick'] = -1;
    try {
      restore(snap, []);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SnapshotError);
      expect((e as SnapshotError).code).toBe('invalid');
    }
  });
});
