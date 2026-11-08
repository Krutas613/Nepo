/**
 * Pure read helpers over sim state and the store's `GameView`. Nothing here mutates state or
 * imports sim internals; they use the public barrels only. Selector hooks (`hooks.ts`) wrap them.
 */
import { ACCOUNTS, STANDARD_CHART, getBalance } from '@nepo/sim/accounting';
import type { Company, CompanyId, WorldState } from '@nepo/sim/schema';
import type { Money } from '@nepo/sim/schema';

/** The player's company: first `controller === 'player'` by sorted id (player-flow.md section 3). */
export function playerCompany(state: WorldState): Company | null {
  for (const id of Object.keys(state.companies).sort()) {
    const company = state.companies[id as CompanyId];
    if (company?.controller === 'player') return company;
  }
  return null;
}

export function playerCompanyId(state: WorldState): CompanyId | null {
  return playerCompany(state)?.id ?? null;
}

/** Cash balance (`1000`) of `companyId`, or `null` if it has no ledger. */
export function cashOf(state: WorldState, companyId: CompanyId): Money | null {
  if (!Object.hasOwn(state.accounting.entities, companyId)) return null;
  return getBalance(state.accounting, companyId, ACCOUNTS.CASH);
}

const accountNames = new Map<string, string>(STANDARD_CHART.map((a) => [a.code, a.name]));

/** Chart name for an account code (`a1000` -> `Cash`); the code itself if unknown. */
export function accountName(code: string): string {
  return accountNames.get(code) ?? code;
}

/** `a1000` -> `1000` (design docs and the UI show the bare number). */
export function displayCode(code: string): string {
  return code.startsWith('a') ? code.slice(1) : code;
}

export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  const ka = Object.keys(a) as (keyof T)[];
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && Object.is(a[k], b[k]));
}

export function arrayShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}
