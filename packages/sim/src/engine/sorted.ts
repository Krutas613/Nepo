/**
 * Deterministic iteration helper (ARCHITECTURE.md section 2, collections rule).
 *
 * Keyed collections in state are `Record<Id, T>`; iterate them only over `sortedKeys(record)`.
 * The order is UTF-16 code-unit order (the default `Array.prototype.sort` order for strings),
 * which is identical on every ECMAScript engine.
 */
export function sortedKeys<K extends string>(record: Readonly<Partial<Record<K, unknown>>>): K[] {
  return (Object.keys(record) as K[]).sort();
}
