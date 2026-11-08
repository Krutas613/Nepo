/**
 * Canonical JSON (ARCHITECTURE.md section 10, ADR-008).
 *
 * Object keys sorted by UTF-16 code-unit order; arrays in order; strings via `JSON.stringify`;
 * numbers via `String(n)` (fully specified by ECMAScript); `-0` written as `0`; `null` as `null`.
 * Throws `InvariantError('canon.unsupported')` on `undefined`, functions, symbols, bigint, Map,
 * Set, Date, non-plain objects, sparse array holes and non-finite numbers, and
 * `InvariantError('canon.cycle')` on cyclic references.
 */
import { InvariantError } from '../schema/index.js';

function unsupported(path: string, what: string): never {
  throw new InvariantError('canon.unsupported', `cannot canonicalise ${what} at ${path}`, {
    path,
    what,
  });
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string, parts: string[], stack: WeakSet<object>): void {
  if (typeof value === 'string') {
    parts.push(JSON.stringify(value));
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) unsupported(path, String(value));
    parts.push(value === 0 ? '0' : String(value));
    return;
  }
  if (typeof value === 'boolean') {
    parts.push(value ? 'true' : 'false');
    return;
  }
  if (value === null) {
    parts.push('null');
    return;
  }
  if (typeof value !== 'object') unsupported(path, typeof value);
  const obj = value;
  if (stack.has(obj)) {
    throw new InvariantError('canon.cycle', `cyclic reference at ${path}`, { path });
  }
  if (Array.isArray(obj)) {
    stack.add(obj);
    parts.push('[');
    const arr = obj as unknown[];
    for (let i = 0; i < arr.length; i++) {
      if (i > 0) parts.push(',');
      if (!(i in arr)) unsupported(`${path}[${i}]`, 'array hole');
      write(arr[i], `${path}[${i}]`, parts, stack);
    }
    parts.push(']');
    stack.delete(obj);
    return;
  }
  if (!isPlainObject(obj)) {
    const name = obj instanceof Map ? 'Map' : obj instanceof Set ? 'Set' : 'non-plain object';
    unsupported(path, name);
  }
  stack.add(obj);
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  parts.push('{');
  let first = true;
  for (const key of keys) {
    if (!first) parts.push(',');
    first = false;
    parts.push(JSON.stringify(key), ':');
    write(record[key], `${path}.${key}`, parts, stack);
  }
  parts.push('}');
  stack.delete(obj);
}

/** Deterministic JSON text for plain data. */
export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  write(value, '$', parts, new WeakSet());
  return parts.join('');
}
