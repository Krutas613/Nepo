/**
 * State hash (ARCHITECTURE.md section 10, ADR-008). Frozen after Milestone 0.
 *
 * Two FNV-1a 32 lanes over the UTF-16 code units of a string (each unit fed as low byte, then
 * high byte). Lane A offset basis `0x811c9dc5`, lane B `0xcbf29ce4`, prime `0x01000193` via
 * `Math.imul`. Output: 16 lowercase hex characters `A || B`. A regression fingerprint, not a
 * security hash.
 */
import type { WorldState } from '../schema/index.js';
import { canonicalJson } from './canonical.js';

const FNV_PRIME = 0x01000193;

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** Dual-lane FNV-1a 32 fingerprint of an arbitrary string. */
export function hashString(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const lo = c & 0xff;
    const hi = c >>> 8;
    a = Math.imul(a ^ lo, FNV_PRIME);
    b = Math.imul(b ^ lo, FNV_PRIME);
    a = Math.imul(a ^ hi, FNV_PRIME);
    b = Math.imul(b ^ hi, FNV_PRIME);
  }
  return hex8(a) + hex8(b);
}

/** `hashString(canonicalJson(value))` for any canonicalisable value (e.g. a single slice). */
export function hashValue(value: unknown): string {
  return hashString(canonicalJson(value));
}

/** Fingerprint of the whole world state. O(state size): tests and debug checks only. */
export function hashState(state: WorldState): string {
  return hashValue(state);
}
