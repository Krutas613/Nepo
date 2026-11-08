/**
 * Manufacturing invariant checker for tests and sim-tests (docs/design/manufacturing.md section 10).
 * Read-only.
 *
 * What needs which input:
 * - Lot arithmetic (invariant 1) and the depreciation / target bounds that need no content: state only.
 * - Capacity, storage and `targetBatches <= capacity` (invariant 3) need the content pack; they are
 *   skipped when `content` is omitted.
 * - Ledger reconciliation (invariant 2) needs the accounting slice: per entity, `Σ inputs.value ===
 *   balance(a1200)`, `Σ wip.value === balance(a1205)`, `Σ outputs.value === balance(a1210)`. Only
 *   manufacturing posts to those accounts (retail's merchandise is a1230, and the transfer in
 *   `withdraw` debits a1230 and credits a1210 atomically with the lot change), so the equality is exact.
 *   It is skipped when `state.accounting` is omitted.
 * - PP&E (invariant 4) spans manufacturing and retail, so qa combines `ppeByEntity(state)` with the
 *   retail equivalent and compares to a1500 / a1590 (see `ppeByEntity`).
 * - Goods conservation (invariant 5) is `received - issued === quantity` per lot, checked here.
 */
import { sortedKeys, type DeepReadonly } from '../engine/index.js';
import {
  ZERO_MONEY,
  addMoney,
  type AccountingState,
  type CompanyId,
  type ContentPack,
  type FacilityId,
  type InventoryLot,
  type ManufacturingState,
  type Money,
  type ProductId,
  type AccountCode,
} from '../schema/index.js';
import { ACCOUNTS } from '../accounting/index.js';
import { pendingOutput, primaryOutput, wipBatchCount } from './facility.js';

export type ManufacturingInvariantCode =
  | 'lot.not_integer'
  | 'lot.negative_quantity'
  | 'lot.negative_value'
  | 'lot.conservation'
  | 'lot.empty_has_value'
  | 'wip.invalid'
  | 'facility.over_capacity'
  | 'facility.storage_exceeded'
  | 'facility.target_exceeds_capacity'
  | 'facility.depreciation_bounds'
  | 'facility.construction_overdue'
  | 'facility.unknown_type'
  | 'ledger.inputs_mismatch'
  | 'ledger.wip_mismatch'
  | 'ledger.outputs_mismatch';

export interface ManufacturingInvariantViolation {
  code: ManufacturingInvariantCode;
  facilityId?: FacilityId;
  productId?: ProductId;
  companyId?: CompanyId;
  message: string;
}

/** What the checker reads of the world. `accounting` is optional (ledger reconciliation). */
export interface ManufacturingInvariantInput {
  readonly tick: number;
  readonly manufacturing: DeepReadonly<ManufacturingState>;
  readonly accounting?: DeepReadonly<AccountingState>;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

function checkLot(
  lot: DeepReadonly<InventoryLot>,
  where: string,
  facilityId: FacilityId,
  productId: ProductId,
  out: ManufacturingInvariantViolation[],
): void {
  const at = { facilityId, productId };
  if (![lot.quantity, lot.value, lot.received, lot.issued].every(isInt)) {
    out.push({ code: 'lot.not_integer', ...at, message: `${where}: non-integer lot field` });
    return;
  }
  if (lot.quantity < 0) {
    out.push({
      code: 'lot.negative_quantity',
      ...at,
      message: `${where}: quantity ${String(lot.quantity)}`,
    });
  }
  if (lot.value < 0) {
    out.push({
      code: 'lot.negative_value',
      ...at,
      message: `${where}: value ${String(lot.value)}`,
    });
  }
  if (lot.received - lot.issued !== lot.quantity) {
    out.push({
      code: 'lot.conservation',
      ...at,
      message: `${where}: received ${String(lot.received)} - issued ${String(lot.issued)} !== quantity ${String(lot.quantity)}`,
    });
  }
  if (lot.quantity === 0 && lot.value !== 0) {
    out.push({
      code: 'lot.empty_has_value',
      ...at,
      message: `${where}: empty lot carries value ${String(lot.value)}`,
    });
  }
}

/** Per-entity PP&E of manufacturing facilities, for qa to combine with retail's stores. */
export function ppeByEntity(
  manufacturing: DeepReadonly<ManufacturingState>,
): Record<CompanyId, { cost: Money; accumulatedDepreciation: Money }> {
  const out: Record<CompanyId, { cost: Money; accumulatedDepreciation: Money }> = {};
  for (const id of sortedKeys(manufacturing.facilities)) {
    const f = manufacturing.facilities[id];
    if (f === undefined) continue;
    const row = (out[f.ownerId] ??= { cost: ZERO_MONEY, accumulatedDepreciation: ZERO_MONEY });
    row.cost = addMoney(row.cost, f.cost);
    row.accumulatedDepreciation = addMoney(row.accumulatedDepreciation, f.accumulatedDepreciation);
  }
  return out;
}

export function checkManufacturingInvariants(
  state: ManufacturingInvariantInput,
  content?: DeepReadonly<Pick<ContentPack, 'recipes' | 'facilityTypes'>>,
): ManufacturingInvariantViolation[] {
  const out: ManufacturingInvariantViolation[] = [];
  const facilities = state.manufacturing.facilities;
  const sums: Record<CompanyId, { inputs: Money; wip: Money; outputs: Money }> = {};

  for (const id of sortedKeys(facilities)) {
    const f = facilities[id];
    if (f === undefined) continue;
    const row = (sums[f.ownerId] ??= { inputs: ZERO_MONEY, wip: ZERO_MONEY, outputs: ZERO_MONEY });

    for (const p of sortedKeys(f.inputs)) {
      const lot = f.inputs[p];
      if (lot === undefined) continue;
      checkLot(lot, `inputs[${p}]`, id, p, out);
      if (isInt(lot.value)) row.inputs = addMoney(row.inputs, lot.value);
    }
    for (const p of sortedKeys(f.outputs)) {
      const lot = f.outputs[p];
      if (lot === undefined) continue;
      checkLot(lot, `outputs[${p}]`, id, p, out);
      if (isInt(lot.value)) row.outputs = addMoney(row.outputs, lot.value);
    }
    f.wip.forEach((batch, i) => {
      const ok =
        isInt(batch.batches) &&
        batch.batches >= 1 &&
        isInt(batch.value) &&
        batch.value >= 0 &&
        batch.completesTick >= batch.startedTick &&
        (i === 0 || batch.completesTick >= (f.wip[i - 1]?.completesTick ?? 0));
      if (ok) row.wip = addMoney(row.wip, batch.value);
      else
        out.push({
          code: 'wip.invalid',
          facilityId: id,
          message: `wip[${String(i)}] is malformed`,
        });
    });

    if (f.accumulatedDepreciation < 0 || f.accumulatedDepreciation > f.cost) {
      out.push({
        code: 'facility.depreciation_bounds',
        facilityId: id,
        message: `accumulatedDepreciation ${String(f.accumulatedDepreciation)} outside 0..${String(f.cost)}`,
      });
    }
    // Checked after a step: `state.tick` is then the next tick to run, and a facility due at
    // `completesTick` was promoted during that tick's production phase.
    if (f.status === 'under_construction' && state.tick > f.completesTick) {
      out.push({
        code: 'facility.construction_overdue',
        facilityId: id,
        message: `still under construction at tick ${String(state.tick)}, due ${String(f.completesTick)}`,
      });
    }

    if (content === undefined) continue;
    const type = content.facilityTypes[f.typeId];
    if (type === undefined) {
      out.push({
        code: 'facility.unknown_type',
        facilityId: id,
        message: `unknown type ${f.typeId}`,
      });
      continue;
    }
    if (wipBatchCount(f.wip) > type.capacity) {
      out.push({
        code: 'facility.over_capacity',
        facilityId: id,
        message: `${String(wipBatchCount(f.wip))} batches in progress, capacity ${String(type.capacity)}`,
      });
    }
    if (f.targetBatches > type.capacity) {
      out.push({
        code: 'facility.target_exceeds_capacity',
        facilityId: id,
        message: `target ${String(f.targetBatches)} > capacity ${String(type.capacity)}`,
      });
    }
    // Storage: every product that is a primary output of the current or an in-flight recipe.
    const primaries = new Set<ProductId>();
    const current = f.recipeId === null ? undefined : content.recipes[f.recipeId];
    if (current !== undefined) primaries.add(primaryOutput(current).product);
    for (const batch of f.wip) {
      const recipe = content.recipes[batch.recipeId];
      if (recipe !== undefined) primaries.add(primaryOutput(recipe).product);
    }
    for (const p of [...primaries].sort()) {
      const held = f.outputs[p]?.quantity ?? 0;
      const total = held + pendingOutput(f.wip, content.recipes, p);
      if (total > type.storageCapacity) {
        out.push({
          code: 'facility.storage_exceeded',
          facilityId: id,
          productId: p,
          message: `${String(held)} on hand + pending exceeds storage ${String(type.storageCapacity)}`,
        });
      }
    }
  }

  if (state.accounting !== undefined) {
    const entities = state.accounting.entities;
    const owners = new Set<CompanyId>([...Object.keys(sums)] as CompanyId[]);
    for (const id of sortedKeys(entities)) owners.add(id);
    for (const owner of [...owners].sort()) {
      const row = sums[owner] ?? { inputs: ZERO_MONEY, wip: ZERO_MONEY, outputs: ZERO_MONEY };
      const ledger = entities[owner];
      if (ledger === undefined) continue;
      const bal = (code: AccountCode): Money => ledger.accounts[code]?.balance ?? ZERO_MONEY;
      const pairs = [
        ['ledger.inputs_mismatch', 'inputs', row.inputs, bal(ACCOUNTS.INVENTORY_RAW)],
        ['ledger.wip_mismatch', 'wip', row.wip, bal(ACCOUNTS.INVENTORY_WIP)],
        ['ledger.outputs_mismatch', 'outputs', row.outputs, bal(ACCOUNTS.INVENTORY_FINISHED)],
      ] as const;
      for (const [code, what, lots, balance] of pairs) {
        if (lots !== balance) {
          out.push({
            code,
            companyId: owner,
            message: `${what}: Σ lot value ${String(lots)} !== ledger balance ${String(balance)}`,
          });
        }
      }
    }
  }
  return out;
}
