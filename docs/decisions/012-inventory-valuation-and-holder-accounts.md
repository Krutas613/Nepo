# ADR-012: Inventory is valued at moving weighted-average cost per holder lot; one ledger account per holder kind

**Status:** Accepted (Milestone 1 design)

## Context

Goods move raw -> work in progress -> finished (factory) -> shelf (store) -> sold. COGS must be
correct, inventory on the balance sheet must equal what the systems hold, and everything is integer.
FIFO layers are exact but grow state and complicate transfers; standard costing needs variances;
weighted average is exact with one `(quantity, value)` pair per lot if the split is done with
accounting's `allocateMoney`.

## Decision

- Every holding is an `InventoryLot { quantity: Quantity; value: Money; received: Quantity; issued: Quantity }`
  (schema `inventory.ts`). `value` is the total carrying cost of the lot, never a unit cost; the unit
  cost shown to players is derived.
- Receipt: `quantity += q; value += cost; received += q`. Issue of `n` units:
  `cost = allocateMoney(value, [n, quantity − n])[0]; quantity −= n; value −= cost; issued += n`.
  Issuing every unit therefore moves every minor unit of value; a lot with `quantity === 0` has
  `value === 0`. No unit-cost rounding ever accumulates.
- One general-ledger account per holder kind, so each system's lots reconcile to exactly one account:
  `1200` raw inputs at facilities (manufacturing), `1205` work in progress (manufacturing, **new**),
  `1210` finished goods at facilities (manufacturing), `1220` in transit (logistics, M2),
  `1230` merchandise on store shelves (retail, **new**). Accounting adds `1205` and `1230` to
  `STANDARD_CHART` (`INVENTORY_WIP`, `INVENTORY_MERCHANDISE`); both fall in the operating cash-flow
  range already.
- Movements are posted by the system whose lot is debited or credited, atomically with the lot change:
  `inventoryPurchase` (Dr 1200 / Cr 1000), `productionStart` (Dr 1205 / Cr 1200 materials, Cr 1000
  labour), `productionComplete` (Dr 1210 / Cr 1205), `internalTransfer` (Dr 1230 / Cr 1210, posted by
  manufacturing inside `withdraw`), `retailSale` (Dr 1000 / Cr 4000; Dr 5000 / Cr 1230),
  `inventoryWriteOff` (Dr 6900 / Cr holder account). A same-entity transfer moves value between
  sub-ledger accounts only; across entities (M2 subsidiaries) logistics posts an intercompany sale.
- Facility operating cost is a **period expense** (6000), not absorbed into inventory; unit cost of
  goods = materials + direct labour. "Full cost per unit" is a derived display metric.

## Consequences

- qa gets exact cross-system invariants per entity: `Σ raw lot value === balance(1200)`,
  `Σ wip value === balance(1205)`, `Σ finished lot value === balance(1210)`, `Σ shelf lot value === balance(1230)`,
  and per lot `received − issued === quantity`.
- `cashSale`/`creditSale` (which credit 1210) remain for factory-gate B2B sales in M2; retail uses
  `retailSale`.
- Absorption costing, FIFO layers or standard costing would be a new ADR; nothing in state precludes
  them because lots are the only valuation representation.
