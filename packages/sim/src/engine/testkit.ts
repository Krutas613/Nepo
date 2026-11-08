/**
 * Test-only helpers for engine tests. Not exported from the engine barrel.
 */
import { sortedKeys } from './sorted.js';
import type { System } from './system.js';

/** Plain-JSON slice of `chaosSystem` (an untyped slice, ARCHITECTURE.md section 2). */
export interface ChaosSlice {
  decisions: number;
}

/**
 * An AI-like system that exercises RNG streams, the registry and `ctx.submit` in `decide`. It uses
 * the `ai` id, whose slice is not typed yet, so its worlds carry an untyped plain-JSON slice that
 * `WorldStateSchema` accepts; snapshot/restore round trips cover that path too.
 */
export const chaosSystem: System<ChaosSlice> = {
  id: 'ai',
  handles: [],
  init: () => ({ decisions: 0 }),
  phases: {
    decide(ctx) {
      ctx.slice.decisions += 1;
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
