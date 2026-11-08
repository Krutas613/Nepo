import { describe, expect, it } from 'vitest';
import {
  InvariantError,
  accountCode,
  companyId,
  journalEntryId,
  money,
  type EventInput,
  type JournalEntryInput,
  type JournalLine,
  type Money,
} from '../schema/index.js';
import { ACCOUNTS, STANDARD_CHART } from './chart.js';
import { cr, dr } from './builders.js';
import {
  createAccountingState,
  getBalance,
  hasEntity,
  openEntity,
  postEntry,
  postEntryOrThrow,
  type LedgerEnv,
  type PostingErrorCode,
} from './ledger.js';
import { checkLedgerInvariants } from './invariants.js';

const A = companyId('co_000001');
const B = companyId('co_000002');

function makeEnv(tick = 7): LedgerEnv & { events: EventInput[]; issued: number } {
  const env = {
    tick,
    events: [] as EventInput[],
    issued: 0,
    issueEntryId() {
      env.issued += 1;
      return journalEntryId(`je_${String(env.issued).padStart(6, '0')}`);
    },
    emit(e: EventInput) {
      env.events.push(e);
    },
  };
  return env;
}

function line(account: string, debit: number, credit: number): JournalLine {
  return { account: accountCode(account), debit: debit as Money, credit: credit as Money };
}

function entryOf(lines: JournalLine[]): JournalEntryInput {
  return { memo: 'test', lines, source: 'accounting' };
}

describe('openEntity', () => {
  it('opens the standard chart with zero balances and opening snapshots', () => {
    const state = createAccountingState();
    const ledger = openEntity(state, A);
    expect(hasEntity(state, A)).toBe(true);
    expect(hasEntity(state, B)).toBe(false);
    expect(ledger.parentId).toBeNull();
    expect(Object.keys(ledger.accounts)).toEqual(STANDARD_CHART.map((r) => r.code));
    for (const row of STANDARD_CHART) {
      expect(ledger.accounts[row.code]).toEqual({ ...row, balance: 0 });
      expect(ledger.monthOpening[row.code]).toBe(0);
      expect(ledger.yearOpening[row.code]).toBe(0);
    }
    expect(ledger.reports).toEqual([]);
  });

  it('records the parent and refuses to open twice', () => {
    const state = createAccountingState();
    openEntity(state, A);
    expect(openEntity(state, B, A).parentId).toBe(A);
    expect(() => openEntity(state, A)).toThrow(InvariantError);
    try {
      openEntity(state, A);
    } catch (e) {
      expect((e as InvariantError).code).toBe('accounting.entity_exists');
    }
  });
});

describe('postEntry validation table', () => {
  const cases: { name: string; entity?: typeof A; lines: JournalLine[]; code: PostingErrorCode }[] =
    [
      {
        name: 'unknown entity',
        entity: B,
        lines: [line('1000', 5, 0), line('3000', 0, 5)],
        code: 'unknown_entity',
      },
      { name: 'no lines', lines: [], code: 'empty' },
      { name: 'one line', lines: [line('1000', 5, 0)], code: 'empty' },
      {
        name: 'zero line (both sides 0)',
        lines: [line('1000', 0, 0), line('3000', 0, 0)],
        code: 'invalid_line',
      },
      {
        name: 'both sides non-zero',
        lines: [line('1000', 5, 5), line('3000', 0, 0)],
        code: 'invalid_line',
      },
      {
        name: 'negative debit',
        lines: [line('1000', -5, 0), line('3000', 0, -5)],
        code: 'invalid_line',
      },
      {
        name: 'negative credit',
        lines: [line('1000', 5, 0), line('3000', 0, -5)],
        code: 'invalid_line',
      },
      {
        name: 'fractional amount',
        lines: [line('1000', 1.5, 0), line('3000', 0, 1.5)],
        code: 'invalid_line',
      },
      {
        name: 'NaN amount',
        lines: [line('1000', Number.NaN, 0), line('3000', 0, 5)],
        code: 'invalid_line',
      },
      {
        name: 'unsafe amount',
        lines: [line('1000', 2 ** 53, 0), line('3000', 0, 2 ** 53)],
        code: 'invalid_line',
      },
      {
        name: 'unknown account',
        lines: [line('1000', 5, 0), line('8000', 0, 5)],
        code: 'unknown_account',
      },
      { name: 'unbalanced', lines: [line('1000', 5, 0), line('3000', 0, 4)], code: 'unbalanced' },
      {
        name: 'unbalanced across several lines',
        lines: [line('1000', 5, 0), line('1100', 5, 0), line('3000', 0, 9)],
        code: 'unbalanced',
      },
      {
        name: 'totals overflow',
        lines: [
          line('1000', Number.MAX_SAFE_INTEGER, 0),
          line('1100', Number.MAX_SAFE_INTEGER, 0),
          line('3000', 0, Number.MAX_SAFE_INTEGER),
          line('2000', 0, Number.MAX_SAFE_INTEGER),
        ],
        code: 'overflow',
      },
      {
        name: 'resulting balance overflow',
        lines: [line('1000', Number.MAX_SAFE_INTEGER, 0), line('3000', 0, Number.MAX_SAFE_INTEGER)],
        code: 'overflow',
      },
    ];

  for (const c of cases) {
    it(`${c.name} -> ${c.code}, atomically`, () => {
      const state = createAccountingState();
      openEntity(state, A);
      const env = makeEnv();
      // Seed a balance so the "resulting balance overflow" case starts from non-zero.
      postEntryOrThrow(state, A, entryOf([line('1000', 10, 0), line('3000', 0, 10)]), env);
      const before = JSON.stringify(state);
      const issuedBefore = env.issued;
      const eventsBefore = env.events.length;

      const result = postEntry(state, c.entity ?? A, entryOf(c.lines), env);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(c.code);
        expect(result.error.message.length).toBeGreaterThan(0);
      }
      expect(JSON.stringify(state)).toBe(before);
      expect(env.issued).toBe(issuedBefore);
      expect(env.events.length).toBe(eventsBefore);
    });
  }

  it('reports the first failing check in the documented order', () => {
    const state = createAccountingState();
    openEntity(state, A);
    // invalid_line wins over unknown_account and unbalanced
    const r1 = postEntry(state, A, entryOf([line('9999', -1, 0), line('1000', 0, 7)]), makeEnv());
    expect(!r1.ok && r1.error.code).toBe('invalid_line');
    // unknown_account wins over unbalanced
    const r2 = postEntry(state, A, entryOf([line('9999', 1, 0), line('1000', 0, 7)]), makeEnv());
    expect(!r2.ok && r2.error.code).toBe('unknown_account');
  });

  it('postEntryOrThrow throws accounting.post_failed with the posting code', () => {
    const state = createAccountingState();
    openEntity(state, A);
    try {
      postEntryOrThrow(state, A, entryOf([line('1000', 5, 0), line('3000', 0, 4)]), makeEnv());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantError);
      expect((e as InvariantError).code).toBe('accounting.post_failed');
      expect((e as InvariantError).details['postingCode']).toBe('unbalanced');
    }
  });
});

describe('postEntry success', () => {
  it('stamps id and tick, copies lines, updates balances debit-normal and emits ledger.posted', () => {
    const state = createAccountingState();
    openEntity(state, A);
    const env = makeEnv(42);
    const lines = [
      dr(ACCOUNTS.CASH, money(1000)),
      cr(ACCOUNTS.LOANS, money(600)),
      cr(ACCOUNTS.SHARE_CAPITAL, money(400)),
    ];
    const input: JournalEntryInput = {
      memo: 'mixed',
      lines,
      source: 'finance',
      ref: { kind: 'loan', id: 'ln_000001' },
    };
    const result = postEntry(state, A, input, env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      id: 'je_000001',
      entityId: A,
      tick: 42,
      memo: 'mixed',
      source: 'finance',
      ref: { kind: 'loan', id: 'ln_000001' },
      lines,
    });
    expect(state.journal).toEqual([result.value]);
    // Lines are copied: mutating the caller's input does not touch the journal.
    (lines[0] as { debit: Money }).debit = money(1);
    expect(state.journal[0]?.lines[0]?.debit).toBe(1000);

    expect(getBalance(state, A, ACCOUNTS.CASH)).toBe(1000);
    expect(getBalance(state, A, ACCOUNTS.LOANS)).toBe(-600);
    expect(getBalance(state, A, ACCOUNTS.SHARE_CAPITAL)).toBe(-400);
    expect(env.events).toEqual([
      { type: 'ledger.posted', payload: { entryId: 'je_000001', entityId: A, memo: 'mixed' } },
    ]);
    expect(checkLedgerInvariants(state)).toEqual([]);
  });

  it('omits ref when absent and nets repeated accounts', () => {
    const state = createAccountingState();
    openEntity(state, A);
    const r = postEntryOrThrow(
      state,
      A,
      entryOf([line('1000', 10, 0), line('1000', 0, 3), line('3000', 0, 7)]),
      makeEnv(),
    );
    expect('ref' in r).toBe(false);
    expect(getBalance(state, A, ACCOUNTS.CASH)).toBe(7);
  });

  it('getBalance throws for an unknown entity or account', () => {
    const state = createAccountingState();
    openEntity(state, A);
    expect(() => getBalance(state, B, ACCOUNTS.CASH)).toThrow(/accounting.unknown_entity/);
    expect(() => getBalance(state, A, accountCode('8888'))).toThrow(/accounting.unknown_account/);
  });
});

describe('checkLedgerInvariants', () => {
  it('detects a tampered balance, an unbalanced entry, a bad line and an unknown account', () => {
    const state = createAccountingState();
    openEntity(state, A);
    const env = makeEnv();
    postEntryOrThrow(state, A, entryOf([line('1000', 10, 0), line('3000', 0, 10)]), env);
    expect(checkLedgerInvariants(state)).toEqual([]);

    const ledger = state.entities[A];
    if (ledger === undefined) throw new Error('missing ledger');
    const cash = ledger.accounts[ACCOUNTS.CASH];
    if (cash === undefined) throw new Error('missing cash');
    cash.balance = money(11);
    state.journal.push({
      id: journalEntryId('je_000099'),
      entityId: A,
      tick: 0,
      memo: 'tampered',
      source: 'accounting',
      lines: [line('1000', 5, 0), line('7777', 0, 4), line('3000', 1, 1)],
    });
    cash.balance = 1.5 as Money;
    const codes = checkLedgerInvariants(state).map((v) => v.code);
    expect(codes).toContain('balance.unsafe');
    expect(codes).toContain('entry.unbalanced');
    expect(codes).toContain('entry.unknown_account');
    expect(codes).toContain('entry.invalid_line');
    cash.balance = money(11);
    expect(checkLedgerInvariants(state).map((v) => v.code)).toContain('entity.unbalanced');
  });
});
