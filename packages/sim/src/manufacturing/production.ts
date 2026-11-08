/**
 * One facility-day of the `production` phase (docs/design/manufacturing.md section 5), written over
 * a small `ProductionEnv` so it runs with the real engine services or with test stubs.
 *
 * Order per facility: construction completion, WIP completion, start plan, JIT input purchase,
 * batch start, operating cost, month-end depreciation. Money moves only through `env.post`, and the
 * cash balance is re-read from `env.cash` whenever it matters (never cached).
 */
import {
  ACCOUNTS,
  SPEND_CLASS,
  allocateMoney,
  canSpend,
  cashPurchase,
  depreciation,
  inventoryPurchase,
  productionComplete,
  productionStart,
} from '../accounting/index.js';
import {
  InvariantError,
  ZERO_MONEY,
  addMoney,
  mulMoney,
  quantity,
  type CompanyId,
  type EventInput,
  type Facility,
  type JournalEntryInput,
  type Money,
  type ProductId,
  type Quantity,
  type StarvedReason,
  type WipBatch,
} from '../schema/index.js';
import {
  advanceConstruction,
  batchesThatFit,
  nextDepreciationCharge,
  pendingOutput,
  primaryOutput,
  wipBatchCount,
  type ManufacturingContent,
} from './facility.js';
import { issueFromLot, lotFor, receiveIntoLot } from './lots.js';

/** A raw-material quote or purchase receipt (structurally `economy.RawQuote`). */
export interface RawPrice {
  unitPrice: Money;
  total: Money;
}

/** Everything a facility-day needs from the outside world. */
export interface ProductionEnv {
  readonly tick: number;
  readonly isMonthEnd: boolean;
  readonly content: ManufacturingContent;
  /** Current cash of the company (re-read after each posting). */
  cash(ownerId: CompanyId): Money;
  /** Read-only quote (`EconomyApi.quoteRaw`). */
  quoteRaw(productId: ProductId, qty: Quantity): RawPrice;
  /** Records the purchase (`EconomyApi.buyRaw`); the caller posts the money. */
  buyRaw(ownerId: CompanyId, productId: ProductId, qty: Quantity): RawPrice;
  /** Posts to the ledger; must throw on failure (a failed posting here is a bug). */
  post(ownerId: CompanyId, entry: JournalEntryInput): void;
  emit(event: EventInput): void;
}

const SOURCE = 'manufacturing' as const;

/** The reference attached to every posting a facility makes. */
function refOf(facility: Facility): { kind: string; id: string } {
  return { kind: 'facility', id: facility.id };
}

/** Largest whole number of `unitPrice`-priced units affordable with `cash`; 0 when cash <= 0. */
export function affordableUnits(cash: Money, unitPrice: Money): number {
  if (cash <= 0 || unitPrice <= 0) return 0;
  return Math.floor(cash / unitPrice);
}

/**
 * Inserts a batch keeping `wip` in ascending `completesTick` order, FIFO among equals (a recipe
 * change can make a later start finish earlier).
 */
export function insertWip(wip: WipBatch[], batch: WipBatch): void {
  let at = wip.length;
  while (at > 0 && (wip[at - 1]?.completesTick ?? 0) > batch.completesTick) at -= 1;
  wip.splice(at, 0, batch);
}

/** Step 2: completes every WIP batch due on `env.tick` into the finished-goods lots. */
export function completeWip(facility: Facility, env: ProductionEnv): void {
  const due: WipBatch[] = [];
  const pending: WipBatch[] = [];
  for (const batch of facility.wip) {
    (batch.completesTick <= env.tick ? due : pending).push(batch);
  }
  if (due.length === 0) return;
  facility.wip = pending;
  for (const batch of due) {
    const recipe = env.content.recipes[batch.recipeId];
    if (recipe === undefined) {
      throw new InvariantError(
        'manufacturing.unknown_recipe',
        `wip batch has unknown recipe ${batch.recipeId}`,
        {
          facilityId: facility.id,
        },
      );
    }
    const weights = recipe.outputs.map(
      (line) =>
        line.quantity * batch.batches * (env.content.products[line.product]?.basePrice ?? 1),
    );
    const costs = allocateMoney(batch.value, weights);
    const outputs: { productId: ProductId; quantity: Quantity; cost: Money }[] = [];
    recipe.outputs.forEach((line, j) => {
      const qty = quantity(line.quantity * batch.batches);
      const cost = costs[j] ?? ZERO_MONEY;
      receiveIntoLot(lotFor(facility.outputs, line.product), qty, cost);
      outputs.push({ productId: line.product, quantity: qty, cost });
    });
    if (batch.value > 0) {
      env.post(facility.ownerId, productionComplete(batch.value, SOURCE, { ref: refOf(facility) }));
    }
    env.emit({
      type: 'production.completed',
      payload: {
        facilityId: facility.id,
        recipeId: batch.recipeId,
        batches: batch.batches,
        outputs,
      },
    });
  }
}

/**
 * Steps 3 and 4: plans and starts batches, buying inputs just in time. Sets `starvedReason` and
 * emits `production.starved` when fewer batches start than `targetBatches`.
 */
export function startBatches(
  facility: Facility,
  capacity: Quantity,
  storageCapacity: Quantity,
  env: ProductionEnv,
): void {
  facility.starvedReason = null;
  const recipe = facility.recipeId === null ? undefined : env.content.recipes[facility.recipeId];
  if (recipe === undefined) {
    facility.starvedReason = 'no_recipe';
    return;
  }
  const target = facility.targetBatches;
  let reason: StarvedReason | null = null;
  let want: number = target;

  if (target === 0) reason = 'off';

  // Capacity: batches in progress occupy slots.
  const free = Math.max(0, capacity - wipBatchCount(facility.wip));
  if (free < want) {
    want = free;
    reason = 'capacity';
  }

  // Storage: finished stock plus everything already in the pipeline must fit.
  const out = primaryOutput(recipe);
  const onHand = facility.outputs[out.product]?.quantity ?? 0;
  const fits = batchesThatFit(
    storageCapacity,
    onHand,
    pendingOutput(facility.wip, env.content.recipes, out.product),
    out.quantity,
  );
  if (fits < want) {
    want = fits;
    reason = 'storage_full';
  }

  // Inputs, bought just in time for `want` batches (cash-limited, ADR-014 discretionary).
  for (const line of recipe.inputs) {
    const lot = lotFor(facility.inputs, line.product);
    const need = want * line.quantity - lot.quantity;
    if (need > 0) {
      const cash = env.cash(facility.ownerId);
      const quote = env.quoteRaw(line.product, quantity(need));
      let buyQty = need;
      if (!canSpend(SPEND_CLASS.inventoryPurchase, cash, quote.total)) {
        buyQty = affordableUnits(cash, quote.unitPrice);
        reason = 'no_cash';
      }
      if (buyQty > 0) {
        const bought = env.buyRaw(facility.ownerId, line.product, quantity(buyQty));
        if (bought.total > 0) {
          env.post(
            facility.ownerId,
            inventoryPurchase(bought.total, SOURCE, { ref: refOf(facility) }),
          );
        }
        receiveIntoLot(lot, buyQty, bought.total);
      }
    }
    const batchesFromStock = Math.floor(lot.quantity / line.quantity);
    if (batchesFromStock < want) {
      want = batchesFromStock;
      reason = 'no_inputs';
    }
  }

  // Direct labour is paid in cash at the start (discretionary).
  if (recipe.laborCostPerBatch > 0 && want > 0) {
    const cash = env.cash(facility.ownerId);
    const affordable = cash <= 0 ? 0 : Math.floor(cash / recipe.laborCostPerBatch);
    if (affordable < want) {
      want = affordable;
      reason = 'no_cash';
    }
  }

  if (want > 0) {
    let materials = ZERO_MONEY;
    for (const line of recipe.inputs) {
      materials = addMoney(
        materials,
        issueFromLot(lotFor(facility.inputs, line.product), want * line.quantity),
      );
    }
    const labor = mulMoney(recipe.laborCostPerBatch, want);
    const value = addMoney(materials, labor);
    if (value > 0) {
      env.post(
        facility.ownerId,
        productionStart(materials, labor, SOURCE, { ref: refOf(facility) }),
      );
    }
    insertWip(facility.wip, {
      recipeId: recipe.id,
      batches: quantity(want),
      startedTick: env.tick,
      completesTick: env.tick + recipe.durationTicks,
      value,
    });
  }

  if (want < target && reason !== null) {
    facility.starvedReason = reason;
    env.emit({
      type: 'production.starved',
      payload: {
        facilityId: facility.id,
        reason,
        wanted: target,
        started: quantity(want),
      },
    });
  } else if (reason === 'off') {
    facility.starvedReason = 'off';
  }
}

/** Step 5: daily operating cost, a period expense (non-discretionary; may take cash negative). */
export function chargeOperatingCost(
  facility: Facility,
  dailyCost: Money,
  env: ProductionEnv,
): void {
  if (dailyCost > 0) {
    env.post(
      facility.ownerId,
      cashPurchase(ACCOUNTS.OPEX_FACILITY, dailyCost, SOURCE, {
        memo: 'Facility operating cost',
        ref: refOf(facility),
      }),
    );
  }
}

/** Step 6: month-end straight-line depreciation (ADR-009), posted in this phase. */
export function chargeDepreciation(
  facility: Facility,
  usefulLifeMonths: number,
  env: ProductionEnv,
): void {
  if (!env.isMonthEnd) return;
  const charge = nextDepreciationCharge(
    facility.cost,
    usefulLifeMonths,
    facility.accumulatedDepreciation,
  );
  if (charge <= 0) return;
  env.post(facility.ownerId, depreciation(charge, SOURCE, { ref: refOf(facility) }));
  facility.accumulatedDepreciation = addMoney(facility.accumulatedDepreciation, charge);
}

/** The whole facility-day, in the order of section 5. */
export function runFacilityDay(facility: Facility, env: ProductionEnv): void {
  const type = env.content.facilityTypes[facility.typeId];
  if (type === undefined) {
    throw new InvariantError(
      'manufacturing.unknown_facility_type',
      `facility ${facility.id} has unknown type ${facility.typeId}`,
    );
  }
  if (advanceConstruction(facility, env.tick)) {
    env.emit({ type: 'facility.completed', payload: { facilityId: facility.id } });
  }
  if (facility.status !== 'operating') return;
  completeWip(facility, env);
  startBatches(facility, type.capacity, type.storageCapacity, env);
  chargeOperatingCost(facility, type.dailyOperatingCost, env);
  chargeDepreciation(facility, type.usefulLifeMonths, env);
}
