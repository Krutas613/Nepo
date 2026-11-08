/**
 * `economySystem` (docs/design/economy.md; ARCHITECTURE.md section 6.1 phase `macro`).
 *
 * - `init`: one `MarketState` per content market (level 1, reference = anchor, today's baseline
 *   demand open), one `CommodityState` per source; emits `market.opened` per market. With
 *   `EMPTY_CONTENT_PACK` the slice is `EMPTY_ECONOMY_STATE` plus the macro tunables.
 * - `phases.macro`: inflation step on month starts, then every reference price and commodity price
 *   from the previous day's tallies (ADR-011), then today's baseline demand is opened. Prices for
 *   day t are fixed before anyone trades on day t.
 * - No `market` handler in M1 (reserved for M2 B2B/commodity clearing). Handles no commands.
 * - Service: `EconomyApi` under `ECONOMY_SERVICE`.
 *
 * Determinism: no RNG (the `economy` stream exists but is never drawn from), `sortedKeys` everywhere,
 * content read from `ctx.scenario.content` each tick, nothing cached in module scope.
 */
import type { System } from '../engine/index.js';
import type { EconomyState } from '../schema/index.js';
import { ECONOMY_SERVICE, createEconomyApi, type EconomyApiInternal } from './service.js';
import { advanceDay, createEconomyState } from './state.js';

export const economySystem: System<EconomyState> = {
  id: 'economy',
  handles: [],
  init(ctx) {
    return createEconomyState(ctx.scenario.content, {
      tick: ctx.state.tick,
      emit: (event) => {
        ctx.emit(event);
      },
    });
  },
  phases: {
    macro(ctx) {
      // Interim content binding for the service (see service.ts); the cast is to the internal
      // surface of our own service object.
      (ctx.services.get(ECONOMY_SERVICE) as EconomyApiInternal).bindContent(ctx.scenario.content);
      advanceDay(ctx.slice, ctx.scenario.content, ctx.date, {
        tick: ctx.tick,
        emit: (event) => {
          ctx.emit(event);
        },
      });
    },
  },
  createService: createEconomyApi,
  serviceKey: ECONOMY_SERVICE,
};
