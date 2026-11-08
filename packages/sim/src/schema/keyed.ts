/** Internal validator helpers shared by schema files; not re-exported from the barrel. */
import type { z } from 'zod';

/**
 * Adds an issue for every entry of `record` whose identifying field differs from its key
 * (keyed collections must be keyed by the item's own id). Keys are visited in sorted order so the
 * issue list is deterministic.
 */
export function checkKeyedBy<T>(
  record: Readonly<Partial<Record<string, T>>>,
  field: string,
  idOf: (item: T) => string,
  path: readonly PropertyKey[],
  ctx: z.RefinementCtx,
): void {
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    const id = idOf(item);
    if (id !== key) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, key, field],
        message: `entry keyed ${key} has ${field} ${id}`,
      });
    }
  }
}
