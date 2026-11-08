/**
 * `AccountingApi`: the narrow posting API other systems call (ARCHITECTURE.md section 8.2, ADR-007).
 * Registered under `ACCOUNTING_SERVICE`; obtain it with `ctx.services.get(ACCOUNTING_SERVICE)`.
 *
 * Every method is a thin adapter over the pure ledger functions in `ledger.ts`, operating on the
 * accounting slice through the engine's `ServiceHandle`. The service keeps no state of its own.
 *
 * Implementation rule (ARCHITECTURE.md section 6.2, docs/design/accounting.md section 7):
 * `handle.slice()` is a mutation declaration. It marks the accounting slice as legitimately written
 * for the caller's phase, which turns off the engine's foreign-write check for that slice. So only the
 * mutating methods (`openEntity`, `post`, `postOrThrow`) call `handle.slice()`; every read-only method
 * (`balance`, `cash`, `hasEntity`, and any future query) reads `handle.state().accounting`.
 */
import { createServiceKey, type ServiceHandle, type ServiceKey } from '../engine/index.js';
import type {
  AccountCode,
  AccountingState,
  CompanyId,
  JournalEntry,
  JournalEntryInput,
  Money,
  Result,
} from '../schema/index.js';
import { ACCOUNTS } from './chart.js';
import {
  getBalance,
  hasEntity,
  openEntity,
  postEntry,
  postEntryOrThrow,
  type LedgerEnv,
  type PostingError,
  type ReadonlyAccountingState,
} from './ledger.js';

export interface AccountingApi {
  /**
   * Opens a ledger for `entityId` with the standard chart (all balances 0).
   * Throws `InvariantError('accounting.entity_exists')` if it already has one.
   */
  openEntity(entityId: CompanyId, parentId?: CompanyId): void;
  /**
   * Validates and posts a balanced entry atomically. Expected failures come back as `err` with a
   * `PostingErrorCode` (`unknown_entity`, `empty`, `invalid_line`, `unknown_account`, `unbalanced`,
   * `overflow`) and change nothing. The caller must not swallow an `err`: reject the originating
   * command, or throw if constructing the entry was a bug.
   */
  post(entityId: CompanyId, entry: JournalEntryInput): Result<JournalEntry, PostingError>;
  /** `post`, throwing `InvariantError('accounting.post_failed')` on `err`. */
  postOrThrow(entityId: CompanyId, entry: JournalEntryInput): JournalEntry;
  /** Debit-normal signed balance. Throws `InvariantError` for an unknown entity or account. */
  balance(entityId: CompanyId, account: AccountCode): Money;
  /** `balance(entityId, ACCOUNTS.CASH)`. */
  cash(entityId: CompanyId): Money;
  hasEntity(entityId: CompanyId): boolean;
}

export const ACCOUNTING_SERVICE: ServiceKey<AccountingApi> =
  createServiceKey<AccountingApi>('accounting');

/** Builds a `LedgerEnv` from a service handle, reading the tick at call time. */
function envOf(handle: ServiceHandle<AccountingState>): LedgerEnv {
  return {
    tick: handle.tick(),
    issueEntryId: () => handle.issueId('journalEntry'),
    emit: (event) => {
      handle.emit(event);
    },
  };
}

export function createAccountingApi(handle: ServiceHandle<AccountingState>): AccountingApi {
  /** Read-only view for queries; never `handle.slice()` (that would declare a mutation). */
  const view = (): ReadonlyAccountingState => handle.state().accounting;
  return {
    openEntity(entityId, parentId) {
      openEntity(handle.slice(), entityId, parentId ?? null);
    },
    post(entityId, entry) {
      return postEntry(handle.slice(), entityId, entry, envOf(handle));
    },
    postOrThrow(entityId, entry) {
      return postEntryOrThrow(handle.slice(), entityId, entry, envOf(handle));
    },
    balance(entityId, account) {
      return getBalance(view(), entityId, account);
    },
    cash(entityId) {
      return getBalance(view(), entityId, ACCOUNTS.CASH);
    },
    hasEntity(entityId) {
      return hasEntity(view(), entityId);
    },
  };
}
