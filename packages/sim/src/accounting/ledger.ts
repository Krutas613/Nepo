/**
 * The double-entry ledger as plain functions over `AccountingState` (ARCHITECTURE.md section 8.2,
 * docs/design/accounting.md section 2).
 *
 * These functions do not depend on the engine: they mutate only the `AccountingState` they are given
 * and reach the outside world only through the `LedgerEnv` callbacks (tick, ID issuing, event
 * emission). `accountingSystem` and the `AccountingApi` service are thin adapters over them.
 *
 * Balances are debit-normal signed for every account type: `balance += debit - credit`. Hence
 * Σ balance over an entity is 0 after every successful posting.
 */
import {
  InvariantError,
  ZERO_MONEY,
  err,
  money,
  ok,
  type AccountCode,
  type AccountingState,
  type CompanyId,
  type EntityLedger,
  type EventInput,
  type JournalEntry,
  type JournalEntryId,
  type JournalEntryInput,
  type LedgerAccount,
  type Money,
  type Result,
} from '../schema/index.js';
import { STANDARD_CHART } from './chart.js';

/** Posting error codes, in validation order. */
export type PostingErrorCode =
  'unknown_entity' | 'empty' | 'invalid_line' | 'unknown_account' | 'unbalanced' | 'overflow';

/** Expected posting failure. `post` returns it; it never throws for these. */
export interface PostingError {
  code: PostingErrorCode;
  message: string;
}

/** What a posting needs from its surroundings (engine context, service handle, or a test stub). */
export interface LedgerEnv {
  /** Tick stamped on the entry. */
  readonly tick: number;
  /** Issues the next journal entry ID. Called once per successful posting, never on failure. */
  issueEntryId(): JournalEntryId;
  /** Receives `ledger.posted` / `period.closed` events. */
  emit(event: EventInput): void;
}

/** An empty accounting slice. */
export function createAccountingState(): AccountingState {
  return { entities: {}, journal: [] };
}

function zeroBalances(): Record<AccountCode, Money> {
  const out = {} as Record<AccountCode, Money>;
  for (const row of STANDARD_CHART) out[row.code] = ZERO_MONEY;
  return out;
}

/**
 * Opens a ledger for `entityId` with the standard chart, all balances 0, opening snapshots 0, no
 * reports. Throws `InvariantError('accounting.entity_exists')` if it is already open.
 */
export function openEntity(
  state: AccountingState,
  entityId: CompanyId,
  parentId: CompanyId | null = null,
): EntityLedger {
  if (Object.hasOwn(state.entities, entityId)) {
    throw new InvariantError(
      'accounting.entity_exists',
      `entity ${entityId} already has a ledger`,
      {
        entityId,
      },
    );
  }
  const accounts = {} as Record<AccountCode, LedgerAccount>;
  for (const row of STANDARD_CHART) {
    accounts[row.code] = { code: row.code, name: row.name, type: row.type, balance: ZERO_MONEY };
  }
  const ledger: EntityLedger = {
    entityId,
    parentId,
    accounts,
    monthOpening: zeroBalances(),
    yearOpening: zeroBalances(),
    reports: [],
  };
  state.entities[entityId] = ledger;
  return ledger;
}

export function hasEntity(state: AccountingState, entityId: CompanyId): boolean {
  return Object.hasOwn(state.entities, entityId);
}

/** The entity's ledger. Throws `InvariantError('accounting.unknown_entity')` if it is not open. */
export function getLedger(state: AccountingState, entityId: CompanyId): EntityLedger {
  const ledger = Object.hasOwn(state.entities, entityId) ? state.entities[entityId] : undefined;
  if (ledger === undefined) {
    throw new InvariantError('accounting.unknown_entity', `no ledger for ${entityId}`, {
      entityId,
    });
  }
  return ledger;
}

/**
 * Debit-normal signed balance. Throws `InvariantError('accounting.unknown_entity' |
 * 'accounting.unknown_account')` when the entity or account does not exist (asking for a balance
 * that cannot exist is a bug, not an expected outcome).
 */
export function getBalance(
  state: AccountingState,
  entityId: CompanyId,
  account: AccountCode,
): Money {
  return accountOf(getLedger(state, entityId), account).balance;
}

/**
 * The account `code` of `ledger`. Throws `InvariantError('accounting.unknown_account')` if the chart
 * has no such account.
 */
export function accountOf(ledger: EntityLedger, code: AccountCode): LedgerAccount {
  const acc = Object.hasOwn(ledger.accounts, code) ? ledger.accounts[code] : undefined;
  if (acc === undefined) {
    throw new InvariantError(
      'accounting.unknown_account',
      `${ledger.entityId} has no account ${code}`,
      {
        entityId: ledger.entityId,
        account: code,
      },
    );
  }
  return acc;
}

function isPositiveSafeInt(n: unknown): boolean {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

function isZero(n: unknown): boolean {
  return n === 0;
}

function fail(code: PostingErrorCode, message: string): Result<never, PostingError> {
  return err({ code, message });
}

/**
 * Validates `entry` against `entityId`'s ledger without changing anything. On success returns the
 * net delta per touched account (ascending code). Checks, in order (first failure wins):
 *
 * 1. `unknown_entity`: no ledger for `entityId`.
 * 2. `empty`: fewer than 2 lines.
 * 3. `invalid_line`: a line whose debit/credit is not exactly one positive safe integer with the
 *    other side exactly 0 (covers negative, fractional, NaN, both non-zero, both zero).
 * 4. `unknown_account`: a line account not in the entity's chart.
 * 5. `unbalanced`: Σ debit !== Σ credit. (If either sum leaves the safe-integer range the totals
 *    cannot be compared exactly and the result is `overflow` instead.)
 * 6. `overflow`: some resulting balance would not be a safe integer.
 */
export function validateEntry(
  state: AccountingState,
  entityId: CompanyId,
  entry: JournalEntryInput,
): Result<Map<AccountCode, number>, PostingError> {
  const ledger = Object.hasOwn(state.entities, entityId) ? state.entities[entityId] : undefined;
  if (ledger === undefined) return fail('unknown_entity', `no ledger for entity ${entityId}`);

  const lines = entry.lines;
  if (lines.length < 2) {
    return fail('empty', `an entry needs at least 2 lines, got ${lines.length}`);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) return fail('invalid_line', `line ${i} is missing`);
    const { debit, credit } = line;
    const valid =
      (isPositiveSafeInt(debit) && isZero(credit)) || (isZero(debit) && isPositiveSafeInt(credit));
    if (!valid) {
      return fail(
        'invalid_line',
        `line ${i} (${line.account}) must have exactly one positive safe-integer side; ` +
          `got debit ${String(debit)}, credit ${String(credit)}`,
      );
    }
  }

  for (const [i, line] of lines.entries()) {
    if (!Object.hasOwn(ledger.accounts, line.account)) {
      return fail(
        'unknown_account',
        `line ${i}: ${entityId} has no account ${String(line.account)}`,
      );
    }
  }

  let totalDebit = 0;
  let totalCredit = 0;
  // Transient local; iteration order of the map does not affect the result.
  const deltas = new Map<AccountCode, number>();
  for (const line of lines) {
    totalDebit += line.debit;
    totalCredit += line.credit;
    deltas.set(line.account, (deltas.get(line.account) ?? 0) + line.debit - line.credit);
  }
  if (!Number.isSafeInteger(totalDebit) || !Number.isSafeInteger(totalCredit)) {
    return fail('overflow', `entry totals exceed the safe-integer range`);
  }
  if (totalDebit !== totalCredit) {
    return fail(
      'unbalanced',
      `debits ${totalDebit} !== credits ${totalCredit} (difference ${totalDebit - totalCredit})`,
    );
  }

  for (const [account, delta] of deltas) {
    const current = accountOf(ledger, account).balance;
    const next = current + delta;
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(next)) {
      return fail('overflow', `balance of ${account} would leave the safe-integer range`);
    }
  }
  return ok(deltas);
}

function copyEntry(
  entityId: CompanyId,
  id: JournalEntryId,
  tick: number,
  input: JournalEntryInput,
): JournalEntry {
  const entry: JournalEntry = {
    id,
    entityId,
    tick,
    memo: input.memo,
    source: input.source,
    lines: input.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit })),
  };
  if (input.ref !== undefined) entry.ref = { kind: input.ref.kind, id: input.ref.id };
  return entry;
}

/**
 * Validates and posts `input` to `entityId` atomically: on `err` nothing changed (no ID issued, no
 * event). On success the entry gets `id = env.issueEntryId()` and `tick = env.tick`, is appended to
 * `state.journal` (lines are copied), balances are updated and `ledger.posted` is emitted.
 *
 * A caller receiving `err` must not swallow it: reject the originating command, or throw.
 */
export function postEntry(
  state: AccountingState,
  entityId: CompanyId,
  input: JournalEntryInput,
  env: LedgerEnv,
): Result<JournalEntry, PostingError> {
  const checked = validateEntry(state, entityId, input);
  if (!checked.ok) return checked;
  const ledger = getLedger(state, entityId);

  const entry = copyEntry(entityId, env.issueEntryId(), env.tick, input);
  for (const [account, delta] of checked.value) {
    const acc = accountOf(ledger, account);
    acc.balance = money(acc.balance + delta);
  }
  state.journal.push(entry);
  env.emit({
    type: 'ledger.posted',
    payload: { entryId: entry.id, entityId, memo: entry.memo },
  });
  return ok(entry);
}

/** `postEntry`, but a failure throws `InvariantError('accounting.post_failed')` (a caller bug). */
export function postEntryOrThrow(
  state: AccountingState,
  entityId: CompanyId,
  input: JournalEntryInput,
  env: LedgerEnv,
): JournalEntry {
  const result = postEntry(state, entityId, input, env);
  if (!result.ok) {
    throw new InvariantError(
      'accounting.post_failed',
      `${result.error.code}: ${result.error.message}`,
      {
        entityId,
        postingCode: result.error.code,
        memo: input.memo,
        source: input.source,
      },
    );
  }
  return result.value;
}

/** Current balances of every account of the ledger, keyed by code. */
export function snapshotBalances(ledger: EntityLedger): Record<AccountCode, Money> {
  const out = {} as Record<AccountCode, Money>;
  for (const code of Object.keys(ledger.accounts).sort() as AccountCode[]) {
    out[code] = accountOf(ledger, code).balance;
  }
  return out;
}
