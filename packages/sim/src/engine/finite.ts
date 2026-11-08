/**
 * Non-finite number detection (ARCHITECTURE.md section 2). `NaN`, `+-Infinity` and `-0` are
 * forbidden anywhere in state; sim-tests calls this every tick and `step` calls it under
 * `checkFinite`.
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function childPath(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function walk(value: unknown, path: string, out: string[], seen: WeakSet<object>): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) out.push(path);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) walk(arr[i], `${path}[${i}]`, out, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) walk(record[key], childPath(path, key), out, seen);
}

/**
 * JSON paths (rooted at `$`, keys in sorted order) of every `NaN`, `Infinity`, `-Infinity` or
 * `-0` inside `value`. Empty when the value is clean.
 */
export function findNonFinite(value: unknown): string[] {
  const out: string[] = [];
  walk(value, '$', out, new WeakSet());
  return out;
}
