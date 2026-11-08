# Retail design (Milestone 1)

Owner of the code: `retail` (`packages/sim/src/retail`). Companion to ARCHITECTURE.md sections 6, 8
and ADR-011/012/013/014. Types live in `schema/` (`docs/design/schema-m1.md`). M1 scope: one store
format, stores in one city selling one consumer product restocked from the owner's own factory in
the same city.

## 1. Purpose and boundaries

Retail owns stores, shelf lots, pricing and restock policies, daily sales and the postings for
them. It reads `ctx.scenario.content` (`storeFormats`, `products`, `cities`), calls
`ManufacturingApi.withdraw` to restock (M1, ADR-013), `EconomyApi.clearConsumerMarket` to sell, and
`AccountingApi` for every money movement. It exposes `RetailApi` (reads plus `receive`, the landing
point logistics will use in M2). It never touches another slice.

Phases: **`apply`** (commands) and **`market`** (restock, sales, shrinkage, opex, month-end depreciation).

## 2. Content (`data/store_formats.json`, type `StoreFormat`)

`id, name, buildCost: Money, constructionTicks: int >= 0, dailyOperatingCost: Money, shelfCapacity:
Quantity >= 1 (total units across all products), usefulLifeMonths: int >= 1, categories:
ProductCategory[] (>= 1; M1: ['consumer']), shrinkagePerMille: int 0..100 (units lost per day =
floor(stock × x / 1000); M1 data: 0)`.

## 3. State (`RetailState`, schema)

```ts
type StoreStatus = 'under_construction' | 'operating';
interface RestockPolicy {
  sourceFacilityId: FacilityId | null;
  targetStock: Quantity;
} // null = no restocking
interface ShelfLine {
  lot: InventoryLot; // account 1230
  price: Money | null; // null = sell at today's reference price
  restock: RestockPolicy;
  soldToday: Quantity;
  revenueToday: Money;
  unmetToday: Quantity; // today's results (reset at the start of the store's market step)
  shrunk: Quantity; // cumulative units written off (part of lot.issued)
}
interface Store {
  id: StoreId;
  ownerId: CompanyId;
  formatId: StoreFormatId;
  cityId: CityId;
  marketId: MarketId;
  status: StoreStatus;
  orderedTick: number;
  completesTick: number;
  shelves: Record<ProductId, ShelfLine>;
  cost: Money;
  accumulatedDepreciation: Money;
  brand: number; // placeholder 0 in M1 (passed to MarketOffer.brand)
}
interface RetailState {
  stores: Record<StoreId, Store>;
}
```

Invariant by construction: `Σ shelves[p].lot.quantity <= format.shelfCapacity`.

## 4. Commands (phase `apply`)

| Type                       | Payload                                                                               | Rejections (in order)                                                                                                                                                                                                     | Effect / event                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `store.build`              | `{ companyId, storeFormatId, cityId }`                                                | `not_owner`, `unknown_store_format`, `unknown_city`, `no_market` (economy.marketOfCity === null), `insufficient_cash`                                                                                                     | issue `StoreId`; post `capex(buildCost)`; `under_construction`, `completesTick = tick + constructionTicks`; emit `store.ordered` |
| `store.set_price`          | `{ storeId, productId, price: Money \| null }`                                        | `unknown_store`, `not_owner`, `unknown_product`, `category_not_allowed` (product.category not in format.categories), `invalid_price` (price !== null && price < 1)                                                        | create the shelf line if absent (empty lot, no restock); set `price`; emit `store.price_set`                                     |
| `store.set_restock_policy` | `{ storeId, productId, sourceFacilityId: FacilityId \| null, targetStock: Quantity }` | `unknown_store`, `not_owner`, `unknown_product`, `category_not_allowed`, `unknown_facility`, `facility_not_owner` (facility.ownerId !== issuer), `not_same_city`, `target_exceeds_capacity` (targetStock > shelfCapacity) | create the shelf line if absent; set `restock`; emit `store.restock_policy_set`                                                  |

Facility checks use `ManufacturingApi.facility(id)` (read). Shelf lines are never deleted in M1.

## 5. Market phase (per store in `sortedKeys(stores)`; per product in `sortedKeys(shelves)`)

1. **Construction.** If `under_construction` and `tick >= completesTick`: `status = 'operating'`,
   emit `store.opened`. A store under construction does nothing else.
2. **Reset** `soldToday = 0, revenueToday = 0, unmetToday = 0` for every line.
3. **Restock (ADR-013).** For each line with `restock.sourceFacilityId !== null`:
   `room = min(targetStock − lot.quantity, shelfCapacity − Σ lot.quantity over shelves)`;
   `avail = manufacturing.availableOutput(src, p)`; `q = min(room, avail)`; if `q >= 1`:
   `w = manufacturing.withdraw(ownerId, src, p, q, ACCOUNTS.INVENTORY_MERCHANDISE)`; on `ok` receive
   `w.quantity` at `w.cost` into the lot (manufacturing already posted Dr 1230 / Cr 1210) and emit
   `store.restocked { storeId, facilityId, productId, quantity, cost }`; on `err` with
   `not_owner`/`unknown_facility` (facility changed hands or vanished) set `restock.sourceFacilityId = null`
   and emit `store.restock_failed { storeId, productId, code }`; any other `err` is an `InvariantError`.
4. **Sales.** Group the operating stores of each `(marketId, productId)` with `lot.quantity > 0`
   in `sortedKeys(stores)` order into `offers: MarketOffer[]` with
   `price = line.price ?? economy.referencePrice(marketId, p)`, `quantity = lot.quantity`,
   `quality = 0`, `brand = store.brand`. Call `economy.clearConsumerMarket(marketId, p, offers)` once
   per group (groups in `sortedKeys(marketId)` then `sortedKeys(productId)` order). For each offer
   `i` with `sold_i > 0`: `revenue = mulMoney(price, sold_i)`; `cogs = allocateMoney(lot.value, [sold_i,
lot.quantity − sold_i])[0]`; issue `sold_i` from the lot; post `retailSale(revenue, cogs)` Dr 1000 /
   Cr 4000, Dr 5000 / Cr 1230 (`ref: { kind: 'store', id }`); `soldToday += sold_i`,
   `revenueToday += revenue`; `unmetToday = quantity_i === sold_i ? clearing.demandAfter : 0`
   (stockout signal); emit `store.sold { storeId, productId, quantity, revenue, cogs, price, referencePrice, stockout: boolean }`.
   Implementation note: steps 1-3 run for all stores first, then step 4 runs per group, so every
   store's shelf is final before any clearing (this is what makes the M2 multi-store split fair).
5. **Shrinkage.** If `format.shrinkagePerMille > 0`: `lost = floor(lot.quantity × perMille / 1000)`;
   if `lost >= 1`: `cost = allocateMoney(lot.value, [lost, remaining])[0]`; issue; `shrunk += lost`;
   post `inventoryWriteOff(ACCOUNTS.INVENTORY_MERCHANDISE, cost)` Dr 6900 / Cr 1230.
6. **Operating cost.** `cashPurchase(ACCOUNTS.OPEX_FACILITY, dailyOperatingCost)` if `> 0`
   (non-discretionary, ADR-014).
7. **Depreciation (ADR-009).** On `isMonthEnd`, same rule as facilities:
   `charge = min(scaleMoney(cost, 1 / usefulLifeMonths), cost − accumulated)`; post `depreciation(charge)`.

COGS correctness: the shelf lot's value is exactly what manufacturing credited out of 1210 on
transfer, so `Σ cogs + shelf value === Σ transfer cost` for the life of the store (ADR-012).

## 6. Service (`RETAIL_SERVICE: ServiceKey<RetailApi>`)

```ts
interface RetailApi {
  store(storeId: StoreId): DeepReadonly<Store> | null; // read
  storesOf(ownerId: CompanyId, cityId?: CityId): readonly StoreId[]; // read, sorted
  shelfQuantity(storeId: StoreId, productId: ProductId): Quantity; // read
  /** Lands goods on a shelf (M2 logistics arrivals). Caller has already posted the credit side; retail posts nothing. */
  receive(
    storeId: StoreId,
    productId: ProductId,
    quantity: Quantity,
    cost: Money,
    source: { kind: 'facility' | 'shipment'; id: string },
  ): Result<
    Quantity,
    { code: 'unknown_store' | 'no_shelf_line' | 'over_capacity' | 'not_operating'; message: string }
  >;
}
```

`receive` is used internally by step 3 in M1 (so the M2 path is already exercised) and returns the
accepted quantity (`over_capacity` is an error, not a partial accept: callers size the request with
`shelfQuantity` and the format's capacity).

## 7. Events

`store.ordered { storeId, companyId, storeFormatId, cityId, completesTick }`, `store.opened { storeId }`,
`store.price_set { storeId, productId, price }`, `store.restock_policy_set { storeId, productId, sourceFacilityId, targetStock }`,
`store.restocked { storeId, facilityId, productId, quantity, cost }`, `store.restock_failed { storeId, productId, code }`,
`store.sold { storeId, productId, quantity, revenue, cogs, price, referencePrice, stockout }`.

## 8. Determinism notes

No RNG in M1 (shrinkage is deterministic `floor`). All iteration via `sortedKeys`; offers are
built in that order and the economy sums floats in offer order. `cash` is read from accounting when
needed. Content from `ctx.scenario.content` only.

## 9. Invariants qa will check (`checkRetailInvariants(state: WorldState)`)

1. Every shelf lot: `quantity >= 0`, `value >= 0`, `received − issued === quantity`,
   `quantity === 0 ⇒ value === 0`; `shrunk <= issued`.
2. Per store: `Σ lot.quantity <= shelfCapacity`; `price === null || price >= 1`;
   `restock.targetStock <= shelfCapacity`; `0 <= accumulatedDepreciation <= cost`.
3. Per entity: `Σ shelf lot.value === balance(1230)` (exact).
4. PP&E: stores' `cost`/`accumulatedDepreciation` enter the combined `1500`/`1590` check (manufacturing.md 10.4).
5. Goods conservation (invariant 4): per shelf line `received === Σ store.restocked.quantity (+ receive)`,
   `issued === Σ store.sold.quantity + shrunk`; qa verifies with the counters, not the event log.
6. Daily: `soldToday <= lot.received`; `revenueToday === Σ price × sold` for the day (checked in owner tests).

## 10. Tests the owner must ship

- Command table: every rejection code in order; `store.build` posts one `capex` entry; `set_price`
  with `null` sells at reference the next day.
- Restock: a scripted manufacturing fixture (real system, pre-filled lot) → shelf gains `q`, value
  equals the transfer cost, `1230` equals shelf value, `1210` decreased by the same amount.
- Sales with a real economy: price at reference sells `min(stock, D)`; price at `1 + 1/ε` of
  reference sells 0; cheaper price sells more; COGS equals `allocateMoney` split; `retailSale`
  posted once per store-product per day.
- Stockout: stock below demand sets `stockout: true` and `unmetToday > 0`.
- Shrinkage: `shrinkagePerMille = 10`, stock 1000 → 10 units and the proportional value written off.
- Depreciation sums exactly to `cost` over `usefulLifeMonths`.
- fast-check property: random restock/sale/shrink sequences keep lot invariants and
  `Σ cogs + Σ writeOff + lot.value === Σ transfer cost`.
- Determinism and snapshot/restore mid-run with scripted commands.
