# Manufacturing design (Milestone 1)

Owner of the code: `manufacturing` (`packages/sim/src/manufacturing`). Companion to ARCHITECTURE.md
sections 6, 8 and ADR-009/012/013/014. Types live in `schema/` (`docs/design/schema-m1.md`). M1
scope: one facility type running one recipe (raw -> consumer product), inputs bought from the NPC
commodity source, output held at the facility until retail withdraws it.

## 1. Purpose and boundaries

Manufacturing owns facilities, their construction, production (work in progress), input and output
inventory lots, and the postings that go with them. It reads `ctx.scenario.content`
(`facilityTypes`, `recipes`, `products`, `cities`), calls `EconomyApi` for raw-material quotes and
`AccountingApi` for every money movement, and exposes `ManufacturingApi` so retail (M1) and
logistics (M2) can withdraw finished goods. It never touches another slice.

Phases: **`apply`** (commands) and **`production`**. No `market` handler in M1 (B2B sales are M2).

## 2. Content (`data/`)

| File                       | Type           | Fields                                                                                                                                                                                                                                  |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/facility_types.json` | `FacilityType` | `id, name, kind ('farm'/'mine'/'factory'), buildCost: Money, constructionTicks: int >= 0, dailyOperatingCost: Money, capacity: Quantity >= 1 (max batches in progress), storageCapacity: Quantity >= 1 (finished units), usefulLifeMonths: int >= 1` |
| `data/recipes.json`        | `Recipe`       | `id, name, facilityType, inputs: RecipeLine[], outputs: RecipeLine[] (>= 1), durationTicks: int >= 1, laborCostPerBatch: Money >= 0`                                                                                                   |

Cross-reference: `recipe.facilityType` exists; every line's product exists; M1 content has one recipe
whose single output has `category: 'consumer'`.

## 3. State (`ManufacturingState`, schema)

```ts
type FacilityStatus = 'under_construction' | 'operating';
interface WipBatch { recipeId: RecipeId; batches: Quantity; startedTick: number; completesTick: number; value: Money }
interface Facility {
  id: FacilityId; ownerId: CompanyId; typeId: FacilityTypeId; cityId: CityId;
  status: FacilityStatus; orderedTick: number; completesTick: number;
  recipeId: RecipeId | null; targetBatches: Quantity;          // 0 = off
  wip: WipBatch[];                                             // ascending completesTick, FIFO
  inputs: Record<ProductId, InventoryLot>;                     // account 1200
  outputs: Record<ProductId, InventoryLot>;                    // account 1210
  cost: Money; accumulatedDepreciation: Money;                 // PP&E record for this asset
  starvedReason: StarvedReason | null;                         // last production day's limiter (UI)
}
type StarvedReason = 'no_recipe' | 'off' | 'capacity' | 'storage_full' | 'no_inputs' | 'no_cash';
interface ManufacturingState { facilities: Record<FacilityId, Facility> }
```

`InventoryLot { quantity; value; received; issued }` is the shared schema type (ADR-012). WIP value
is `Σ wip[i].value` and reconciles to account `1205`.

## 4. Commands (phase `apply`, in `ctx.commands` order)

| Type                      | Payload                                                                | Rejections (in order)                                                                                                                                                  | Effect / event                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `facility.build`          | `{ companyId, facilityTypeId, cityId }`                                | `not_owner` (companyId !== issuer), `unknown_facility_type`, `unknown_city`, `insufficient_cash` (cash < buildCost)                                                    | issue `FacilityId`; post `capex(buildCost)` Dr 1500 / Cr 1000; status `under_construction`, `completesTick = tick + constructionTicks`; emit `facility.ordered` |
| `facility.set_recipe`     | `{ facilityId, recipeId: RecipeId \| null }`                           | `unknown_facility`, `not_owner`, `unknown_recipe`, `recipe_mismatch` (recipe.facilityType !== typeId)                                                                   | set `recipeId` (existing WIP keeps its own recipe); emit `facility.recipe_set`                                                   |
| `facility.set_production` | `{ facilityId, targetBatches: Quantity }`                              | `unknown_facility`, `not_owner`                                                                                                                                       | `targetBatches = min(targetBatches, capacity)`; emit `facility.production_set`                                                   |

A command is applied fully or rejected; validation precedes every mutation and posting. Building is
discretionary spend (ADR-014). `constructionTicks = 0` means operating from the next `production`
phase of the same tick.

## 5. Production phase (per facility in `sortedKeys(facilities)`)

1. **Completion of construction.** If `under_construction` and `tick >= completesTick`:
   `status = 'operating'`, emit `facility.completed`. Nothing else happens for a facility still under
   construction (no opex, no depreciation).
2. **Complete WIP.** For each `wip` batch with `completesTick <= tick` (FIFO): output quantity per
   product `= batches × line.quantity`; receive into `outputs[product]` with cost split by
   `allocateMoney(value, weights)` where `weight_j = outputQty_j × product_j.basePrice` (one output in
   M1 → whole value); post `productionComplete(value)` Dr 1210 / Cr 1205; emit
   `production.completed { facilityId, recipeId, batches, outputs: [{ productId, quantity, cost }] }`.
3. **Plan starts.** `recipe = content.recipes[recipeId]`; if none → `starvedReason = 'no_recipe'`, skip
   to 5. `want = min(targetBatches, capacity − Σ wip.batches)`; if `targetBatches === 0` → `'off'`.
   Storage: `pendingOut = Σ over wip of batches × outQty` (primary output), `room = storageCapacity −
   outputs[primary].quantity − pendingOut`; `want = min(want, floor(room / outQty))` (`'storage_full'`).
4. **Buy inputs (JIT) and start.** For each input line in recipe order: `need = want × qty −
   inputs[p].quantity`; if `need > 0`: `quote = economy.quoteRaw(p, need)`; if `quote.total > cash`
   then `buyQty = floor(max(0, cash) / quote.unitPrice)` (`'no_cash'`), else `buyQty = need`; if
   `buyQty > 0`: `q = economy.buyRaw(ownerId, p, buyQty)`; post `inventoryPurchase(q.total)` Dr 1200 /
   Cr 1000; receive lot. Then `want = min(want, floor(inputs[p].quantity / qty))` over all inputs
   (`'no_inputs'` if reduced). Labour: `labor = mulMoney(laborCostPerBatch, want)`; while
   `labor > cash` reduce `want` (`'no_cash'`). If `want > 0`: issue `want × qty` from each input lot
   (ADR-012 split) summing `materials`; post `productionStart(materials, labor)` Dr 1205 (materials +
   labor) / Cr 1200 materials / Cr 1000 labor (labour line omitted when 0); push
   `{ recipeId, batches: want, startedTick: tick, completesTick: tick + durationTicks, value }`. If
   `want < targetBatches` emit `production.starved { facilityId, reason, wanted: targetBatches, started: want }`
   (one event per facility per day at most). `cash` is re-read from accounting after each posting.
5. **Operating cost.** If `dailyOperatingCost > 0`: post `cashPurchase(ACCOUNTS.OPEX_FACILITY, amount)`
   (non-discretionary; may take cash negative, ADR-014).
6. **Depreciation (ADR-009).** If `ctx.date.isMonthEnd` and `accumulatedDepreciation < cost`:
   `charge = minMoney(scaleMoney(cost, 1 / usefulLifeMonths), cost − accumulatedDepreciation)`; if
   `charge > 0` post `depreciation(charge)` and add to `accumulatedDepreciation`. First charge is the
   first month end at which the facility is operating.

Rounding: only `scaleMoney`/`allocateMoney`/`mulMoney`. Quantities are integers throughout
(`Math.floor` on non-negative integers only).

## 6. Service (`MANUFACTURING_SERVICE: ServiceKey<ManufacturingApi>`)

```ts
type WithdrawErrorCode = 'unknown_facility' | 'not_owner' | 'unknown_product' | 'insufficient' | 'not_operating';
interface Withdrawal { facilityId: FacilityId; productId: ProductId; quantity: Quantity; cost: Money }
interface ManufacturingApi {
  facility(facilityId: FacilityId): DeepReadonly<Facility> | null;                 // read
  availableOutput(facilityId: FacilityId, productId: ProductId): Quantity;         // read: outputs[p].quantity or 0
  facilitiesOf(ownerId: CompanyId, cityId?: CityId): readonly FacilityId[];        // read, sorted
  withdraw(ownerId: CompanyId, facilityId: FacilityId, productId: ProductId, quantity: Quantity,
           destinationAccount: AccountCode): Result<Withdrawal, { code: WithdrawErrorCode; message: string }>;
}
```

`withdraw` (write; M1 caller: retail in `market`; M2: logistics): validates in the listed order;
`quantity >= 1`; issues `quantity` from `outputs[productId]` with `cost = allocateMoney(value,
[quantity, remaining])[0]`; posts `internalTransfer(cost, destinationAccount)` Dr `destinationAccount` /
Cr 1210 with `source: 'manufacturing'`, `ref: { kind: 'facility', id }`; returns `{ quantity, cost }`.
Cost `0` (free goods) skips the posting. Reads go through `handle.state()`.

## 7. Events

`facility.ordered { facilityId, companyId, facilityTypeId, cityId, completesTick }`, `facility.completed { facilityId }`,
`facility.recipe_set { facilityId, recipeId }`, `facility.production_set { facilityId, targetBatches }`,
`production.completed { facilityId, recipeId, batches, outputs }`, `production.starved { facilityId, reason, wanted, started }`.
(Transfers are observable via `store.restocked` from retail and `ledger.posted`.)

## 8. Unit cost reporting

Unit cost of finished goods at a facility `= outputs[p].value / outputs[p].quantity` (float, UI only).
The last completed batch's `cost / quantity` is in `production.completed`. Full cost including
operating cost is a UI metric: `(cogs of the month + 6000 movement) / units completed`; nothing
in state stores a float unit cost.

## 9. Determinism notes

No RNG in M1. Iteration via `sortedKeys` over facilities and lots; recipe lines in array order.
`cash` is read from `AccountingApi.cash` each time it matters (no cached balance). Content from
`ctx.scenario.content` only.

## 10. Invariants qa will check (`checkManufacturingInvariants(state: WorldState)`)

1. Every lot: `quantity >= 0`, `value >= 0`, `received − issued === quantity`, `quantity === 0 ⇒ value === 0`.
2. Per entity: `Σ inputs.value === balance(1200)`, `Σ wip.value === balance(1205)`,
   `Σ outputs.value === balance(1210)` over that entity's facilities (exact integers).
3. Per facility: `Σ wip.batches <= capacity`; `outputs[primary].quantity + pendingOut <= storageCapacity`;
   `0 <= accumulatedDepreciation <= cost`; `targetBatches <= capacity`;
   `status === 'under_construction' ⇒ state.tick <= completesTick` (checked after the tick).
4. Per entity PP&E: `Σ facility.cost (+ Σ store.cost) === balance(1500)` and
   `Σ accumulatedDepreciation === −balance(1590)` (qa combines manufacturing and retail records).
5. Goods conservation (invariant 4): for every output product, `Σ received === Σ completed batches ×
   outQty` and `issued === Σ withdrawn` (checked via counters; `received − issued === quantity`).

## 11. Tests the owner must ship

- Command table: every rejection code in order; `facility.build` posts exactly one `capex` entry and
  leaves cash reduced by `buildCost`; building with `cash < buildCost` is rejected and posts nothing.
- Construction: `constructionTicks = 3` → operating on the 4th tick; no opex/depreciation before.
- Production over 60 ticks with scripted `set_recipe`/`set_production`: WIP completes after
  `durationTicks`; outputs and lot counters match; `1200/1205/1210` reconcile each tick.
- Starvation table: `no_recipe`, `off`, `capacity`, `storage_full`, `no_inputs` (economy stub
  returning a huge price so cash limits purchases), `no_cash`.
- Depreciation: `usefulLifeMonths = 7`, `cost = 1000` → charges sum to exactly 1000 and stop.
- `withdraw`: success posts `internalTransfer` to the given account and splits value by
  `allocateMoney`; each error code; withdrawing everything leaves `value === 0`.
- fast-check property: random sequences of receive/issue on an `InventoryLot` keep
  `received − issued === quantity`, `value >= 0`, and total value conserved across splits.
- Determinism: two worlds, same seed and commands, equal hash per tick; snapshot/restore mid-run.
