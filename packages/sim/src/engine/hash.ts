/**
 * State hash (ARCHITECTURE.md section 10, ADR-008). Frozen after Milestone 0.
 *
 * Two FNV-1a 32 lanes over the UTF-16 code units of a string (each unit fed as low byte, then
 * high byte). Lane A offset basis `0x811c9dc5`, lane B `0xcbf29ce4`, prime `0x01000193` via
 * `Math.imul`. Output: 16 lowercase hex characters `A || B`. A regression fingerprint, not a
 * security hash.
 *
 * `hashValue` / `hashState` are defined as `hashString(canonicalJson(value))` and evaluated by the
 * streaming hasher in `canonical-hash.ts`, which produces the identical value without building
 * the canonical string.
 */
import type { WorldState } from '../schema/index.js';
import { canonicalHash, canonicalHashReport, type HashReport } from './canonical-hash.js';

export type { HashReport } from './canonical-hash.js';

/** Options for `hashValue` / `hashState`. */
export interface HashOptions {
  /**
   * Also scan for `NaN`, `+-Infinity` and `-0` in the same walk and return a `HashReport`
   * instead of throwing `canon.unsupported` on `NaN`/`Infinity`.
   */
  collectNonFinite: true;
}

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

/**
 * `hashString(canonicalJson(value))` for any canonicalisable value (e.g. a single slice); throws
 * exactly what `canonicalJson` throws. With `{ collectNonFinite: true }`, returns a `HashReport`.
 */
export function hashValue(value: unknown): string;
export function hashValue(value: unknown, options: HashOptions): HashReport;
export function hashValue(value: unknown, options?: HashOptions): string | HashReport {
  return options?.collectNonFinite === true ? canonicalHashReport(value) : canonicalHash(value);
}

/**
 * Fingerprint of the whole world state. O(state size). With `{ collectNonFinite: true }`, also
 * returns the `findNonFinite` paths from the same walk (`hash` is `null` if `NaN`/`Infinity`).
 */
export function hashState(state: WorldState): string;
export function hashState(state: WorldState, options: HashOptions): HashReport;
export function hashState(state: WorldState, options?: HashOptions): string | HashReport {
  return options?.collectNonFinite === true ? canonicalHashReport(state) : canonicalHash(state);
}
