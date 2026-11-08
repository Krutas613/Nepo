/**
 * Manufacturing slice (docs/design/manufacturing.md section 3, ADR-012). Owned by the
 * `manufacturing` system: facilities, construction, work in progress and inventory lots.
 */
import { z } from 'zod';
import { deepFreeze } from './freeze.js';
import {
  CityIdSchema,
  CompanyIdSchema,
  FacilityIdSchema,
  FacilityTypeIdSchema,
  ProductIdSchema,
  RecipeIdSchema,
  type CityId,
  type CompanyId,
  type FacilityId,
  type FacilityTypeId,
  type ProductId,
  type RecipeId,
} from './ids.js';
import { InventoryLotSchema, type InventoryLot } from './inventory.js';
import { checkKeyedBy } from './keyed.js';
import {
  NonNegativeIntegerSchema,
  NonNegativeMoneySchema,
  QuantitySchema,
  type Money,
  type Quantity,
} from './money.js';

export type FacilityStatus = 'under_construction' | 'operating';

/** Why the last production day started fewer batches than `targetBatches` (UI). */
export type StarvedReason =
  | 'no_recipe'
  | 'off'
  | 'capacity'
  | 'storage_full'
  | 'no_inputs'
  | 'no_cash';

export interface WipBatch {
  recipeId: RecipeId;
  batches: Quantity;
  startedTick: number;
  completesTick: number;
  /** Materials + labour capitalised (reconciles to 1205). */
  value: Money;
}

/** A facility instance (its definition is the content `FacilityType` named by `typeId`). */
export interface Facility {
  id: FacilityId;
  ownerId: CompanyId;
  typeId: FacilityTypeId;
  cityId: CityId;
  status: FacilityStatus;
  orderedTick: number;
  completesTick: number;
  recipeId: RecipeId | null;
  /** 0 = off; <= the type's capacity. */
  targetBatches: Quantity;
  /** Ascending `completesTick` (FIFO). */
  wip: WipBatch[];
  /** Raw inputs (1200). */
  inputs: Record<ProductId, InventoryLot>;
  /** Finished goods (1210). */
  outputs: Record<ProductId, InventoryLot>;
  /** Capitalised build cost (PP&E record). */
  cost: Money;
  accumulatedDepreciation: Money;
  starvedReason: StarvedReason | null;
}

export interface ManufacturingState {
  facilities: Record<FacilityId, Facility>;
}

/** Manufacturing slice with no facilities. Deep-frozen: install a copy. */
export const EMPTY_MANUFACTURING_STATE: ManufacturingState = deepFreeze({ facilities: {} });

// ---------------------------------------------------------------------------------------------
// zod validators
// ---------------------------------------------------------------------------------------------

export const FacilityStatusSchema = z.enum([
  'under_construction',
  'operating',
]) satisfies z.ZodType<FacilityStatus>;

export const StarvedReasonSchema = z.enum([
  'no_recipe',
  'off',
  'capacity',
  'storage_full',
  'no_inputs',
  'no_cash',
]) satisfies z.ZodType<StarvedReason>;

export const WipBatchSchema = z.strictObject({
  recipeId: RecipeIdSchema,
  batches: QuantitySchema,
  startedTick: NonNegativeIntegerSchema,
  completesTick: NonNegativeIntegerSchema,
  value: NonNegativeMoneySchema,
}) satisfies z.ZodType<WipBatch>;

export const FacilitySchema = z
  .strictObject({
    id: FacilityIdSchema,
    ownerId: CompanyIdSchema,
    typeId: FacilityTypeIdSchema,
    cityId: CityIdSchema,
    status: FacilityStatusSchema,
    orderedTick: NonNegativeIntegerSchema,
    completesTick: NonNegativeIntegerSchema,
    recipeId: RecipeIdSchema.nullable(),
    targetBatches: QuantitySchema,
    wip: z.array(WipBatchSchema),
    inputs: z.record(ProductIdSchema, InventoryLotSchema),
    outputs: z.record(ProductIdSchema, InventoryLotSchema),
    cost: NonNegativeMoneySchema,
    accumulatedDepreciation: NonNegativeMoneySchema,
    starvedReason: StarvedReasonSchema.nullable(),
  })
  .superRefine((facility, ctx) => {
    for (let i = 1; i < facility.wip.length; i++) {
      const prev = facility.wip[i - 1];
      const batch = facility.wip[i];
      if (prev !== undefined && batch !== undefined && batch.completesTick < prev.completesTick) {
        ctx.addIssue({
          code: 'custom',
          path: ['wip', i, 'completesTick'],
          message: 'wip must be in ascending completesTick order',
        });
      }
    }
  }) satisfies z.ZodType<Facility>;

export const ManufacturingStateSchema = z
  .strictObject({
    facilities: z.record(FacilityIdSchema, FacilitySchema),
  })
  .superRefine((state, ctx) => {
    checkKeyedBy(state.facilities, 'id', (f) => f.id, ['facilities'], ctx);
  }) satisfies z.ZodType<ManufacturingState>;
