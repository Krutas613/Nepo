/** Internal helper for schema constants; not re-exported from the barrel. */

/** Recursively `Object.freeze`s a plain-data value and returns it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
