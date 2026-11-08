/**
 * Streaming canonical hasher (ARCHITECTURE.md section 10, ADR-008).
 *
 * Computes exactly `hashString(canonicalJson(value))` without building the canonical string: the
 * value is walked in canonical order (keys sorted by UTF-16 code units, arrays in order) and every
 * UTF-16 code unit that `canonicalJson` would emit is fed straight into the two FNV-1a 32 lanes
 * (low byte, then high byte). Formatting mirrors `canonicalJson` exactly:
 *
 * - strings: `JSON.stringify` quoting (`\"`, `\\`, `\b \f \n \r \t`, other C0 controls and lone
 *   surrogates as lowercase `\uXXXX`, everything else verbatim);
 * - numbers: `0` for `+-0`; safe integers as decimal digits (identical to `String(n)`); anything
 *   else via `String(n)`;
 * - unsupported values and cycles throw the same `InvariantError` (code, message, details) as
 *   `canonicalJson`.
 *
 * Equality with the string-based reference is proven by a fast-check property in
 * `canonical-hash.test.ts`. The hash algorithm itself is frozen; this is only a faster evaluation.
 *
 * Optional `collectNonFinite` mode: instead of throwing on `NaN`/`+-Infinity`, record their paths
 * (and those of `-0`, which hashes as `0`) in `findNonFinite` path format, so callers get the hash
 * and the non-finite scan from one walk.
 */
import { InvariantError } from '../schema/index.js';
import { childPath } from './finite.js';

const FNV_PRIME = 0x01000193;
/**
 * A code unit below 0x100 is fed as `(h ^ c) * P` then `(h ^ 0) * P`; multiplication mod 2^32 is
 * associative, so that equals one multiply by `P * P mod 2^32`. Halves the work for ASCII.
 */
const FNV_PRIME_SQ = Math.imul(FNV_PRIME, FNV_PRIME);
const LANE_A_BASIS = 0x811c9dc5;
const LANE_B_BASIS = 0xcbf29ce4;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const HEX = '0123456789abcdef';

/** Result of a hash walk in `collectNonFinite` mode. */
export interface HashReport {
  /**
   * `hashString(canonicalJson(value))`, or `null` when the value holds `NaN` or `+-Infinity`
   * (which `canonicalJson` rejects). A `-0` is reported in `nonFinite` but still hashes as `0`.
   */
  hash: string | null;
  /**
   * Paths of every `NaN`, `+-Infinity` and `-0`, in canonical (sorted-key, depth-first) order and
   * in `findNonFinite` path format. Each occurrence of a shared subtree is reported separately; for
   * tree-shaped data (every `WorldState`) this equals `findNonFinite(value)`.
   */
  nonFinite: string[];
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class CanonicalHasher {
  a = LANE_A_BASIS;
  b = LANE_B_BASIS;
  depth = 0;
  /** Ancestors of the node being visited (cycle detection, same semantics as `canonicalJson`). */
  readonly ancestors: object[] = [];
  /** Key or index taken out of `ancestors[i]`; only read to build error / report paths. */
  readonly keys: (string | number)[] = [];
  readonly digits: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  readonly nonFinite: string[] = [];
  poisoned = false;

  constructor(readonly collect: boolean) {}

  result(): string {
    return hex8(this.a) + hex8(this.b);
  }

  // --- feeding -----------------------------------------------------------------------------------

  /** One code unit below 0x100 (high byte 0). */
  byte(c: number): void {
    this.a = Math.imul(this.a ^ c, FNV_PRIME_SQ);
    this.b = Math.imul(this.b ^ c, FNV_PRIME_SQ);
  }

  /** A string whose code units are all below 0x100, fed verbatim (no quoting). */
  latin1(s: string): void {
    let a = this.a;
    let b = this.b;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, FNV_PRIME_SQ);
      b = Math.imul(b ^ c, FNV_PRIME_SQ);
    }
    this.a = a;
    this.b = b;
  }

  /** `JSON.stringify(s)`, fed unit by unit. */
  string(s: string): void {
    let a = Math.imul(this.a ^ 0x22, FNV_PRIME_SQ);
    let b = Math.imul(this.b ^ 0x22, FNV_PRIME_SQ);
    const n = s.length;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x22 || c === 0x5c || (c >= 0xd800 && c < 0xe000)) {
        this.a = a;
        this.b = b;
        i = this.escape(s, i, c);
        a = this.a;
        b = this.b;
        continue;
      }
      if (c < 0x100) {
        a = Math.imul(a ^ c, FNV_PRIME_SQ);
        b = Math.imul(b ^ c, FNV_PRIME_SQ);
      } else {
        const hi = c >>> 8;
        a = Math.imul(Math.imul(a ^ (c & 0xff), FNV_PRIME) ^ hi, FNV_PRIME);
        b = Math.imul(Math.imul(b ^ (c & 0xff), FNV_PRIME) ^ hi, FNV_PRIME);
      }
    }
    this.a = Math.imul(a ^ 0x22, FNV_PRIME_SQ);
    this.b = Math.imul(b ^ 0x22, FNV_PRIME_SQ);
  }

  /** Slow path of `string` (QuoteJSONString, ES2019+ well-formed). Returns the last index used. */
  escape(s: string, i: number, c: number): number {
    switch (c) {
      case 0x08:
        this.latin1('\\b');
        return i;
      case 0x09:
        this.latin1('\\t');
        return i;
      case 0x0a:
        this.latin1('\\n');
        return i;
      case 0x0c:
        this.latin1('\\f');
        return i;
      case 0x0d:
        this.latin1('\\r');
        return i;
      case 0x22:
        this.latin1('\\"');
        return i;
      case 0x5c:
        this.latin1('\\\\');
        return i;
      default:
        break;
    }
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        this.unit(c);
        this.unit(next);
        return i + 1;
      }
    }
    // C0 control without a short form, or a lone surrogate.
    this.latin1('\\u');
    this.byte(HEX.charCodeAt((c >>> 12) & 0xf));
    this.byte(HEX.charCodeAt((c >>> 8) & 0xf));
    this.byte(HEX.charCodeAt((c >>> 4) & 0xf));
    this.byte(HEX.charCodeAt(c & 0xf));
    return i;
  }

  unit(c: number): void {
    const lo = c & 0xff;
    const hi = c >>> 8;
    this.a = Math.imul(Math.imul(this.a ^ lo, FNV_PRIME) ^ hi, FNV_PRIME);
    this.b = Math.imul(Math.imul(this.b ^ lo, FNV_PRIME) ^ hi, FNV_PRIME);
  }

  /** `value === 0 ? '0' : String(value)` for a finite number. */
  number(value: number): void {
    if (value === 0) {
      if (this.collect && 1 / value < 0) this.nonFinite.push(this.reportPath());
      this.byte(0x30);
      return;
    }
    if (value - value !== 0) {
      // NaN or +-Infinity.
      if (!this.collect) this.unsupported(String(value));
      this.nonFinite.push(this.reportPath());
      this.poisoned = true;
      return;
    }
    if (value < -MAX_SAFE || value > MAX_SAFE || Math.floor(value) !== value) {
      // Floats and huge integers: `String` is the spec; its output is ASCII.
      this.latin1(String(value));
      return;
    }
    let n = value;
    if (n < 0) {
      this.byte(0x2d);
      n = -n;
    }
    // Safe positive integer: `String(n)` is its plain decimal digits.
    const digits = this.digits;
    let len = 0;
    if (n <= 0x7fffffff) {
      while (n > 0) {
        const q = (n / 10) | 0;
        digits[len++] = n - q * 10;
        n = q;
      }
    } else {
      while (n > 0) {
        const d = n % 10;
        digits[len++] = d;
        n = (n - d) / 10; // exact: n - d is a multiple of 10 below 2^53
      }
    }
    let a = this.a;
    let b = this.b;
    while (len > 0) {
      const c = 0x30 + (digits[--len] ?? 0);
      a = Math.imul(a ^ c, FNV_PRIME_SQ);
      b = Math.imul(b ^ c, FNV_PRIME_SQ);
    }
    this.a = a;
    this.b = b;
  }

  // --- walking -----------------------------------------------------------------------------------

  value(value: unknown): void {
    switch (typeof value) {
      case 'number':
        this.number(value);
        return;
      case 'string':
        this.string(value);
        return;
      case 'boolean':
        this.latin1(value ? 'true' : 'false');
        return;
      case 'object':
        if (value === null) this.latin1('null');
        else this.object(value);
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
      case 'bigint':
        this.unsupported(typeof value);
    }
  }

  object(obj: object): void {
    const ancestors = this.ancestors;
    const keys = this.keys;
    const depth = this.depth;
    for (let i = 0; i < depth; i++) {
      if (ancestors[i] === obj) {
        const path = this.canonicalPath(depth);
        throw new InvariantError('canon.cycle', `cyclic reference at ${path}`, { path });
      }
    }
    if (Array.isArray(obj)) {
      const arr = obj as unknown[];
      ancestors[depth] = arr;
      this.depth = depth + 1;
      this.byte(0x5b);
      for (let i = 0; i < arr.length; i++) {
        if (i > 0) this.byte(0x2c);
        keys[depth] = i;
        const item = arr[i];
        if (item === undefined && !(i in arr)) {
          this.depth = depth + 1;
          this.unsupported('array hole');
        }
        this.value(item);
      }
      this.byte(0x5d);
      this.depth = depth;
      return;
    }
    if (!isPlainObject(obj)) {
      this.unsupported(
        obj instanceof Map ? 'Map' : obj instanceof Set ? 'Set' : 'non-plain object',
      );
    }
    const record = obj as Record<string, unknown>;
    const names = Object.keys(record);
    const count = names.length;
    // Most state objects already enumerate in sorted order (integer-like keys enumerate numerically,
    // which can differ from code-unit order, so this check is required, not an assumption).
    for (let i = 1; i < count; i++) {
      if ((names[i - 1] ?? '') > (names[i] ?? '')) {
        names.sort();
        break;
      }
    }
    ancestors[depth] = record;
    this.depth = depth + 1;
    this.byte(0x7b);
    for (let i = 0; i < count; i++) {
      const key = names[i] ?? '';
      if (i > 0) this.byte(0x2c);
      keys[depth] = key;
      this.string(key);
      this.byte(0x3a);
      this.value(record[key]);
    }
    this.byte(0x7d);
    this.depth = depth;
  }

  // --- errors and paths --------------------------------------------------------------------------

  /** Path of the current node in `canonicalJson` error format (`$.a[0].b`). */
  canonicalPath(depth: number): string {
    let path = '$';
    for (let i = 0; i < depth; i++) {
      const key = this.keys[i];
      path += typeof key === 'number' ? `[${key}]` : `.${key ?? ''}`;
    }
    return path;
  }

  /** Path of the current node in `findNonFinite` format (`$.a[0]["c-d"]`). */
  reportPath(): string {
    let path = '$';
    for (let i = 0; i < this.depth; i++) {
      const key = this.keys[i];
      path = typeof key === 'number' ? `${path}[${key}]` : childPath(path, key ?? '');
    }
    return path;
  }

  unsupported(what: string): never {
    const path = this.canonicalPath(this.depth);
    throw new InvariantError('canon.unsupported', `cannot canonicalise ${what} at ${path}`, {
      path,
      what,
    });
  }
}

/** `hashString(canonicalJson(value))`, computed in one allocation-light walk. */
export function canonicalHash(value: unknown): string {
  const hasher = new CanonicalHasher(false);
  hasher.value(value);
  return hasher.result();
}

/** Like `canonicalHash`, but collects non-finite paths instead of throwing on `NaN`/`Infinity`. */
export function canonicalHashReport(value: unknown): HashReport {
  const hasher = new CanonicalHasher(true);
  hasher.value(value);
  return { hash: hasher.poisoned ? null : hasher.result(), nonFinite: hasher.nonFinite };
}
