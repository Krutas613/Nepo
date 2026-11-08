/**
 * Pure facility helpers (docs/design/manufacturing.md sections 3, 4, 5.6): construction, build
 * previews for the UI, straight-line depreciation and storage planning. Nothing here touches the
 * engine, the ledger or the economy.
 */
import { allocateMoney } from '../accounting/index.js';
import type { DeepReadonly } from '../engine/index.js';
import {
  ZERO_MONEY,
  ZERO_QUANTITY,
  addMoney,
  money,
  type CityId,
  type CompanyId,
  type ContentPack,
  type Facility,
  type FacilityId,
  type FacilityType,
  type FacilityTypeId,
  type Money,
  type ProductId,
  type Quantity,
  type Recipe,
} from '../schema/index.js';

/** The slice of the content pack manufacturing reads. */
export type ManufacturingContent = DeepReadonly<
  Pick<ContentPack, 'products' | 'recipes' | 'facilityTypes' | 'cities'>
>;

// ---------------------------------------------------------------------------------------------
// Previews (UI; player-flow.md: domain barrels expose pure preview helpers)
// ---------------------------------------------------------------------------------------------

/** What building a facility of a type costs and how long it takes; `null` for an unknown type. */
export interface BuildPreview {
  facilityTypeId: FacilityTypeId;
  buildCost: Money;
  constructionTicks: number;
  dailyOperatingCost: Money;
  capacity: Quantity;
  storageCapacity: Quantity;
  usefulLifeMonths: number;
  /** Straight-line depreciation of the first month (the schedule's first charge). */
  firstMonthDepreciation: Money;
}

export function previewBuild(
  content: Pick<ManufacturingContent, 'facilityTypes'>,
  typeId: FacilityTypeId,
): BuildPreview | null {
  const type = content.facilityTypes[typeId];
  if (type === undefined) return null;
  return {
    facilityTypeId: typeId,
    buildCost: type.buildCost,
    constructionTicks: type.constructionTicks,
    dailyOperatingCost: type.dailyOperatingCost,
    capacity: type.capacity,
    storageCapacity: type.storageCapacity,
    usefulLifeMonths: type.usefulLifeMonths,
    firstMonthDepreciation: nextDepreciationCharge(
      type.buildCost,
      type.usefulLifeMonths,
      ZERO_MONEY,
    ),
  };
}

/** Cost of building a facility of `typeId`, or `null` if the type is unknown. */
export function previewBuildCost(
  content: Pick<ManufacturingContent, 'facilityTypes'>,
  typeId: FacilityTypeId,
): Money | null {
  return content.facilityTypes[typeId]?.buildCost ?? null;
}

/** Tick at which a facility ordered at `orderedTick` finishes construction. */
export function constructionCompletesTick(
  orderedTick: number,
  type: DeepReadonly<FacilityType>,
): number {
  return orderedTick + type.constructionTicks;
}

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

export interface NewFacilityArgs {
  id: FacilityId;
  ownerId: CompanyId;
  type: DeepReadonly<FacilityType>;
  cityId: CityId;
  orderedTick: number;
}

/** A facility just ordered: under construction, no recipe, off, capitalised at the type's build cost. */
export function newFacility(args: NewFacilityArgs): Facility {
  return {
    id: args.id,
    ownerId: args.ownerId,
    typeId: args.type.id,
    cityId: args.cityId,
    status: 'under_construction',
    orderedTick: args.orderedTick,
    completesTick: constructionCompletesTick(args.orderedTick, args.type),
    recipeId: null,
    targetBatches: ZERO_QUANTITY,
    wip: [],
    inputs: {},
    outputs: {},
    cost: args.type.buildCost,
    accumulatedDepreciation: ZERO_MONEY,
    starvedReason: null,
  };
}

/**
 * Advances construction: returns `true` exactly when the facility becomes operating on `tick`
 * (and mutates its status). A facility already operating, or not yet due, returns `false`.
 */
export function advanceConstruction(facility: Facility, tick: number): boolean {
  if (facility.status !== 'under_construction' || tick < facility.completesTick) return false;
  facility.status = 'operating';
  return true;
}

// ---------------------------------------------------------------------------------------------
// Depreciation (ADR-009: posted by manufacturing in `production` on `isMonthEnd`)
// ---------------------------------------------------------------------------------------------

/**
 * The next monthly straight-line charge for an asset of `cost` over `usefulLifeMonths` that has
 * already depreciated `accumulated`.
 *
 * The schedule is `allocateMoney(cost, [1 x life])`: `life` charges that differ by at most one minor
 * unit and sum to `cost` exactly, so the asset is fully depreciated after exactly `life` charges
 * (rounding each month independently with `scaleMoney` would finish a month early or late for some
 * costs). The charge is the amount that brings `accumulated` to the next schedule boundary above it,
 * so the function needs no month counter and is correct for any `accumulated` that is on, or
 * between, schedule boundaries. Returns 0 once `accumulated >= cost`.
 */
export function nextDepreciationCharge(
  cost: Money,
  usefulLifeMonths: number,
  accumulated: Money,
): Money {
  if (accumulated >= cost || cost <= 0) return ZERO_MONEY;
  const parts = allocateMoney(cost, new Array<number>(usefulLifeMonths).fill(1));
  let cumulative = ZERO_MONEY;
  for (const part of parts) {
    cumulative = addMoney(cumulative, part);
    if (cumulative > accumulated) return money(cumulative - accumulated);
  }
  return money(cost - accumulated);
}

/** The full depreciation schedule (for tests and previews): `life` charges summing to `cost`. */
export function depreciationSchedule(cost: Money, usefulLifeMonths: number): Money[] {
  if (cost <= 0) return [];
  return allocateMoney(cost, new Array<number>(usefulLifeMonths).fill(1)).filter((m) => m > 0);
}

// ---------------------------------------------------------------------------------------------
// Storage planning (section 5.3)
// ---------------------------------------------------------------------------------------------

/** The primary output line (`outputs[0]`) of a recipe. */
export function primaryOutput(recipe: DeepReadonly<Recipe>): {
  product: ProductId;
  quantity: Quantity;
} {
  const line = recipe.outputs[0];
  if (line === undefined) {
    throw new Error(`recipe ${recipe.id} has no outputs`); // content validation forbids this
  }
  return line;
}

/**
 * Units of `productId` already committed by work in progress: `Σ batches x primaryOutQty` over the
 * wip batches whose recipe's primary output is `productId`. Each batch counts at its own recipe's
 * quantity, so a recipe change mid-flight is accounted for.
 */
export function pendingOutput(
  wip: readonly DeepReadonly<Facility['wip'][number]>[],
  recipes: ManufacturingContent['recipes'],
  productId: ProductId,
): number {
  let total = 0;
  for (const batch of wip) {
    const recipe = recipes[batch.recipeId];
    if (recipe === undefined) continue;
    const out = primaryOutput(recipe);
    if (out.product === productId) total += batch.batches * out.quantity;
  }
  return total;
}

/** Batches of a recipe whose primary output still fits in `storageCapacity` (never negative). */
export function batchesThatFit(
  storageCapacity: number,
  onHand: number,
  pending: number,
  outQtyPerBatch: number,
): number {
  const room = Math.max(0, storageCapacity - onHand - pending);
  return Math.floor(room / outQtyPerBatch);
}

/** Σ batches in progress. */
export function wipBatchCount(wip: readonly { batches: number }[]): number {
  let n = 0;
  for (const b of wip) n += b.batches;
  return n;
}
