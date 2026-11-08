/**
 * `ManufacturingApi` (docs/design/manufacturing.md section 6, ADR-007/012/013), registered under
 * `MANUFACTURING_SERVICE`.
 *
 * Ownership rule (ARCHITECTURE.md section 6.2): `handle.slice()` is a mutation declaration, so only
 * `withdraw` calls it; every read goes through `handle.state().manufacturing`.
 */
import {
  createServiceKey,
  sortedKeys,
  type DeepReadonly,
  type ServiceHandle,
  type ServiceKey,
} from '../engine/index.js';
import { ACCOUNTING_SERVICE, internalTransfer } from '../accounting/index.js';
import {
  InvariantError,
  err,
  ok,
  quantity,
  type AccountCode,
  type CityId,
  type CompanyId,
  type Facility,
  type FacilityId,
  type ManufacturingState,
  type Money,
  type ProductId,
  type Quantity,
  type Result,
} from '../schema/index.js';
import { issueCost, issueFromLot } from './lots.js';

export type WithdrawErrorCode =
  | 'unknown_facility'
  | 'not_owner'
  | 'not_operating'
  | 'unknown_product'
  | 'invalid_quantity'
  | 'insufficient';

export interface WithdrawError {
  code: WithdrawErrorCode;
  message: string;
}

export interface Withdrawal {
  facilityId: FacilityId;
  productId: ProductId;
  quantity: Quantity;
  /** Carrying cost moved out of the finished-goods lot (moving weighted average). */
  cost: Money;
}

export interface ManufacturingApi {
  /** Read: a facility, or `null`. */
  facility(facilityId: FacilityId): DeepReadonly<Facility> | null;
  /** Read: `outputs[productId].quantity`, or 0. */
  availableOutput(facilityId: FacilityId, productId: ProductId): Quantity;
  /** Read: ids of the owner's facilities (optionally in one city), sorted. */
  facilitiesOf(ownerId: CompanyId, cityId?: CityId): readonly FacilityId[];
  /**
   * Write (M1 caller: retail in `market`; M2: logistics). Removes `quantity` units from the
   * facility's finished lot at moving weighted-average cost and posts
   * `internalTransfer(cost, destinationAccount)` (Dr destination / Cr 1210) atomically.
   *
   * Validation, in order: `unknown_facility`, `not_owner` (facility owner !== `ownerId`),
   * `not_operating`, `unknown_product` (no finished lot for the product), `invalid_quantity`
   * (not an integer >= 1), `insufficient` (more than on hand). A zero-cost issue (free goods) skips
   * the posting. Returns `{ quantity, cost }`; changes nothing on error.
   */
  withdraw(
    ownerId: CompanyId,
    facilityId: FacilityId,
    productId: ProductId,
    quantity: Quantity,
    destinationAccount: AccountCode,
  ): Result<Withdrawal, WithdrawError>;
}

export const MANUFACTURING_SERVICE: ServiceKey<ManufacturingApi> =
  createServiceKey<ManufacturingApi>('manufacturing');

export function createManufacturingApi(
  handle: ServiceHandle<ManufacturingState>,
): ManufacturingApi {
  /** Read-only view for queries; never `handle.slice()`. */
  const view = () => handle.state().manufacturing;

  return {
    facility(facilityId) {
      return view().facilities[facilityId] ?? null;
    },
    availableOutput(facilityId, productId) {
      return view().facilities[facilityId]?.outputs[productId]?.quantity ?? quantity(0);
    },
    facilitiesOf(ownerId, cityId) {
      const facilities = view().facilities;
      return sortedKeys(facilities).filter((id) => {
        const f = facilities[id];
        return f?.ownerId === ownerId && (cityId === undefined || f.cityId === cityId);
      });
    },
    withdraw(ownerId, facilityId, productId, qty, destinationAccount) {
      const fail = (code: WithdrawErrorCode, message: string) => err({ code, message });
      // Validate on the read-only view first; only a successful withdrawal declares a mutation.
      const seen = view().facilities[facilityId];
      if (seen === undefined) return fail('unknown_facility', `unknown facility ${facilityId}`);
      if (seen.ownerId !== ownerId) {
        return fail('not_owner', `${ownerId} does not own ${facilityId}`);
      }
      if (seen.status !== 'operating') {
        return fail('not_operating', `${facilityId} is still under construction`);
      }
      const seenLot = seen.outputs[productId];
      if (seenLot === undefined) {
        return fail('unknown_product', `${facilityId} holds no ${productId}`);
      }
      if (!Number.isSafeInteger(qty) || qty < 1) {
        return fail('invalid_quantity', `quantity must be an integer >= 1, got ${String(qty)}`);
      }
      if (qty > seenLot.quantity) {
        return fail(
          'insufficient',
          `${facilityId} has ${String(seenLot.quantity)} ${productId}, wanted ${String(qty)}`,
        );
      }
      const facility = handle.slice().facilities[facilityId];
      const lot = facility?.outputs[productId];
      if (facility === undefined || lot === undefined) {
        throw new InvariantError(
          'manufacturing.withdraw_state',
          'facility vanished during withdraw',
        );
      }
      // Post first (a failure throws and poisons the world), then mutate: atomic from the caller's view.
      const cost = issueCost(lot, qty);
      if (cost > 0) {
        handle.services.get(ACCOUNTING_SERVICE).postOrThrow(
          ownerId,
          internalTransfer(cost, destinationAccount, 'manufacturing', {
            ref: { kind: 'facility', id: facilityId },
          }),
        );
      }
      issueFromLot(lot, qty);
      return ok({ facilityId, productId, quantity: qty, cost });
    },
  };
}
