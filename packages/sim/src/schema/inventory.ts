/**
 * Inventory lots (ADR-012), shared by manufacturing (inputs, finished output) and retail (shelves).
 *
 * A lot is valued at moving weighted-average cost: `value` is the total carrying cost, never a unit
 * cost. Receipt: `quantity += q; value += cost; received += q`. Issue of `n`:
 * `cost = allocateMoney(value, [n, quantity - n])[0]; quantity -= n; value -= cost; issued += n`.
 */
import { z } from 'zod';
import { deepFreeze } from './freeze.js';
import {
  NonNegativeMoneySchema,
  QuantitySchema,
  ZERO_MONEY,
  ZERO_QUANTITY,
  type Money,
  type Quantity,
} from './money.js';

export interface InventoryLot {
  /** Units on hand. */
  quantity: Quantity;
  /** Total carrying cost of the units on hand; >= 0. */
  value: Money;
  /** Cumulative units received. */
  received: Quantity;
  /** Cumulative units issued (sold, transferred, consumed, written off). */
  issued: Quantity;
}

/** Validates a lot: `value >= 0` and `received - issued === quantity`. */
export const InventoryLotSchema = z
  .strictObject({
    quantity: QuantitySchema,
    value: NonNegativeMoneySchema,
    received: QuantitySchema,
    issued: QuantitySchema,
  })
  .refine((lot) => lot.received - lot.issued === lot.quantity, {
    message: 'received - issued must equal quantity',
    path: ['quantity'],
  }) satisfies z.ZodType<InventoryLot>;

/** All-zero lot. Deep-frozen: copy it (`{ ...EMPTY_LOT }`) before mutating. */
export const EMPTY_LOT: InventoryLot = deepFreeze({
  quantity: ZERO_QUANTITY,
  value: ZERO_MONEY,
  received: ZERO_QUANTITY,
  issued: ZERO_QUANTITY,
});
