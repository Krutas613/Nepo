/**
 * Test-only helpers for engine tests. Not exported from the engine barrel.
 */
import type { AccountingState } from '../schema/index.js';
import { sortedKeys } from './sorted.js';
import type { System } from './system.js';

/**
 * An AI-like system that exercises RNG streams, the registry and `ctx.submit` in `decide`. It takes
 * the `accounting` id (and keeps that slice empty) only so its worlds remain valid against the
 * strict v1 snapshot schema, which has no slot for test systems.
 */
export const chaosSystem: System<AccountingState> = {
  id: 'accounting',
  handles: [],
  init: () => ({ entities: {}, journal: [] }),
  phases: {
    decide(ctx) {
      const ids = sortedKeys(ctx.state.companies);
      for (const id of ids) {
        if (ctx.rng.chance(0.2)) {
          const n = ctx.rngFor('names').int(0, 9999);
          ctx.submit({ type: 'company.rename', issuer: id, payload: { name: `Co ${n}` } });
        }
        if (ctx.rng.chance(0.05) && ids.length > 0) {
          const target = ctx.rng.pick(ids);
          ctx.submit({
            type: 'company.rename',
            issuer: id,
            payload: { name: 'Hostile', companyId: target },
          });
        }
        if (ctx.rng.chance(0.1)) ctx.issueId('contract');
      }
    },
  },
};
