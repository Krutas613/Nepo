/**
 * Non-finite number detection (ARCHITECTURE.md section 2). `NaN`, `+-Infinity` and `-0` are
 * forbidden anywhere in state; sim-tests calls this every tick and `step` calls it under
 * `checkFinite`.
 *
 * Two passes: a cheap detection walk (`hasNonFinite`: no key sorting, no path strings) and, only
 * when something is found, a sorted walk that builds the reported paths. Clean state, the common
 * case, pays for the first pass only. Shared subtrees are visited once and cycles are tolerated.
 * `hashState(state, { collectNonFinite: true })` gives the hash and the paths in a single walk.
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `path.key`, or `path["key"]` when `key` is not an identifier. */
export function childPath(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Options for `findNonFinite`. */
export interface FindNonFiniteOptions {
  /** Stop after this many paths (e.g. `1` for a fail-fast check). Default: unlimited. */
  limit?: number;
}

function isBad(n: number): boolean {
  // `n - n` is NaN for NaN and +-Infinity; `1 / -0` is -Infinity.
  return n - n !== 0 || (n === 0 && 1 / n < 0);
}

function detect(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === 'number') return isBad(value);
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  // Order is irrelevant for a yes/no answer, so no sort here.
  const items: unknown[] = Array.isArray(value) ? value : Object.values(value);
  for (const item of items) {
    if (typeof item === 'number') {
      if (isBad(item)) return true;
    } else if (typeof item === 'object' && item !== null && detect(item, seen)) {
      return true;
    }
  }
  return false;
}

function walk(
  value: unknown,
  path: string,
  out: string[],
  seen: WeakSet<object>,
  limit: number,
): void {
  if (out.length >= limit) return;
  if (typeof value === 'number') {
    if (isBad(value)) out.push(path);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) walk(arr[i], `${path}[${i}]`, out, seen, limit);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    walk(record[key], childPath(path, key), out, seen, limit);
  }
}

/** True when `value` holds a `NaN`, `Infinity`, `-Infinity` or `-0` anywhere. Cheapest check. */
export function hasNonFinite(value: unknown): boolean {
  return detect(value, new WeakSet());
}

/**
 * JSON paths (rooted at `$`, keys in sorted order) of every `NaN`, `Infinity`, `-Infinity` or
 * `-0` inside `value`, up to `options.limit`. Empty when the value is clean.
 */
export function findNonFinite(value: unknown, options?: FindNonFiniteOptions): string[] {
  if (!hasNonFinite(value)) return [];
  const out: string[] = [];
  walk(value, '$', out, new WeakSet(), options?.limit ?? Infinity);
  return out;
}
