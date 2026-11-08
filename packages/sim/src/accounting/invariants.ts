/**
 * Ledger invariant checker for tests and sim-tests (ARCHITECTURE.md section 13, design doc section 6).
 * Read-only; O(accounts + journal lines + reports).
 */
import type { AccountCode, AccountingState, CompanyId, JournalEntryId } from '../schema/index.js';

export type LedgerInvariantCode =
  | 'entity.unbalanced'
  | 'entry.unbalanced'
  | 'entry.invalid_line'
  | 'entry.unknown_account'
  | 'balance.unsafe'
  | 'report.cashflow_mismatch'
  | 'report.identity_mismatch';

export interface LedgerInvariantViolation {
  code: LedgerInvariantCode;
  entityId?: CompanyId;
  entryId?: JournalEntryId;
  message: string;
}

function isNonNegSafeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Returns `[]` when the slice is consistent, otherwise every violation found:
 *
 * - `balance.unsafe`: an account balance is not a safe integer (or is `-0`).
 * - `entity.unbalanced`: Σ balance over an entity !== 0 (equivalently A !== L + E).
 * - `entry.invalid_line`: a journal line without exactly one positive safe-integer side.
 * - `entry.unbalanced`: a journal entry with Σ debit !== Σ credit.
 * - `entry.unknown_account`: a journal entry for an entity without a ledger, or naming an account
 *   that entity's chart does not have.
 * - `report.cashflow_mismatch`: `netChange !== closingCash - openingCash` or
 *   `netChange !== operating + investing + financing`.
 * - `report.identity_mismatch`: `assets !== liabilities + equity` in a report's balance sheet.
 */
export function checkLedgerInvariants(state: AccountingState): LedgerInvariantViolation[] {
  const out: LedgerInvariantViolation[] = [];

  for (const entityId of Object.keys(state.entities).sort() as CompanyId[]) {
    const ledger = state.entities[entityId];
    if (ledger === undefined) continue;
    let sum = 0;
    let safe = true;
    for (const code of Object.keys(ledger.accounts).sort() as AccountCode[]) {
      const account = ledger.accounts[code];
      if (account === undefined) continue;
      const balance = account.balance;
      if (!Number.isSafeInteger(balance) || Object.is(balance, -0)) {
        safe = false;
        out.push({
          code: 'balance.unsafe',
          entityId,
          message: `${entityId} ${code} balance ${String(balance)} is not a safe integer`,
        });
        continue;
      }
      sum += balance;
    }
    if (safe && sum !== 0) {
      out.push({
        code: 'entity.unbalanced',
        entityId,
        message: `${entityId}: Σ balance === ${sum}, expected 0`,
      });
    }

    ledger.reports.forEach((r, i) => {
      const cf = r.cashFlow;
      const where = `${entityId} report #${i} (${r.kind} ${r.year}-${r.month})`;
      if (
        cf.netChange !== cf.closingCash - cf.openingCash ||
        cf.netChange !== cf.operating + cf.investing + cf.financing
      ) {
        out.push({
          code: 'report.cashflow_mismatch',
          entityId,
          message:
            `${where}: netChange ${cf.netChange}, closing - opening ${cf.closingCash - cf.openingCash}, ` +
            `sections ${cf.operating + cf.investing + cf.financing}`,
        });
      }
      const bs = r.balance;
      if (bs.assets !== bs.liabilities + bs.equity) {
        out.push({
          code: 'report.identity_mismatch',
          entityId,
          message: `${where}: assets ${bs.assets} !== liabilities ${bs.liabilities} + equity ${bs.equity}`,
        });
      }
    });
  }

  for (const entry of state.journal) {
    const ledger = Object.hasOwn(state.entities, entry.entityId)
      ? state.entities[entry.entityId]
      : undefined;
    const base = { entityId: entry.entityId, entryId: entry.id };
    if (ledger === undefined) {
      out.push({
        ...base,
        code: 'entry.unknown_account',
        message: `${entry.id}: entity ${entry.entityId} has no ledger`,
      });
      continue;
    }
    let debit = 0;
    let credit = 0;
    for (const line of entry.lines) {
      const oneSided =
        isNonNegSafeInt(line.debit) &&
        isNonNegSafeInt(line.credit) &&
        (line.debit === 0) !== (line.credit === 0);
      if (!oneSided) {
        out.push({
          ...base,
          code: 'entry.invalid_line',
          message: `${entry.id}: line ${line.account} debit ${String(line.debit)} credit ${String(line.credit)}`,
        });
      }
      if (!Object.hasOwn(ledger.accounts, line.account)) {
        out.push({
          ...base,
          code: 'entry.unknown_account',
          message: `${entry.id}: unknown account ${line.account}`,
        });
      }
      debit += line.debit;
      credit += line.credit;
    }
    if (debit !== credit) {
      out.push({
        ...base,
        code: 'entry.unbalanced',
        message: `${entry.id}: debits ${debit} !== credits ${credit}`,
      });
    }
  }
  return out;
}
