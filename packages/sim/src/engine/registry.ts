/**
 * Entity registry (ARCHITECTURE.md section 3, docs/design/engine.md section 2).
 *
 * IDs are `${ID_PREFIX[kind]}_${String(n).padStart(6, '0')}` from a per-kind counter in
 * `state.registry.counters` (missing = 0), starting at `_000001`. Never random, never reused;
 * deleting an entity leaves a gap. Beyond 999999 the number simply grows.
 */
import { ID_PREFIX, type EntityKind, type IdOf, type RegistryState } from '../schema/index.js';

export function formatEntityId<K extends EntityKind>(kind: K, n: number): IdOf<K> {
  return `${ID_PREFIX[kind]}_${String(n).padStart(6, '0')}` as IdOf<K>;
}

/** Issues the next ID of `kind`, advancing `registry.counters[kind]` in place. */
export function issueId<K extends EntityKind>(registry: RegistryState, kind: K): IdOf<K> {
  const n = (registry.counters[kind] ?? 0) + 1;
  registry.counters[kind] = n;
  return formatEntityId(kind, n);
}
