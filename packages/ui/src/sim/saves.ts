/**
 * Save slots in `localStorage` (`nepo/save/<slot>`, player-flow.md section 6). Storage is injected
 * so tests run in node. A save is `JSON.stringify(snapshot(world))`; metadata lives under a sibling
 * key so listing slots never parses a multi-megabyte snapshot.
 */
import { snapshot, type World } from '@nepo/sim/engine';
import { hashState } from '@nepo/sim/engine';
import { playerCompany } from './selectors.js';

export interface SaveStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

export const SAVE_PREFIX = 'nepo/save/';
export const META_PREFIX = 'nepo/save-meta/';
export const MAX_SLOT_NAME = 32;

export interface SaveMeta {
  slot: string;
  /** Wall-clock ms; UI bookkeeping only, never read by the sim. */
  savedAtMs: number;
  tick: number;
  seed: number;
  hash: string;
  company: string;
  bytes: number;
}

export function createMemoryStorage(): SaveStorage {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()].sort(),
  };
}

/** `localStorage` wrapped as a `SaveStorage`, or `null` if the browser blocks it. */
export function createLocalStorage(): SaveStorage | null {
  try {
    const ls = window.localStorage;
    ls.getItem('nepo/probe');
    return {
      get: (key) => ls.getItem(key),
      set: (key, value) => {
        ls.setItem(key, value);
      },
      remove: (key) => {
        ls.removeItem(key);
      },
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i);
          if (key !== null) out.push(key);
        }
        return out.sort();
      },
    };
  } catch {
    return null;
  }
}

/** Trimmed slot name, or `null` if empty or too long. */
export function normalizeSlotName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_SLOT_NAME ? trimmed : null;
}

/** Plain-JSON snapshot text of a world. Throws `SnapshotError('poisoned')` for a poisoned world. */
export function serializeWorld(world: World): string {
  return JSON.stringify(snapshot(world));
}

export function writeSave(
  storage: SaveStorage,
  slot: string,
  world: World,
  nowMs: number,
): SaveMeta {
  const text = serializeWorld(world);
  const meta: SaveMeta = {
    slot,
    savedAtMs: nowMs,
    tick: world.state.tick,
    seed: world.state.seed,
    hash: hashState(world.state),
    company: playerCompany(world.state)?.name ?? '',
    bytes: text.length,
  };
  storage.set(SAVE_PREFIX + slot, text);
  storage.set(META_PREFIX + slot, JSON.stringify(meta));
  return meta;
}

export function readSave(storage: SaveStorage, slot: string): string | null {
  return storage.get(SAVE_PREFIX + slot);
}

export function deleteSave(storage: SaveStorage, slot: string): void {
  storage.remove(SAVE_PREFIX + slot);
  storage.remove(META_PREFIX + slot);
}

function parseMeta(slot: string, text: string | null): SaveMeta | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Partial<SaveMeta>;
    if (typeof raw.tick !== 'number' || typeof raw.savedAtMs !== 'number') return null;
    return {
      slot,
      savedAtMs: raw.savedAtMs,
      tick: raw.tick,
      seed: raw.seed ?? 0,
      hash: raw.hash ?? '',
      company: raw.company ?? '',
      bytes: raw.bytes ?? 0,
    };
  } catch {
    return null;
  }
}

/** Slots, newest first. A slot whose metadata is missing or corrupt is listed with blanks. */
export function listSaves(storage: SaveStorage): SaveMeta[] {
  const out: SaveMeta[] = [];
  for (const key of storage.keys()) {
    if (!key.startsWith(SAVE_PREFIX)) continue;
    const slot = key.slice(SAVE_PREFIX.length);
    out.push(
      parseMeta(slot, storage.get(META_PREFIX + slot)) ?? {
        slot,
        savedAtMs: 0,
        tick: 0,
        seed: 0,
        hash: '',
        company: '',
        bytes: 0,
      },
    );
  }
  return out.sort((a, b) => b.savedAtMs - a.savedAtMs || a.slot.localeCompare(b.slot));
}
