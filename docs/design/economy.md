# Economy design (Milestone 1)

Owner of the code: `economy` (`packages/sim/src/economy`). Companion to ARCHITECTURE.md sections 6, 10
and ADR-010/011. Types named here live in `schema/` (see `docs/design/schema-m1.md`); this document
fixes behaviour, equations and the service contract. M1 scope: one region, one city, one consumer
market, one raw material with an NPC commodity source, one consumer product, constant macro.

## 1. Purpose and boundaries

The economy owns every price that is not set by a player/AI command and every unit of aggregate
demand. It never holds goods or money: it quotes, tallies and publishes. Retail sells into it;
manufacturing buys raw materials from it; finance reads the policy rate from it. It reads
`ctx.scenario.content` (products, markets, cities, `economy` tunables) and nothing from other slices.

Phases: **`macro`** only in M1 (`init` plus `macro`). The `market` phase is reserved for M2 B2B and
commodity-exchange clearing; register no handler for it in M1. Because economy runs before retail in
`market`, every price for day `t` is computed in `macro` of day `t` from the tallies of day `t − 1`.

## 2. Content and tunables (`data/`)

| File                           | Type (schema)                            | Fields                                                                                                                                                          |
| ------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/products.json`           | `Product[]`                              | `id, name, category, unit, basePrice: Money (>=1), elasticity: number (0..5)`                                                                                   |
| `data/regions.json`            | `Region[]`                               | `id, name`                                                                                                                                                      |
| `data/cities.json`             | `City[]`                                 | `id, name, region, population: Quantity`                                                                                                                        |
| `data/markets.json`            | `Market[]`                               | `id, name, city (exactly one market per city), demand: MarketDemand[]` with `MarketDemand { product, baseDailyDemand: Quantity, priceFactor: number (0.1..10) }` |
| `data/economy/pricing.json`    | `PricingTunables`                        | `alpha (0,1), beta (0,1), kappa (0,0.5], maxCapture [1,3]`                                                                                                      |
| `data/economy/macro.json`      | `MacroTunables`                          | `inflationAnnual [-0.5,1], policyRate [0,1], demandIndex (0,10]`                                                                                                |
| `data/economy/commodities.json`| `CommoditySource[]`                      | `product (category 'raw'), referenceDailyVolume: Quantity (>=1), alpha (0,1), kappa (0,0.5]`                                                                    |

Cross-reference rules (in `assembleContentPack`): every `MarketDemand.product` exists and is not
`raw`; every `raw` product has exactly one `CommoditySource`; every city has a region. Suggested M1
values: `alpha 0.05, beta 0.25, kappa 0.3, maxCapture 1.5`; `inflationAnnual 0, policyRate 0.04,
demandIndex 1`; commodity `alpha 0.1, kappa 0.25`. game-design tunes later.

## 3. State (`EconomyState`, schema)

```ts
interface MacroState { priceIndex: number; policyRate: number; demandIndex: number; lastMonthApplied: number }
interface ProductMarketState {
  level: number;              // price level in [1 - kappa, 1 + kappa]
  imbalanceEma: number;       // xbar in [-1, 1]
  referencePrice: Money;      // today's, >= 1; = max(1, scaleMoney(anchor, level))
  demandToday: Quantity;      // D: baseline demand at reference, fixed at open
  demandRemaining: Quantity;  // decremented by clearings; <= demandToday
  offeredToday: number;       // S: effective supply (float, see 4.2); >= 0
  soldToday: Quantity;
  lastDemand: Quantity; lastOffered: number; lastSold: Quantity;  // previous day's closed tallies (UI)
}
interface MarketState { id: MarketId; city: CityId; region: RegionId; products: Record<ProductId, ProductMarketState> }
interface CommodityState {
  level: number; volumeEma: number; unitPrice: Money; purchasedToday: Quantity; lastPurchased: Quantity;
}
interface EconomyState {
  macro: MacroState;
  markets: Record<MarketId, MarketState>;
  commodities: Record<ProductId, CommodityState>;
}
```

`init`: `macro = { priceIndex: 1, policyRate: macro.policyRate, demandIndex: macro.demandIndex, lastMonthApplied: 0 }`;
one `MarketState` per content market with `level 1, imbalanceEma 0, referencePrice = anchor`,
`demandToday = demandRemaining = D0`, tallies 0; one `CommodityState` per source with `level 1,
unitPrice = anchor`. Emit `market.opened { marketId, cityId }` per market in `sortedKeys` order.
With `EMPTY_CONTENT_PACK` the slice is `EMPTY_ECONOMY_STATE` plus the macro tunables.

## 4. Algorithms (all in `macro`, in this order)

### 4.1 Macro

On `ctx.date.isMonthStart && tick > 0`: `priceIndex ← priceIndex × (1 + inflationAnnual / 12)`;
`lastMonthApplied = tick`. `policyRate` and `demandIndex` are copied from content each tick (constant
in M1; M2 replaces this with the business cycle). Floats here use only `+ − × ÷` (exactly specified).

### 4.2 Consumer reference price per `(market, product)` (ADR-011)

Let `p` = product, `md` = its `MarketDemand`, `t` = tunables. Using **yesterday's** tallies
(`demandToday`, `offeredToday` as left by the previous tick):

```
D  = demandToday                      // integer
S  = offeredToday                     // float: Σ qty_i · min(1, g(r_i)) over yesterday's offers
x  = (D - S) / max(D, S, 1)           // in [-1, 1]
imbalanceEma ← imbalanceEma + t.beta  · (x - imbalanceEma)
level        ← level        + t.alpha · (1 + t.kappa · imbalanceEma - level)
anchor        = scaleMoney(scaleMoney(p.basePrice, md.priceFactor), macro.priceIndex)
referencePrice = maxMoney(money(1), scaleMoney(anchor, level))
```

Then close and reopen the day: `lastDemand/lastOffered/lastSold ← demandToday/offeredToday/soldToday`;
`demandToday = demandRemaining = quantity(Math.floor(md.baseDailyDemand × macro.demandIndex))`;
`offeredToday = 0; soldToday = 0`. Iterate markets, then products, in `sortedKeys` order.

Bounds hold by construction (`|imbalanceEma| ≤ 1` ⇒ `level ∈ [1 − κ, 1 + κ]`, `|Δlevel| ≤ 2ακ`); see
the ADR for why the cascade of two first-order filters cannot oscillate. Floats are stored as plain
`number`; `findNonFinite` guards NaN (division is guarded by `max(..., 1)`).

### 4.3 Demand response

`g(r) = clamp(1 − ε (r − 1), 0, t.maxCapture)` with `r = price / referencePrice` (float) and
`ε = product.elasticity`. `g(1) = 1`; cheaper sellers capture more up to `maxCapture`; sellers at
`r ≥ 1 + 1/ε` capture nothing. M2 hooks: segmentation multiplies `g` by a segment weight and a
quality/brand term; the clearing API already receives `quality` and `brand` (ignored in M1: use
`attractiveness = g(r)`; validators accept the fields).

### 4.4 Commodity price per raw product

```
V  = purchasedToday (yesterday's)       V0 = source.referenceDailyVolume
y  = (V - V0) / max(V, V0, 1)
volumeEma ← volumeEma + t.beta · (y - volumeEma)          // shares pricing.beta
level     ← level + source.alpha · (1 + source.kappa · volumeEma - level)
unitPrice = maxMoney(money(1), scaleMoney(scaleMoney(p.basePrice, macro.priceIndex), level))
lastPurchased ← purchasedToday; purchasedToday = 0
```

Quantity is unlimited in M1; the price for day `t` is fixed during day `t` (intra-day purchases do
not move it), which keeps `quoteRaw` and `buyRaw` consistent within a tick.

## 5. Service (`ECONOMY_SERVICE: ServiceKey<EconomyApi>`)

```ts
interface MarketOffer {
  sellerId: CompanyId; storeId: StoreId; productId: ProductId;
  price: Money;        // >= 1
  quantity: Quantity;  // units on offer today (stock on shelf)
  quality: number;     // placeholder, 0 in M1
  brand: number;       // placeholder, 0 in M1
}
interface MarketClearing {
  sold: readonly Quantity[];      // aligned with offers; sold[i] <= offers[i].quantity
  referencePrice: Money;          // today's
  demandBefore: Quantity;         // demandRemaining before this clearing
  demandAfter: Quantity;
}
interface RawQuote { productId: ProductId; quantity: Quantity; unitPrice: Money; total: Money }
interface EconomyApi {
  // reads (via handle.state(); never handle.slice())
  policyRate(): number;
  priceIndex(): number;
  marketOfCity(cityId: CityId): MarketId | null;
  referencePrice(marketId: MarketId, productId: ProductId): Money;        // InvariantError if unknown
  demandRemaining(marketId: MarketId, productId: ProductId): Quantity;
  expectedCapture(marketId: MarketId, productId: ProductId, price: Money): Quantity; // floor(demandRemaining · g(r)); UI/AI preview, no side effects
  quoteRaw(productId: ProductId, quantity: Quantity): RawQuote;           // unitPrice from CommodityState; total = mulMoney(unitPrice, quantity)
  // writes (via handle.slice()); legal only in phase `market` (clear) / `production` (buyRaw) — the service checks handle.date()/phase via caller discipline, documented, not enforced
  clearConsumerMarket(marketId: MarketId, productId: ProductId, offers: readonly MarketOffer[]): MarketClearing;
  buyRaw(buyerId: CompanyId, productId: ProductId, quantity: Quantity): RawQuote;  // records volume, emits commodity.purchased; caller posts
}
```

`clearConsumerMarket` (called once per `(market, product)` per tick by retail, which gathers every
store's offer first; M1 has 0 or 1 offer):

1. `D = demandRemaining`. For each offer `i` in array order: `g_i = g(price_i / referencePrice)`,
   `w_i = quantity_i > 0 ? g_i : 0`.
2. `W = Σ w_i`. If `W === 0` every `sold_i = 0`. Otherwise `want_i = floor(D × g_i × (w_i / W))`,
   `sold_i = min(want_i, quantity_i)`. One redistribution pass (M2 relevance, harmless in M1): spill
   `= Σ (want_i − sold_i)` is offered to sellers with remaining stock in array order, each taking
   `min(spill, quantity_i − sold_i)`, but the grand total never exceeds `floor(D × max_i g_i)`.
3. Tallies: `offeredToday += Σ quantity_i × min(1, g_i)`; `soldToday += Σ sold_i`;
   `demandRemaining = quantity(max(0, D − Σ sold_i))`.
4. Return `{ sold, referencePrice, demandBefore: D, demandAfter: demandRemaining }`. No events
   (retail emits `store.sold`). Unknown market/product: `InvariantError('economy.unknown_market')`.

`buyRaw`: `purchasedToday += quantity`; emit `commodity.purchased { companyId, productId, quantity, unitPrice, total }`;
return the quote. The **caller** posts `inventoryPurchase(total)` (manufacturing is the buyer and
holder) in the same phase; economy holds no money. Unknown commodity → `InvariantError('economy.unknown_commodity')`.

Pure helpers exported from the barrel for the UI/AI (no service, no side effects; same functions the
service uses internally): `demandResponse(elasticity, price, referencePrice, tunables): number` (`g`),
`expectedCaptureFor(state: EconomyState, content: ContentPack, marketId, productId, price): Quantity`,
`anchorPriceOf(content, macro, marketId, productId): Money`, `checkEconomyInvariants(state: WorldState)`.

## 6. Events

`market.opened { marketId, cityId }` (init); `commodity.purchased { companyId, productId, quantity, unitPrice, total }`;
`macro.month_applied { tick, priceIndex }` on month start. No daily price events (prices are read
from state; the UI buffers series itself).

## 7. Determinism notes

No RNG in M1 (the `economy` stream exists but is not drawn from; M2 shocks will use
`rngFor('shocks')`). All iteration over `sortedKeys`. Float sums over offers are in array order,
which retail builds from `sortedKeys(stores)`. No `Math.pow/exp/log`. Content is read from
`ctx.scenario.content`, never cached in module scope.

## 8. Invariants qa will check (`checkEconomyInvariants(state: WorldState): EconomyInvariantViolation[]`)

1. For every `ProductMarketState`: `1 − κ − 1e-9 ≤ level ≤ 1 + κ + 1e-9`; `|imbalanceEma| ≤ 1`;
   `referencePrice ≥ 1`; `0 ≤ demandRemaining ≤ demandToday`; `soldToday ≤ demandToday × maxCapture + offers`
   (practically `soldToday ≤ demandToday`, asserted exactly since `sold ≤ D` per clearing); `offeredToday ≥ 0`.
2. For every `CommodityState`: `level` within `[1 − κ_c, 1 + κ_c]`; `unitPrice ≥ 1`.
3. `macro.priceIndex > 0`, `0 ≤ policyRate ≤ 1`, `demandIndex > 0`.
4. Sweep metrics (qa computes from per-tick state): `priceIndex` = mean over `(m,p)` of
   `referencePrice / anchor`; `volatility` = max over ticks of `|Δ referencePrice| / referencePrice`
   (must be `≤ 2ακ + 1/minPrice` rounding slack) and standard deviation of daily relative changes;
   count of `commodity.purchased` events. Invariant `7-economic-sanity` becomes active for the bounds
   checks in M1; volatility thresholds are set in M2.

## 9. Tests the owner must ship

- Convergence: a scripted retail stand-in offering exactly `D` units at reference every tick for 720
  ticks: `level` converges to within `1e-3` of `1.0` and `Δlevel` changes sign at most once after
  tick 60 (no oscillation).
- Shock and recovery: offers jump to `2D` at tick 100 for 100 ticks then return to `D`: `level`
  decreases monotonically toward `1 − κ`, never below, and recovers monotonically to within `1e-3` of 1.
- Unserved market: no offers for 360 ticks → `level` increases monotonically to within `1e-3` of `1 + κ`.
- fast-check property: for random offer sequences (quantities, prices in `[1, 5 × anchor]`), bounds
  in section 8 hold every tick and `|Δlevel| ≤ 2ακ`.
- Clearing table: `g(r)` at `r ∈ {0.5, 1, 1 + 1/ε, 2}`; two offers split by `w_i/W` with the spill
  pass; `demandRemaining` decreases by `Σ sold`; a second clearing the same day sees reduced demand.
- Commodity: 30 days buying `2 × V0` raises `unitPrice` monotonically and bounded; `buyRaw` emits and
  records; `quoteRaw(q).total === mulMoney(unitPrice, q)`.
- Determinism: two worlds, same seed, same scripted calls, identical `hashState` per tick; snapshot at
  tick 50, restore, run to 200, equal hash.
- Service rules: read methods do not call `handle.slice()` (ownership check passes for a caller that
  only queries); `clearConsumerMarket` from a test system in `market` passes `checkSliceOwnership`.
