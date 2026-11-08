/**
 * Test-only helpers that build a real world (engine + accounting + economy + manufacturing + retail)
 * for the integration tests. Not exported from the module barrel.
 */
import {
  accountingSystem,
  ACCOUNTS,
  makeJournalEntry,
  dr,
  cr,
  getBalance,
  postEntryOrThrow,
} from '../accounting/index.js';
import { economySystem } from '../economy/index.js';
import { createWorld, issueId, step, submit, type AnySystem, type World } from '../engine/index.js';
import { manufacturingSystem } from '../manufacturing/index.js';
import {
  VERTICAL_SLICE_SCENARIO,
  money,
  quantity,
  type AccountCode,
  type CommandInput,
  type CompanyId,
  type Event,
  type Money,
  type ProductId,
  type Scenario,
  type StoreId,
} from '../schema/index.js';
import { retailSystem } from './system.js';
import { BREAD, OWNER, makeStore, STORE_1 } from './test-helpers.js';

export const SYSTEMS: readonly AnySystem[] = [
  accountingSystem,
  economySystem,
  manufacturingSystem,
  retailSystem,
];

/** `VERTICAL_SLICE_SCENARIO` with a second company `co_000002` and optional cash overrides. */
export function scenarioOf(opts: { cash?: number; rival?: boolean } = {}): Scenario {
  const base = VERTICAL_SLICE_SCENARIO.companies[0];
  if (base === undefined) throw new Error('fixture has no company');
  const player = { ...base, startingCash: money(opts.cash ?? base.startingCash) };
  const companies =
    opts.rival === true
      ? [player, { ...player, name: 'Rival Co', controller: 'ai' as const }]
      : [player];
  return { ...VERTICAL_SLICE_SCENARIO, companies } as Scenario;
}

export function newWorld(scenario: Scenario = scenarioOf(), seed = 1): World {
  return createWorld({ seed, scenario, systems: SYSTEMS });
}

/** Submits a command, failing the test on a schema error. */
export function send(world: World, input: CommandInput): void {
  const r = submit(world, input);
  if (!r.ok) throw new Error(`submit failed: ${JSON.stringify(r.error)}`);
}

/** Steps `n` ticks and returns every event emitted. */
export function run(
  world: World,
  n: number,
  opts: { checkSliceOwnership?: boolean } = {},
): Event[] {
  const events: Event[] = [];
  for (let i = 0; i < n; i += 1) {
    events.push(...step(world, { checkSliceOwnership: true, checkFinite: true, ...opts }).events);
  }
  return events;
}

/** Posts an entry straight into the world's ledger (test seeding between steps). */
export function post(
  world: World,
  owner: CompanyId,
  lines: ReturnType<typeof makeJournalEntry>,
): void {
  postEntryOrThrow(world.state.accounting, owner, lines, {
    tick: world.state.tick,
    issueEntryId: () => issueId(world.state.registry, 'journalEntry'),
    emit: () => undefined,
  });
}

export function balance(world: World, account: AccountCode, owner: CompanyId = OWNER): Money {
  return getBalance(world.state.accounting, owner, account);
}

/**
 * Installs an operating grocery store holding `stock` bread worth `value` (booked Dr 1230 / Cr 1000),
 * with the given price, directly in the retail slice. Returns the store id.
 */
export function seedStore(
  world: World,
  opts: {
    stock: number;
    value?: number;
    price?: number | null;
    id?: StoreId;
    product?: ProductId;
  } = { stock: 0 },
): StoreId {
  const id = opts.id ?? STORE_1;
  const product = opts.product ?? BREAD;
  const value = opts.value ?? opts.stock * 100;
  const store = makeStore(opts.stock, value, { id });
  const line = store.shelves[BREAD];
  if (line === undefined) throw new Error('makeStore has no bread line');
  line.price = opts.price === undefined || opts.price === null ? null : money(opts.price);
  delete store.shelves[BREAD];
  store.shelves[product] = line;
  world.state.retail.stores[id] = store;
  if (value > 0) {
    post(
      world,
      OWNER,
      makeJournalEntry(
        [dr(ACCOUNTS.INVENTORY_MERCHANDISE, money(value)), cr(ACCOUNTS.CASH, money(value))],
        'retail',
        'Seed shelf stock',
      ),
    );
  }
  return id;
}

export { quantity };
