/**
 * Test-only helpers for the manufacturing tests (not exported from the barrel). The pure harness
 * runs `runFacilityDay` / `applyCommand` over the REAL accounting ledger functions with a stubbed
 * economy, so these tests need neither the engine nor the economy system.
 */
import {
  ACCOUNTS,
  createAccountingState,
  getBalance,
  openEntity,
  openingCapital,
  postEntryOrThrow,
} from '../accounting/index.js';
import {
  M1_CONTENT_PACK,
  companyId,
  facilityId,
  facilityTypeId,
  journalEntryId,
  money,
  productId,
  quantity,
  recipeId,
  cityId,
  type AccountCode,
  type AccountingState,
  type Command,
  type CommandInput,
  type CompanyId,
  type ContentPack,
  type EventInput,
  type Facility,
  type FacilityId,
  type FacilityType,
  type ManufacturingState,
  type Money,
  type ProductId,
  type Quantity,
} from '../schema/index.js';
import type { CommandEnv } from './commands.js';
import { newFacility } from './facility.js';
import { runFacilityDay, type ProductionEnv, type RawPrice } from './production.js';

export const PLAYER: CompanyId = companyId('co_000001');
export const OTHER: CompanyId = companyId('co_000002');
export const BAKERY = facilityTypeId('bakery');
export const BAKE_BREAD = recipeId('bake_bread');
export const GRAIN: ProductId = productId('grain');
export const BREAD: ProductId = productId('bread');
export const SPRINGFIELD = cityId('springfield');
export const FAC: FacilityId = facilityId('fa_000001');

/** `M1_CONTENT_PACK` with the bakery type overridden (a fresh object; the fixture is frozen). */
export function contentWith(typeOverride: Partial<FacilityType> = {}): ContentPack {
  const base = M1_CONTENT_PACK.facilityTypes[BAKERY];
  if (base === undefined) throw new Error('fixture lacks bakery');
  return {
    ...M1_CONTENT_PACK,
    facilityTypes: { [BAKERY]: { ...base, ...typeOverride } },
  };
}

export interface Harness {
  acct: AccountingState;
  content: ContentPack;
  events: EventInput[];
  rejections: { command: Command; code: string; reason: string }[];
  /** Grain price per unit; tests change it to starve or feed the facility. */
  price: Money;
  /** Units of each raw product bought through `buyRaw`. */
  bought: { productId: ProductId; quantity: number; total: Money }[];
  tick: number;
  isMonthEnd: boolean;
  nextId: number;
  prodEnv(): ProductionEnv;
  cmdEnv(): CommandEnv;
  cash(owner?: CompanyId): Money;
  balance(code: AccountCode, owner?: CompanyId): Money;
}

export function makeHarness(
  opts: { cash?: number; content?: ContentPack; price?: number } = {},
): Harness {
  const acct = createAccountingState();
  let entryCount = 0;
  const clock = { tick: 0 };
  const ledgerEnv = {
    get tick() {
      return clock.tick;
    },
    issueEntryId() {
      entryCount += 1;
      return journalEntryId(`je_${String(entryCount).padStart(6, '0')}`);
    },
    emit() {
      /* ledger events are not asserted here */
    },
  };
  for (const owner of [PLAYER, OTHER]) openEntity(acct, owner, null);
  const startCash = money(opts.cash ?? 100_000_000);
  if (startCash > 0)
    postEntryOrThrow(acct, PLAYER, openingCapital(startCash, 'accounting'), ledgerEnv);

  const h: Harness = {
    acct,
    content: opts.content ?? M1_CONTENT_PACK,
    events: [],
    rejections: [],
    price: money(opts.price ?? 30),
    bought: [],
    get tick() {
      return clock.tick;
    },
    set tick(t: number) {
      clock.tick = t;
    },
    isMonthEnd: false,
    nextId: 0,
    cash: (owner = PLAYER) => getBalance(acct, owner, ACCOUNTS.CASH),
    balance: (code, owner = PLAYER) => getBalance(acct, owner, code),
    prodEnv() {
      const price = (qty: Quantity): RawPrice => ({
        unitPrice: h.price,
        total: money(h.price * qty),
      });
      return {
        tick: h.tick,
        isMonthEnd: h.isMonthEnd,
        content: h.content,
        cash: (owner) => getBalance(acct, owner, ACCOUNTS.CASH),
        quoteRaw: (_p, qty) => price(qty),
        buyRaw: (_owner, p, qty) => {
          const q = price(qty);
          h.bought.push({ productId: p, quantity: qty, total: q.total });
          return q;
        },
        post: (owner, entry) => {
          postEntryOrThrow(acct, owner, entry, ledgerEnv);
        },
        emit: (e) => h.events.push(e),
      };
    },
    cmdEnv() {
      const prod = h.prodEnv();
      return {
        tick: h.tick,
        content: prod.content,
        cash: (owner) => prod.cash(owner),
        post: (owner, entry) => {
          prod.post(owner, entry);
        },
        issueFacilityId: () => {
          h.nextId += 1;
          return facilityId(`fa_${String(h.nextId).padStart(6, '0')}`);
        },
        emit: (e) => {
          prod.emit(e);
        },
        reject: (command, code, reason) => {
          h.rejections.push({ command, code, reason });
        },
      };
    },
  };
  return h;
}

/** A command as the handlers see it (stamped). */
let seq = 0;
export function cmd(input: CommandInput, tick = 0): Command {
  seq += 1;
  return { ...input, seq, tick };
}

/** An operating bakery owned by PLAYER with the bake_bread recipe set and `target` batches. */
export function operatingBakery(
  h: Harness,
  target: number,
  overrides: Partial<Facility> = {},
): Facility {
  const type = h.content.facilityTypes[BAKERY];
  if (type === undefined) throw new Error('no bakery');
  const f = newFacility({ id: FAC, ownerId: PLAYER, type, cityId: SPRINGFIELD, orderedTick: 0 });
  f.status = 'operating';
  f.recipeId = BAKE_BREAD;
  f.targetBatches = quantity(target);
  return Object.assign(f, overrides);
}

/** Runs `days` facility-days, advancing `h.tick` (month end every 30th tick, ADR-005). */
export function runDays(
  h: Harness,
  facility: Facility,
  days: number,
  each?: (tick: number) => void,
): void {
  for (let i = 0; i < days; i++) {
    h.isMonthEnd = h.tick % 30 === 29;
    runFacilityDay(facility, h.prodEnv());
    each?.(h.tick);
    h.tick += 1;
  }
}

export function stateOf(...facilities: Facility[]): ManufacturingState {
  const state: ManufacturingState = { facilities: {} };
  for (const f of facilities) state.facilities[f.id] = f;
  return state;
}
