/**
 * `manufacturingSystem` (docs/design/manufacturing.md; ARCHITECTURE.md section 6.1).
 *
 * - `init`: an empty slice (facilities are created by `facility.build`).
 * - `phases.apply`: `facility.build`, `facility.set_recipe`, `facility.set_production`, in
 *   `ctx.commands` order.
 * - `phases.production`: per facility in `sortedKeys` order: construction, WIP completion, JIT
 *   input purchase and batch starts, daily operating cost, month-end depreciation (ADR-009: posted
 *   here, not in `close`).
 * - Service: `ManufacturingApi` under `MANUFACTURING_SERVICE`.
 *
 * Determinism: no RNG (the `manufacturing` stream is never drawn from), `sortedKeys` everywhere,
 * content read from `ctx.scenario.content` each tick, nothing cached in module scope.
 */
import { ACCOUNTING_SERVICE } from '../accounting/index.js';
import { ECONOMY_SERVICE } from '../economy/index.js';
import { sortedKeys, type System } from '../engine/index.js';
import type { ManufacturingState } from '../schema/index.js';
import { applyCommand, MANUFACTURING_COMMANDS, type CommandEnv } from './commands.js';
import { runFacilityDay, type ProductionEnv } from './production.js';
import { MANUFACTURING_SERVICE, createManufacturingApi } from './service.js';

export const manufacturingSystem: System<ManufacturingState> = {
  id: 'manufacturing',
  handles: MANUFACTURING_COMMANDS,
  init() {
    return { facilities: {} };
  },
  phases: {
    apply(ctx) {
      if (ctx.commands.length === 0) return;
      const accounting = ctx.services.get(ACCOUNTING_SERVICE);
      const env: CommandEnv = {
        tick: ctx.tick,
        content: ctx.scenario.content,
        cash: (ownerId) => accounting.cash(ownerId),
        post: (ownerId, entry) => {
          accounting.postOrThrow(ownerId, entry);
        },
        issueFacilityId: () => ctx.issueId('facility'),
        emit: (event) => {
          ctx.emit(event);
        },
        reject: (command, code, reason) => {
          ctx.reject(command, code, reason);
        },
      };
      for (const command of ctx.commands) applyCommand(ctx.slice, command, env);
    },
    production(ctx) {
      const ids = sortedKeys(ctx.slice.facilities);
      if (ids.length === 0) return;
      const accounting = ctx.services.get(ACCOUNTING_SERVICE);
      const economy = ctx.services.get(ECONOMY_SERVICE);
      const env: ProductionEnv = {
        tick: ctx.tick,
        isMonthEnd: ctx.date.isMonthEnd,
        content: ctx.scenario.content,
        cash: (ownerId) => accounting.cash(ownerId),
        quoteRaw: (productId, qty) => economy.quoteRaw(productId, qty),
        buyRaw: (ownerId, productId, qty) => economy.buyRaw(ownerId, productId, qty),
        post: (ownerId, entry) => {
          accounting.postOrThrow(ownerId, entry);
        },
        emit: (event) => {
          ctx.emit(event);
        },
      };
      for (const id of ids) {
        const facility = ctx.slice.facilities[id];
        if (facility !== undefined) runFacilityDay(facility, env);
      }
    },
  },
  createService: createManufacturingApi,
  serviceKey: MANUFACTURING_SERVICE,
};
