# ADR-013: M1 restocks stores by direct transfer inside retail's `market` handler; logistics replaces the call in M2

**Status:** Accepted (Milestone 1 design)

## Context

M1 has one factory and one store in one city and no logistics system. Goods must still reach the
shelf with correct inventory accounting. Options: (a) retail registers a `logistics`-phase handler
that pulls from factories; (b) retail pulls from factories at the start of its own `market` handler,
immediately before selling; (c) build a minimal logistics system now.

## Decision

Option (b).

- Retail's `market` handler runs, per store in `sortedKeys` order, **restock then sell**. Restock
  calls `ManufacturingApi.withdraw(ownerId, facilityId, productId, quantity, ACCOUNTS.INVENTORY_MERCHANDISE)`,
  which removes the units from the facility's finished lot, posts `internalTransfer(cost)`
  (Dr 1230 / Cr 1210) with `source: 'manufacturing'`, and returns `{ quantity, cost }`; retail then
  receives the units into the shelf lot at `cost`. Lead time is zero; the source facility must belong
  to the same company and be in the same city (`store.set_restock_policy` rejects otherwise).
- Retail does not register the `logistics` phase, and the phase table does not change. The
  manufacturing service is the only cross-system call; its posting is atomic with the lot change.
- M2 replaces exactly one step: restock becomes `LogisticsApi.requestTransfer(...)` (goods go to 1220
  in transit, arrive in the `logistics` phase of a later tick, and logistics calls
  `RetailApi.receive(storeId, productId, quantity, cost)` to land them on the shelf). `receive` is
  therefore part of `RetailApi` from M1 so the M2 change is confined to retail's restock step and
  the new logistics module.

## Consequences

- Same-day availability of today's production on today's shelf (production phase precedes market).
  A design limitation accepted for M1; M2 lead times make it realistic.
- No `logistics` slice, no shipments, no transit account activity in M1; invariant 4 (goods
  conservation) runs against manufacturing's and retail's checkers only.
- The `store.set_restock_policy` command shape (`sourceFacilityId`, `targetStock`) is kept in M2 and
  gains routing fields additively.
