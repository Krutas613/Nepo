/**
 * `retailSystem` (docs/design/retail.md; ARCHITECTURE.md section 6.1 phases `apply` and `market`;
 * ADR-012/013/014).
 *
 * - `apply`: `store.build`, `store.set_price`, `store.set_restock_policy` (validation in `commands.ts`).
 * - `market`, one handler, restock then sell: (1) complete construction, (2) reset the day, (3) restock
 *   from the owner's same-city factories through `ManufacturingApi.withdraw` for every store, then
 *   (4) ONE `clearConsumerMarket` call per (market, product) with every store's final shelf, applying
 *   each store's sale with COGS from the shelf lot, then (5) shrinkage, (6) daily operating cost and
 *   (7) month-end depreciation.
 * - Service: `RetailApi` under `RETAIL_SERVICE`.
 *
 * Determinism: no RNG; every iteration is over `sortedKeys`; offers are built in store order.
 * Spend classes (ADR-014): the build (capex) is discretionary and checked; operating cost,
 * depreciation and write-offs are non-discretionary and always posted.
 */
import {
  ACCOUNTING_SERVICE,
  ACCOUNTS,
  capex,
  cashPurchase,
  depreciation,
  inventoryWriteOff,
  retailSale,
  type AccountingApi,
} from '../accounting/index.js';
import { ECONOMY_SERVICE, type EconomyApi } from '../economy/index.js';
import { sortedKeys, type System, type TickContext } from '../engine/index.js';
import { MANUFACTURING_SERVICE, type ManufacturingApi } from '../manufacturing/index.js';
import {
  InvariantError,
  money,
  type Command,
  type MarketId,
  type ProductId,
  type RetailState,
  type Store,
  type StoreId,
} from '../schema/index.js';
import {
  validateBuild,
  validateSetPrice,
  validateSetRestockPolicy,
  type Rejection,
} from './commands.js';
import { RETAIL_SERVICE, createRetailApi, type RetailApi } from './service.js';
import {
  buildOffer,
  createStore,
  depreciationCharge,
  freeCapacity,
  newShelfLine,
  applyShrinkage,
  resetDay,
  restockQuantity,
  settleSale,
  unmetDemand,
  type ReadonlyStoreFormat,
} from './store.js';

type Ctx = TickContext<RetailState>;

interface Services {
  accounting: AccountingApi;
  economy: EconomyApi;
  manufacturing: ManufacturingApi;
  retail: RetailApi;
}

function servicesOf(ctx: Ctx): Services {
  return {
    accounting: ctx.services.get(ACCOUNTING_SERVICE),
    economy: ctx.services.get(ECONOMY_SERVICE),
    manufacturing: ctx.services.get(MANUFACTURING_SERVICE),
    retail: ctx.services.get(RETAIL_SERVICE),
  };
}

function formatOf(ctx: Ctx, store: Store): ReadonlyStoreFormat {
  const format = ctx.scenario.content.storeFormats[store.formatId];
  if (format === undefined) {
    throw new InvariantError(
      'retail.unknown_format',
      `${store.id} has unknown format ${store.formatId}`,
    );
  }
  return format;
}

// ---------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------

function rejectWith(ctx: Ctx, command: Command, rejection: Rejection): void {
  ctx.reject(command, rejection.code, rejection.message);
}

function applyCommand(ctx: Ctx, command: Command, svc: Services): void {
  const content = ctx.scenario.content;
  switch (command.type) {
    case 'store.build': {
      const { companyId, storeFormatId, cityId } = command.payload;
      const city = content.cities[cityId];
      const verdict = validateBuild({
        issuer: command.issuer,
        companyId,
        format: content.storeFormats[storeFormatId],
        city,
        marketId: city === undefined ? null : svc.economy.marketOfCity(cityId),
        cash: svc.accounting.cash(command.issuer),
      });
      if (!verdict.ok) {
        rejectWith(ctx, command, verdict.error);
        return;
      }
      const { format, marketId } = verdict.value;
      const id = ctx.issueId('store');
      ctx.slice.stores[id] = createStore({
        id,
        ownerId: command.issuer,
        format,
        cityId,
        marketId,
        tick: ctx.tick,
      });
      if (format.buildCost > 0) {
        svc.accounting.postOrThrow(
          command.issuer,
          capex(format.buildCost, 'retail', { ref: { kind: 'store', id } }),
        );
      }
      ctx.emit({
        type: 'store.ordered',
        payload: {
          storeId: id,
          companyId: command.issuer,
          storeFormatId: format.id,
          cityId,
          completesTick: ctx.tick + format.constructionTicks,
        },
      });
      return;
    }
    case 'store.set_price': {
      const { storeId, productId, price } = command.payload;
      const store = ctx.slice.stores[storeId];
      const verdict = validateSetPrice(
        {
          issuer: command.issuer,
          store,
          format: store === undefined ? undefined : content.storeFormats[store.formatId],
          product: content.products[productId],
        },
        price,
      );
      if (!verdict.ok) {
        rejectWith(ctx, command, verdict.error);
        return;
      }
      if (store === undefined) return;
      const line = (store.shelves[productId] ??= newShelfLine());
      line.price = price;
      ctx.emit({ type: 'store.price_set', payload: { storeId, productId, price } });
      return;
    }
    case 'store.set_restock_policy': {
      const { storeId, productId, sourceFacilityId, targetStock } = command.payload;
      const store = ctx.slice.stores[storeId];
      const verdict = validateSetRestockPolicy({
        issuer: command.issuer,
        store,
        format: store === undefined ? undefined : content.storeFormats[store.formatId],
        product: content.products[productId],
        sourceFacilityId,
        facility: sourceFacilityId === null ? null : svc.manufacturing.facility(sourceFacilityId),
        targetStock,
      });
      if (!verdict.ok) {
        rejectWith(ctx, command, verdict.error);
        return;
      }
      if (store === undefined) return;
      const line = (store.shelves[productId] ??= newShelfLine());
      line.restock = { sourceFacilityId, targetStock };
      ctx.emit({
        type: 'store.restock_policy_set',
        payload: { storeId, productId, sourceFacilityId, targetStock },
      });
      return;
    }
    // Routed to other systems; `handles` keeps them out of this inbox.
    case 'company.rename':
    case 'facility.build':
    case 'facility.set_production':
    case 'facility.set_recipe':
    case 'loan.repay':
    case 'loan.request':
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// market
// ---------------------------------------------------------------------------------------------

/** Steps 1-3 for one store: construction, reset, restock (ADR-013). */
function openAndRestock(ctx: Ctx, store: Store, svc: Services): void {
  if (store.status === 'under_construction' && ctx.tick >= store.completesTick) {
    store.status = 'operating';
    ctx.emit({ type: 'store.opened', payload: { storeId: store.id } });
  }
  if (store.status !== 'operating') return;
  const format = formatOf(ctx, store);

  for (const productId of sortedKeys(store.shelves)) {
    const line = store.shelves[productId];
    if (line !== undefined) resetDay(line);
  }

  for (const productId of sortedKeys(store.shelves)) {
    const line = store.shelves[productId];
    const source = line?.restock.sourceFacilityId ?? null;
    if (line === undefined || source === null) continue;
    const q = restockQuantity(
      line.restock.targetStock,
      line.lot.quantity,
      freeCapacity(store, format),
      svc.manufacturing.availableOutput(source, productId),
    );
    if (q < 1) continue;
    const w = svc.manufacturing.withdraw(
      store.ownerId,
      source,
      productId,
      q,
      ACCOUNTS.INVENTORY_MERCHANDISE,
    );
    if (!w.ok) {
      const code = w.error.code;
      if (code === 'not_owner' || code === 'unknown_facility') {
        line.restock.sourceFacilityId = null;
        ctx.emit({
          type: 'store.restock_failed',
          payload: { storeId: store.id, productId, code },
        });
        continue;
      }
      throw new InvariantError('retail.restock_failed', `${store.id}/${productId}: ${code}`, {
        code,
        message: w.error.message,
      });
    }
    const landed = svc.retail.receive(store.id, productId, w.value.quantity, w.value.cost, {
      kind: 'facility',
      id: source,
    });
    if (!landed.ok) {
      throw new InvariantError('retail.receive_failed', landed.error.message, {
        code: landed.error.code,
      });
    }
    ctx.emit({
      type: 'store.restocked',
      payload: {
        storeId: store.id,
        facilityId: source,
        productId,
        quantity: w.value.quantity,
        cost: w.value.cost,
      },
    });
  }
}

/** Step 4: one clearing per (market, product); applies each store's sale. */
function sell(ctx: Ctx, svc: Services): void {
  const groups: Record<MarketId, Record<ProductId, StoreId[]>> = {};
  for (const storeId of sortedKeys(ctx.slice.stores)) {
    const store = ctx.slice.stores[storeId];
    if (store?.status !== 'operating') continue;
    for (const productId of sortedKeys(store.shelves)) {
      if ((store.shelves[productId]?.lot.quantity ?? 0) <= 0) continue;
      const byProduct = (groups[store.marketId] ??= {});
      (byProduct[productId] ??= []).push(storeId);
    }
  }

  for (const marketId of sortedKeys(groups)) {
    const byProduct = groups[marketId] ?? {};
    for (const productId of sortedKeys(byProduct)) {
      const storeIds = byProduct[productId] ?? [];
      const reference = svc.economy.referencePrice(marketId, productId);
      const offers = storeIds.map((id) => {
        const store = ctx.slice.stores[id];
        if (store === undefined) throw new InvariantError('retail.unknown_store', id);
        return buildOffer(store, productId, reference);
      });
      const clearing = svc.economy.clearConsumerMarket(marketId, productId, offers);

      storeIds.forEach((id, i) => {
        const store = ctx.slice.stores[id];
        const line = store?.shelves[productId];
        const offer = offers[i];
        const sold = clearing.sold[i];
        if (
          store === undefined ||
          line === undefined ||
          offer === undefined ||
          sold === undefined
        ) {
          throw new InvariantError('retail.clearing_misaligned', `${id}/${productId}`);
        }
        line.unmetToday = unmetDemand(offer.quantity, sold, clearing.demandAfter);
        if (sold < 1) return;
        const sale = settleSale(line, sold, offer.price);
        svc.accounting.postOrThrow(
          store.ownerId,
          retailSale(sale.revenue, sale.cogs, 'retail', { ref: { kind: 'store', id } }),
        );
        ctx.emit({
          type: 'store.sold',
          payload: {
            storeId: id,
            productId,
            quantity: sale.quantity,
            revenue: sale.revenue,
            cogs: sale.cogs,
            price: offer.price,
            referencePrice: clearing.referencePrice,
            stockout: line.unmetToday > 0,
          },
        });
      });
    }
  }
}

/** Steps 5-7 for one operating store: shrinkage, daily operating cost, month-end depreciation. */
function closeStoreDay(ctx: Ctx, store: Store, svc: Services): void {
  const format = formatOf(ctx, store);
  const ref = { kind: 'store', id: store.id };

  if (format.shrinkagePerMille > 0) {
    for (const productId of sortedKeys(store.shelves)) {
      const line = store.shelves[productId];
      if (line === undefined) continue;
      const { lost, cost } = applyShrinkage(line, format.shrinkagePerMille);
      if (lost >= 1 && cost > 0) {
        svc.accounting.postOrThrow(
          store.ownerId,
          inventoryWriteOff(ACCOUNTS.INVENTORY_MERCHANDISE, cost, 'retail', { ref }),
        );
      }
    }
  }

  if (format.dailyOperatingCost > 0) {
    svc.accounting.postOrThrow(
      store.ownerId,
      cashPurchase(ACCOUNTS.OPEX_FACILITY, format.dailyOperatingCost, 'retail', {
        memo: 'Store operating cost',
        ref,
      }),
    );
  }

  if (ctx.date.isMonthEnd) {
    const charge = depreciationCharge(
      store.cost,
      store.accumulatedDepreciation,
      format.usefulLifeMonths,
    );
    if (charge > 0) {
      svc.accounting.postOrThrow(store.ownerId, depreciation(charge, 'retail', { ref }));
      store.accumulatedDepreciation = money(store.accumulatedDepreciation + charge);
    }
  }
}

export const retailSystem: System<RetailState> = {
  id: 'retail',
  handles: ['store.build', 'store.set_price', 'store.set_restock_policy'],
  init() {
    return { stores: {} };
  },
  phases: {
    apply(ctx) {
      if (ctx.commands.length === 0) return;
      const svc = servicesOf(ctx);
      for (const command of ctx.commands) applyCommand(ctx, command, svc);
    },
    market(ctx) {
      const svc = servicesOf(ctx);
      const ids = sortedKeys(ctx.slice.stores);
      for (const id of ids) {
        const store = ctx.slice.stores[id];
        if (store !== undefined) openAndRestock(ctx, store, svc);
      }
      sell(ctx, svc);
      for (const id of ids) {
        const store = ctx.slice.stores[id];
        if (store?.status === 'operating') closeStoreDay(ctx, store, svc);
      }
    },
  },
  createService: createRetailApi,
  serviceKey: RETAIL_SERVICE,
};
