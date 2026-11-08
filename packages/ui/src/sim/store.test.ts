import { calendarFromTick, hashState, type World } from '@nepo/sim/engine';
import type { System } from '@nepo/sim/engine';
import { accountingSystem } from '@nepo/sim/accounting';
import { describe, expect, it } from 'vitest';
import type { FrameScheduler } from './clock.js';
import { createSelectorReader } from './hooks.js';
import {
  createMemoryStorage,
  deleteSave,
  listSaves,
  normalizeSlotName,
  readSave,
  writeSave,
} from './saves.js';
import { cashOf, playerCompany, playerCompanyId, shallowEqual } from './selectors.js';
import { GameStore, EVENT_BUFFER_CAP } from './store.js';
import { latestReport, liveReport } from './queries.js';

const noFrames: FrameScheduler = { request: () => 0, cancel: () => undefined };

function makeStore(seed = 7): GameStore {
  return new GameStore({ scheduler: noFrames, storage: createMemoryStorage(), seed });
}

function playerId(store: GameStore) {
  const id = playerCompanyId(store.getWorld().state);
  if (id === null) throw new Error('no player');
  return id;
}

describe('newGame + stepping', () => {
  it('30 steps produce a month report, then more reports over a year', () => {
    const store = makeStore();
    store.stepMany(30);
    const state = store.getWorld().state;
    const ledger = state.accounting.entities[playerId(store)];
    expect(state.tick).toBe(30);
    expect(ledger?.reports.filter((r) => r.kind === 'month')).toHaveLength(1);
    store.stepMany(330);
    const after = store.getWorld().state.accounting.entities[playerId(store)];
    expect(after?.reports.filter((r) => r.kind === 'month')).toHaveLength(12);
    expect(after?.reports.filter((r) => r.kind === 'quarter')).toHaveLength(4);
    expect(after?.reports.filter((r) => r.kind === 'year')).toHaveLength(1);
  });

  it('newGame resets tick, events and series; same seed gives the same hash', () => {
    const store = makeStore(3);
    store.stepMany(45);
    const hashA = store.stateHash();
    const firstGame = store.getView().gameId;
    store.newGame(3);
    expect(store.getView().gameId).toBe(firstGame + 1);
    expect(store.getView().tick).toBe(0);
    store.stepMany(45);
    expect(store.stateHash()).toBe(hashA);
    expect(store.getView().cashSeries.length).toBeGreaterThan(40);
  });

  it('notifies subscribers once per stepMany batch, not once per tick', () => {
    const store = makeStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.stepMany(90);
    expect(calls).toBe(1);
    store.stepOnce();
    expect(calls).toBe(2);
  });

  it('buffers events and caps the buffer', () => {
    const store = makeStore();
    expect(store.getView().events.some((e) => e.type === 'company.founded')).toBe(true);
    store.stepMany(60);
    expect(store.getView().events.some((e) => e.type === 'period.closed')).toBe(true);
    expect(store.getView().events.length).toBeLessThanOrEqual(EVENT_BUFFER_CAP);
  });

  it('live report matches the cash balance and balances', () => {
    const store = makeStore();
    store.stepMany(10);
    const state = store.getWorld().state;
    const id = playerId(store);
    const live = liveReport(state, id);
    expect(live?.balance.assets).toBe(
      (live?.balance.liabilities ?? 0) + (live?.balance.equity ?? 0),
    );
    expect(cashOf(state, id)).toBe(100_000_000);
    expect(latestReport(state.accounting.entities[id]?.reports ?? [], 'month')).toBeNull();
  });
});

describe('dispatch', () => {
  it('queues a command, applies it at the next tick and emits company.renamed', () => {
    const store = makeStore();
    const id = playerId(store);
    const result = store.dispatch({
      type: 'company.rename',
      issuer: id,
      payload: { name: 'Acme' },
    });
    expect(result).toMatchObject({ ok: true });
    expect(store.getWorld().state.pendingCommands).toHaveLength(1);
    expect(playerCompany(store.getWorld().state)?.name).toBe('Player Holdings');
    store.stepOnce();
    expect(playerCompany(store.getWorld().state)?.name).toBe('Acme');
    expect(store.getView().events.some((e) => e.type === 'company.renamed')).toBe(true);
  });

  it('returns shape errors synchronously and queues nothing', () => {
    const store = makeStore();
    const bad = store.dispatch({
      type: 'company.rename',
      issuer: 'nope' as never,
      payload: { name: 1 as never },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid_shape');
    expect(store.getWorld().state.pendingCommands).toHaveLength(0);
  });

  it('surfaces semantic rejections from command.rejected events', () => {
    const store = makeStore();
    const id = playerId(store);
    const result = store.dispatch({ type: 'company.rename', issuer: id, payload: { name: '   ' } });
    expect(result.ok).toBe(true);
    store.stepOnce();
    const rejection = store.getView().rejections.at(-1);
    expect(rejection?.commandType).toBe('company.rename');
    expect(rejection?.code).toBeTruthy();
    expect(result.ok && rejection?.commandSeq).toBe(result.ok ? result.seq : -1);
    expect(playerCompany(store.getWorld().state)?.name).toBe('Player Holdings');
  });
});

describe('selector narrowing', () => {
  it('returns the cached value within a version and keeps identity when equal', () => {
    const store = makeStore();
    let runs = 0;
    const selector = (v: ReturnType<GameStore['getView']>) => {
      runs += 1;
      return { id: playerCompanyId(v.world.state), cash: 1 };
    };
    const reader = createSelectorReader<{ id: string | null; cash: number }>(store.getView);
    const a = reader.read(selector, shallowEqual);
    const b = reader.read(selector, shallowEqual);
    expect(b).toBe(a);
    expect(runs).toBe(1);
    store.stepMany(5); // new version: selector reruns, but equal result keeps the old identity
    const c = reader.read(selector, shallowEqual);
    expect(runs).toBe(2);
    expect(c).toBe(a);
  });

  it('a primitive slice is stable while unrelated state changes', () => {
    const store = makeStore();
    const reader = createSelectorReader<number | null>(store.getView);
    const cashSel = (v: ReturnType<GameStore['getView']>) => {
      const id = playerCompanyId(v.world.state);
      return id === null ? null : cashOf(v.world.state, id);
    };
    const first = reader.read(cashSel, Object.is);
    store.stepMany(100);
    expect(reader.read(cashSel, Object.is)).toBe(first);
    const tickReader = createSelectorReader<number>(store.getView);
    expect(tickReader.read((v) => v.tick, Object.is)).toBe(100);
  });

  it('a different selector function recomputes within the same version', () => {
    const store = makeStore();
    const reader = createSelectorReader<number>(store.getView);
    expect(reader.read(() => 1, Object.is)).toBe(1);
    expect(reader.read(() => 2, Object.is)).toBe(2);
  });
});

describe('save / load', () => {
  it('round-trips through storage with an identical hash and keeps running', () => {
    const store = makeStore(11);
    store.stepMany(75);
    const hash = store.stateHash();
    const storage = store.storage;
    if (storage === null) throw new Error('storage');
    const meta = writeSave(storage, 'slot a', store.getWorld(), 1234);
    expect(meta.hash).toBe(hash);
    expect(listSaves(storage).map((m) => m.slot)).toEqual(['slot a']);

    store.stepMany(100);
    expect(store.stateHash()).not.toBe(hash);
    expect(store.loadSlot('slot a')).toEqual({ ok: true });
    expect(store.getView().tick).toBe(75);
    expect(store.stateHash()).toBe(hash);
    expect(hashState(store.getWorld().state)).toBe(hash);

    // Continues identically to an uninterrupted run.
    const straight = makeStore(11);
    straight.stepMany(120);
    store.stepMany(45);
    expect(store.stateHash()).toBe(straight.stateHash());
  });

  it('reports a friendly error for bad files and leaves the game untouched', () => {
    const store = makeStore();
    store.stepMany(3);
    const before = store.stateHash();
    expect(store.loadFromText('not json')).toMatchObject({ ok: false, code: 'invalid_json' });
    expect(store.loadFromText('{"hello":1}')).toMatchObject({ ok: false, code: 'invalid' });
    const tampered = JSON.parse(store.serialize() ?? '{}') as { state: { seed: number } };
    tampered.state.seed += 1;
    expect(store.loadFromText(JSON.stringify(tampered))).toMatchObject({ ok: false });
    expect(store.loadSlot('missing')).toMatchObject({ ok: false, code: 'missing' });
    expect(store.stateHash()).toBe(before);
  });

  it('manages slots', () => {
    const storage = createMemoryStorage();
    const world: World = makeStore().getWorld();
    writeSave(storage, 'one', world, 1);
    writeSave(storage, 'two', world, 2);
    expect(listSaves(storage).map((m) => m.slot)).toEqual(['two', 'one']);
    deleteSave(storage, 'two');
    expect(readSave(storage, 'two')).toBeNull();
    expect(listSaves(storage)).toHaveLength(1);
    expect(normalizeSlotName('  x ')).toBe('x');
    expect(normalizeSlotName('')).toBeNull();
    expect(normalizeSlotName('y'.repeat(33))).toBeNull();
  });
});

describe('poisoned world', () => {
  const bomb: System<{ n: number }> = {
    id: 'ai',
    handles: [],
    init: () => ({ n: 0 }),
    phases: {
      apply(ctx) {
        if (ctx.tick === 5) throw new Error('bomb');
      },
    },
  };

  it('pauses, records seed/tick/code, disables stepping and keeps a last-good snapshot', () => {
    const store = new GameStore({
      scheduler: noFrames,
      storage: null,
      seed: 9,
      systems: [accountingSystem, bomb],
    });
    store.stepMany(20);
    const view = store.getView();
    expect(view.poisoned).toMatchObject({ seed: 9 });
    expect(view.poisoned?.tick).toBe(5);
    expect(view.clock.running).toBe(false);
    expect(view.lastGood).not.toBeNull();
    expect(store.serialize()).toBeNull();
    const tick = view.tick;
    store.stepOnce();
    expect(store.getView().tick).toBe(tick);
    // The exported last-good snapshot is loadable by a healthy store.
    const healthy = new GameStore({
      scheduler: noFrames,
      storage: null,
      systems: [accountingSystem, bomb],
    });
    expect(healthy.loadFromText(view.lastGood ?? '')).toEqual({ ok: true });
  });
});

describe('calendar sanity', () => {
  it('tick 30 is day 1 of month 2', () => {
    expect(calendarFromTick(30, 2000)).toMatchObject({ month: 2, day: 1 });
  });
});
