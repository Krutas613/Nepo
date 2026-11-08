/**
 * Test-only helpers for the finance tests. Not exported from the barrel.
 *
 * - `makeLedgerEnv`: a `FinanceEnv` over a real (pure) accounting ledger, engine-free, for unit tests
 *   of the transitions in `loans.ts`.
 * - `cashScriptSystem`: a stand-in domain system (id `retail`, with the schema's empty retail slice so
 *   the world validates and snapshots) that posts a scripted daily cash flow through the real
 *   `AccountingApi` in `market`: positive = revenue (`cashSale`), negative = operating cost
 *   (`cashPurchase` into 6900, non-discretionary under ADR-014). The script is a pure function of
 *   `(tick, companyId)`, so restored worlds behave identically.
 */
import {
  ACCOUNTING_SERVICE,
  ACCOUNTS,
  balanceSheet,
  cashPurchase,
  cashSale,
  createAccountingState,
  getBalance,
  getLedger,
  hasEntity,
  openEntity,
  openingCapital,
  postEntryOrThrow,
  type LedgerEnv,
} from '../accounting/index.js';
import { canonicalJson, sortedKeys, type System } from '../engine/index.js';
import {
  EMPTY_RETAIL_STATE,
  M1_CONTENT_PACK,
  ZERO_MONEY,
  companyId,
  journalEntryId,
  loanId,
  money,
  negMoney,
  type AccountingState,
  type Bank,
  type CompanyId,
  type EventInput,
  type Money,
  type RetailState,
} from '../schema/index.js';
import type { FinanceEnv } from './loans.js';

export const PLAYER: CompanyId = companyId('co_000001');
export const RIVAL: CompanyId = companyId('co_000002');

/** The single M1 bank (`first_national`). */
export const BANK: Bank = (() => {
  const banks = M1_CONTENT_PACK.finance.banks;
  const [id] = sortedKeys(banks);
  const bank = id === undefined ? undefined : banks[id];
  if (bank === undefined) throw new Error('M1_CONTENT_PACK has no bank');
  return bank;
})();

/** `FinanceEnv` over a pure accounting ledger, recording events. `tick` is mutable. */
export interface LedgerTestEnv extends FinanceEnv {
  tick: number;
  readonly ledger: AccountingState;
  readonly events: EventInput[];
}

export function makeLedgerEnv(
  companies: readonly { id: CompanyId; cash: number }[],
  tick = 0,
): LedgerTestEnv {
  const ledger = createAccountingState();
  const events: EventInput[] = [];
  let entries = 0;
  let loans = 0;
  const env: LedgerTestEnv = {
    tick,
    ledger,
    events,
    accounting: {
      postOrThrow: (entityId, entry) => postEntryOrThrow(ledger, entityId, entry, ledgerEnv()),
      cash: (entityId) => getBalance(ledger, entityId, ACCOUNTS.CASH),
      balanceSheet: (entityId) => balanceSheet(getLedger(ledger, entityId)),
      hasEntity: (entityId) => hasEntity(ledger, entityId),
    },
    emit: (event) => {
      events.push(event);
    },
    issueLoanId: () => {
      loans += 1;
      return loanId(`ln_${String(loans).padStart(6, '0')}`);
    },
  };
  function ledgerEnv(): LedgerEnv {
    return {
      tick: env.tick,
      issueEntryId: () => {
        entries += 1;
        return journalEntryId(`je_${String(entries).padStart(6, '0')}`);
      },
      emit: () => undefined,
    };
  }
  for (const c of companies) {
    openEntity(ledger, c.id, null);
    if (c.cash > 0)
      postEntryOrThrow(ledger, c.id, openingCapital(money(c.cash), 'accounting'), ledgerEnv());
  }
  return env;
}

/** Posts a raw cash movement in a `LedgerTestEnv` (positive income, negative opex). */
export function moveCash(env: LedgerTestEnv, entityId: CompanyId, amount: number): void {
  if (amount === 0) return;
  const m = money(Math.abs(amount));
  env.accounting.postOrThrow(
    entityId,
    amount > 0 ? cashSale(m, ZERO_MONEY, 'retail') : cashPurchase(ACCOUNTS.OPEX_OTHER, m, 'retail'),
  );
}

export type CashScript = (tick: number, companyId: CompanyId) => number;

/** A `retail`-id system posting `script(tick, company)` for every company each `market` phase. */
export function cashScriptSystem(script: CashScript): System<RetailState> {
  return {
    id: 'retail',
    handles: [],
    init: () => JSON.parse(canonicalJson(EMPTY_RETAIL_STATE)) as RetailState,
    phases: {
      market(ctx) {
        const api = ctx.services.get(ACCOUNTING_SERVICE);
        for (const id of sortedKeys(ctx.state.companies)) {
          const amount = script(ctx.tick, id);
          if (amount === 0) continue;
          const m = money(Math.abs(amount));
          api.postOrThrow(
            id,
            amount > 0
              ? cashSale(m, ZERO_MONEY, 'retail', { memo: 'Scripted revenue' })
              : cashPurchase(ACCOUNTS.OPEX_OTHER, m, 'retail', { memo: 'Scripted opex' }),
          );
        }
      },
    },
  };
}

/** `-balance(account)`: a liability's positive amount. */
export function liabilityOf(
  ledger: AccountingState,
  entityId: CompanyId,
  code: typeof ACCOUNTS.LOANS,
): Money {
  return negMoney(getBalance(ledger, entityId, code));
}
