/**
 * Inventory lot arithmetic (ADR-012), pure and engine-free.
 *
 * A lot is valued at moving weighted-average cost. Receipt: `quantity += q; value += cost;
 * received += q`. Issue of `n`: `cost = allocateMoney(value, [n, quantity - n])[0]`, then
 * `quantity -= n; value -= cost; issued += n`. Issuing every unit therefore moves every minor unit
 * of value, and no unit-cost rounding ever accumulates.
 */
import { allocateMoney } from '../accounting/index.js';
import {
  InvariantError,
  ZERO_MONEY,
  ZERO_QUANTITY,
  addMoney,
  money,
  quantity,
  subMoney,
  type InventoryLot,
  type Money,
  type ProductId,
} from '../schema/index.js';

/** A fresh all-zero lot (a mutable copy; the schema's `EMPTY_LOT` is frozen). */
export function emptyLot(): InventoryLot {
  return {
    quantity: ZERO_QUANTITY,
    value: ZERO_MONEY,
    received: ZERO_QUANTITY,
    issued: ZERO_QUANTITY,
  };
}

/** The lot for `productId`, creating an empty one in `lots` if absent. */
export function lotFor(lots: Record<ProductId, InventoryLot>, productId: ProductId): InventoryLot {
  const existing = lots[productId];
  if (existing !== undefined) return existing;
  const created = emptyLot();
  lots[productId] = created;
  return created;
}

/**
 * Cost of issuing `qty` units from a lot, without mutating it. `qty` must be an integer in
 * `0..lot.quantity` (`InvariantError('manufacturing.lot_overissue')` otherwise).
 */
export function issueCost(lot: Readonly<InventoryLot>, qty: number): Money {
  if (!Number.isSafeInteger(qty) || qty < 0 || qty > lot.quantity) {
    throw new InvariantError(
      'manufacturing.lot_overissue',
      `cannot issue ${String(qty)} from a lot of ${String(lot.quantity)}`,
      {
        qty,
        onHand: lot.quantity,
      },
    );
  }
  if (qty === 0) return ZERO_MONEY;
  if (qty === lot.quantity) return lot.value;
  return allocateMoney(lot.value, [qty, lot.quantity - qty])[0] ?? ZERO_MONEY;
}

/** Receives `qty` units at total `cost` (mutates). A zero-quantity receipt must be free. */
export function receiveIntoLot(lot: InventoryLot, qty: number, cost: Money): void {
  if (!Number.isSafeInteger(qty) || qty < 0 || cost < 0 || (qty === 0 && cost !== 0)) {
    throw new InvariantError(
      'manufacturing.lot_bad_receipt',
      `bad receipt of ${String(qty)} units at ${String(cost)}`,
      {
        qty,
        cost,
      },
    );
  }
  lot.quantity = quantity(lot.quantity + qty);
  lot.value = addMoney(lot.value, cost);
  lot.received = quantity(lot.received + qty);
}

/** Issues `qty` units (mutates) and returns their cost, `issueCost` of the pre-issue lot. */
export function issueFromLot(lot: InventoryLot, qty: number): Money {
  const cost = issueCost(lot, qty);
  lot.quantity = quantity(lot.quantity - qty);
  lot.value = money(subMoney(lot.value, cost));
  lot.issued = quantity(lot.issued + qty);
  return cost;
}

/** Derived unit cost for display only (float, never stored): `value / quantity`, or `null` if empty. */
export function unitCostOf(lot: Readonly<InventoryLot>): number | null {
  return lot.quantity === 0 ? null : lot.value / lot.quantity;
}

/** Σ lot values over a lots record, in sorted-key order. */
export function totalLotValue(lots: Readonly<Record<string, Readonly<InventoryLot>>>): Money {
  let total = ZERO_MONEY;
  for (const key of Object.keys(lots).sort()) {
    const lot = lots[key];
    if (lot !== undefined) total = addMoney(total, lot.value);
  }
  return total;
}
