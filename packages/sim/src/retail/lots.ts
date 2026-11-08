/**
 * Shelf-lot arithmetic (ADR-012). Pure functions over a plain `InventoryLot`: moving weighted-average
 * cost, `value` is the total carrying cost. Mutating helpers change the lot in place (the retail slice
 * is the one mutable thing in a handler); `lotInvariantErrors` is the read-only check.
 */
import { allocateMoney } from '../accounting/index.js';
import {
  InvariantError,
  addMoney,
  money,
  quantity,
  subMoney,
  type InventoryLot,
  type Money,
  type Quantity,
} from '../schema/index.js';

/** A fresh, mutable, all-zero lot. */
export function emptyLot(): InventoryLot {
  return { quantity: quantity(0), value: money(0), received: quantity(0), issued: quantity(0) };
}

/** Receipt: `quantity += q; value += cost; received += q`. Throws on `q < 0`, `cost < 0`, or cost without units. */
export function receiveInto(lot: InventoryLot, q: Quantity, cost: Money): void {
  if (!(q >= 0) || !(cost >= 0) || (q === 0 && cost > 0)) {
    throw new InvariantError(
      'retail.bad_receipt',
      'receipt needs q >= 0, cost >= 0, and units for any cost',
      {
        quantity: q,
        cost,
      },
    );
  }
  lot.quantity = quantity(lot.quantity + q);
  lot.value = addMoney(lot.value, cost);
  lot.received = quantity(lot.received + q);
}

/**
 * Issue of `n` units at moving weighted-average cost:
 * `cost = allocateMoney(value, [n, quantity - n])[0]`. Returns the cost removed from the lot.
 * Throws `InvariantError('retail.issue_exceeds_stock')` if `n > quantity`. Issuing everything moves
 * every minor unit of value.
 */
export function issueFrom(lot: InventoryLot, n: Quantity): Money {
  if (n > lot.quantity) {
    throw new InvariantError('retail.issue_exceeds_stock', `issue ${n} > on hand ${lot.quantity}`, {
      issue: n,
      onHand: lot.quantity,
    });
  }
  if (n === 0) return money(0);
  const cost = allocateMoney(lot.value, [n, lot.quantity - n])[0] ?? money(0);
  lot.quantity = quantity(lot.quantity - n);
  lot.value = subMoney(lot.value, cost);
  lot.issued = quantity(lot.issued + n);
  return cost;
}

/** Violations of the lot invariants (retail.md section 9, item 1); empty when the lot is sound. */
export function lotInvariantErrors(lot: Readonly<InventoryLot>): string[] {
  const errors: string[] = [];
  if (!(lot.quantity >= 0)) errors.push('quantity < 0');
  if (!(lot.value >= 0)) errors.push('value < 0');
  if (lot.received - lot.issued !== lot.quantity) errors.push('received - issued !== quantity');
  if (lot.quantity === 0 && lot.value !== 0) errors.push('empty lot has non-zero value');
  return errors;
}
