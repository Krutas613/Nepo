# Content data

Products, recipes, facility types, store formats, regions, cities, markets, economy and finance
tunables live here as JSON. The shapes are the `ContentFiles` collections in
`docs/design/schema-m1.md` section 3; `assembleContentPack` (in `packages/sim/src/schema`) is the
single validator, including cross-file references. Content is owned by `content`; `data/scenarios/`
belongs to `game-design`. No content is hardcoded in logic.

Values are relative and plausible, not balanced. Money is integer minor units (cents); quantities are
integers. Balance is tuned later by game-design.

## Files

| File                       | `ContentFiles` key | Shape               | Contents (M1)                                    |
| -------------------------- | ------------------ | ------------------- | ------------------------------------------------ |
| `products.json`            | `products`         | `Product[]`         | `wheat` (raw), `bread` (consumer)                |
| `recipes.json`             | `recipes`          | `Recipe[]`          | `bread_batch`                                    |
| `facility_types.json`      | `facilityTypes`    | `FacilityType[]`    | `bread_plant`                                    |
| `store_formats.json`       | `storeFormats`     | `StoreFormat[]`     | `corner_store`                                   |
| `regions.json`             | `regions`          | `Region[]`          | `coastal_plains`                                 |
| `cities.json`              | `cities`           | `City[]`            | `harbour_bay` (population 40,000)                |
| `markets.json`             | `markets`          | `Market[]`          | one market for `harbour_bay`                     |
| `economy/pricing.json`     | `pricing`          | `PricingTunables`   | alpha 0.05, beta 0.25, kappa 0.3, maxCapture 1.5 |
| `economy/macro.json`       | `macro`            | `MacroTunables`     | inflation 0, policy rate 0.04, demand index 1    |
| `economy/commodities.json` | `commodities`      | `CommoditySource[]` | `wheat`: 400 kg/day reference volume             |
| `finance/banks.json`       | `banks`            | `Bank[]`            | `coastal_savings`                                |

File names follow the layout in `docs/design/economy.md`, `manufacturing.md`, `retail.md`,
`finance.md` and `ARCHITECTURE.md` section 15 (`facility_types.json`, `store_formats.json`).

Not yet in content: `data/scenarios/` (game-design). A scenario file there is a `Scenario` without
`content`; the pack is attached by the loader.

## Validate

```sh
pnpm --filter @nepo/tools validate-data
```

Prints each file's status and every issue path, and exits 1 on any failure. The loader used by
sim-tests and the UI build is `loadContentFromDir(dir)` in `packages/tools/src/load-content.ts`.

## Milestone 1 chain and arithmetic

Chain: `wheat` (raw, bought from the NPC commodity source) -> `bread_batch` in a `bread_plant` ->
`bread` sold through a `corner_store` into the Harbour Bay market. All figures are at reference
prices (`priceIndex 1`, price level 1) unless stated.

Recipe, per batch: 2 kg wheat (2 x 40 = 80) + labour 300 = **380 per batch**, yielding 4 loaves,
so **95 per loaf**.

Plant at capacity: 200 batches/day = 800 loaves/day, consuming 400 kg/day of wheat (equal to the
commodity `referenceDailyVolume`, so wheat stays at its base price of 40).

| Item (per loaf, at 800 loaves/day)                                           |       Amount |
| ---------------------------------------------------------------------------- | -----------: |
| Reference price (`bread.basePrice 250 x priceFactor 1 x index 1`)            |          250 |
| Materials + labour (95 above)                                                |           95 |
| Plant opex: 40,000 per day / 800                                             |           50 |
| Plant depreciation: 12,000,000 / 240 months = 50,000/month, ~1,667/day / 800 |            2 |
| Store opex: 25,000 per day / 800                                             |           31 |
| Store depreciation: 4,000,000 / 120 months = 33,333/month, ~1,111/day / 800  |            1 |
| **Operating profit per loaf**                                                | **71 (28%)** |

Daily at full capacity: revenue 800 x 250 = 200,000; materials and labour 200 x 380 = 76,000;
plant opex 40,000; store opex 25,000; depreciation ~2,778; operating profit **~56,200 per day (28%)**.

Break-even: fixed costs per day 67,778 (plant opex + store opex + depreciation); contribution per loaf
250 - 95 = 155; break-even 437 loaves/day, about **55% utilisation**.

Demand share: market demand 40,000 x 0.1 loaves per person per day = 4,000/day. One plant at capacity
supplies 800/day, **20%** of demand.

Price discovery (ADR-011): with 800 offered against 4,000 demanded, the imbalance settles near
x = (4000 - 800) / 4000 = 0.8, so the price level drifts toward 1 + kappa x 0.8 = 1.24, a reference
price of about 310. Price-driven profit rises from there; the 28% above is the floor at anchor price.
The level is capped at 1 + kappa = 1.3 (325).

## Decisions and deviations

- `minEquity` for the bank is 1,000,000 (10,000.00), not the "1" suggested in `finance.md`. A 1-minor-unit
  floor does not express a real lending minimum. Game-design can revisit.
- Market `baseDailyDemand` is authored directly (4,000). Population drives it only through the 0.1
  loaves-per-person-per-day arithmetic above; the schema has no per-capita field.
- City income is not authored: `City` has no income field in `schema-m1.md`. Filed as REQ-003 in
  `docs/schema-requests.md`.
- `shrinkagePerMille` is 0 for the corner store (M1 rule); bread spoilage is deferred.
- Wheat `elasticity` is 0 (raw, not sold to consumers). Bread is 0.6 (a staple, inelastic).
