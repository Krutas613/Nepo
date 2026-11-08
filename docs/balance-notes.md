# Balance notes

Owned by the `game-design` agent. Records the intended game arc, tuning hypotheses, the data-file
changes proposed, and before/after sweep evidence. Data-level proposals only: changes outside
`data/scenarios/` go to their owners (`content` owns the rest of `data/`; code changes are filed as
requests for the owning domain agent).

All money below is in minor units (cents) unless written as `123.45`. Calendar: 30-day months,
360-day year; tick 0 is 1 Jan of `epochYear`. Commands submitted on tick `t` execute on `t + 1`.

## 1. Milestone 1 scenarios

| File                                 | `id`             | Company              | `startingCash`                  | Purpose                    |
| ------------------------------------ | ---------------- | -------------------- | ------------------------------- | -------------------------- |
| `data/scenarios/vertical_slice.json` | `vertical_slice` | Harbour Loaf Company | 18,000,000 (180,000.00)         | The M1 game; exit criteria |
| `data/scenarios/sandbox.json`        | `sandbox`        | Harbour Loaf Company | 180,000,000 (1,800,000.00), 10x | Free experimentation       |

Both: `epochYear 2000`, one `player` company, `homeCity harbour_bay`, no `content` (the loader
attaches the `data/` pack; `validate-data` rejects an authored `content`).

Deviation: `docs/design/schema-m1.md` section 11 sketched `startingCash 50,000,000` and "Player Co".
50,000,000 buys four plants, which defeats the opening decision, so the shipped file uses 18,000,000.
The schema fixture `VERTICAL_SLICE_SCENARIO` (springfield pack) keeps 50,000,000; it is a test
fixture, not the playable scenario, and needs no change.

## 2. `startingCash` arithmetic (vertical_slice)

Shipped costs (`data/facility_types.json`, `data/store_formats.json`, `data/recipes.json`, data
README):

| Item                                                       |     Amount |
| ---------------------------------------------------------- | ---------: |
| `bread_plant.buildCost`                                    | 12,000,000 |
| `corner_store.buildCost`                                   |  4,000,000 |
| One plant + one store (capex)                              | 16,000,000 |
| Fixed opex per operating day (40,000 plant + 25,000 store) |     65,000 |
| Variable cost per day at capacity (200 batches x 380)      |     76,000 |
| First operating day outflow (76,000 + 65,000)              |    141,000 |
| Two plants (capex)                                         | 24,000,000 |

Constraints and the chosen value:

- **Lower bound** (one plant + one store + first day's float): 16,000,000 + 141,000 = 16,141,000.
- **Upper bound** (must not afford two plants from cash): < 24,000,000. Plant + store + plant would be
  28,000,000.
- **Chosen: 18,000,000.** After capex the cushion is **2,000,000**, which covers:
  - the production float: materials and labour are paid at batch start (JIT) and sold the next day,
    so roughly one day of variable cost (76,000) is always in the pipeline;
  - **~30 days of fixed opex at zero revenue** (2,000,000 / 65,000 = 30.8 days): a forgiving margin
    for a first-time player who opens the store early, forgets the restock policy, or prices above
    the kill price (`r >= 1 + 1/ε = 2.67`), before the 5,000,000 overdraft is touched.
- A second plant is rejected (`insufficient_cash`) at every point in month 1: cash is 6,000,000 after
  the plant order and 2,000,000 after the store order.
- Underwriting at tick 1 (equity 18,000,000, no debt; `coastal_savings`): `maxPrincipalToEquity 1.5`
  caps principal at 27,000,000. Leverage after a draw of `P` is `P / 18,000,000`: up to 9,000,000 at
  6.0% (policy 4% + 2.0%), up to 18,000,000 at 7.5%, up to 27,000,000 at 9.0%. A loan-funded second
  plant + store (16,000,000, leverage 0.89) prices at **7.5%**. `minEquity 1,000,000` and
  `minPrincipal 500,000` do not bind.

Sandbox: 10x = 180,000,000 funds about 11 plant + store pairs, beyond city saturation (section 4), so
it exercises oversupply and price collapse without financing.

## 3. Intended M1 early-game arc (vertical_slice, one city)

Model assumptions: shipped data, store price `null` (follows the reference price, `r = 1`), restock
target 1,000, production target 200 batches/day. Numbers are from a scratch spreadsheet model of
ADR-011 and the daily loops in `manufacturing.md`/`retail.md`; qa sweeps must confirm them (section 6).

| Beat                      | Tick (day)            | What happens                                                                                                                                                                                                                                 |
| ------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First factory             | 0 -> executes 1       | `facility.build bread_plant`. Cash 18.0M -> 6.0M. Completes tick 31.                                                                                                                                                                         |
| Price signal during build | 1 - 31                | No supply: imbalance x = 1, the bread level climbs 1.00 -> ~1.22 (reference 250 -> ~306) by tick 30. The player sees an unserved market waiting.                                                                                             |
| First store               | ~16 -> executes 17    | `store.build corner_store` timed to open with the plant (14-day build). Cash 6.0M -> 2.0M. Building it on tick 0 instead opens it on tick 15 and burns 16 x 25,000 = 400,000 of store opex with nothing to sell: a cheap lesson, not a trap. |
| Plant online              | 31                    | First 200 batches start (recipe and target set beforehand). Cash trough **~1.86M**.                                                                                                                                                          |
| First sales               | 32                    | First output is withdrawn to the shelf and sold out (800 offered vs 4,000 demand). Reference ~308.                                                                                                                                           |
| First profitable month    | month 2 (ticks 30-59) | Month 1 posts no revenue and no expense (capex is capitalised; nothing operates). Month 2 shows ~28 operating days at ~104,000/day operating profit, about **2.9M**.                                                                         |
| Steady state              | ~45 onward            | Level plateaus at **1.24** (reference 310). Cash generation ~107,000/day: revenue 248,000 - variable 76,000 - fixed 65,000.                                                                                                                  |
| First loan need           | ~31 - 60              | Cash (1.9M - 5M) cannot fund the next plant + store (16M) for ~5 months. The loan is the accelerator: ~16M at 7.5%, 12 months, buys a second pair 3-4 months early. Not forced by a cash crisis (see risk 3).                                |
| Payback of the first pair | ~tick 180 (month 6)   | Cash returns to the 18M starting level.                                                                                                                                                                                                      |
| Year-1 target             | tick 360              | **Par** (one pair, no loan): ~37M cash (~2.0x start). **Strong** (loan-funded second pair by ~tick 75): ~44M cash after repaying the loan. **Too generous** if any follow-market run ends year 1 above ~60M.                                 |

Mid-game in M1 is "fill the city": each plant + store pair supplies 800 of 4,000 loaves/day. Expected
reference level by number of pairs `n` (follow-market): x = (4000 - 800n)/4000, level 1 + 0.3x:

| Pairs | Offered |     x | Level | Reference | Cash/day per pair (approx.) |
| ----: | ------: | ----: | ----: | --------: | --------------------------: |
|     1 |     800 |  0.80 |  1.24 |       310 |                     107,000 |
|     2 |   1,600 |  0.60 |  1.18 |       295 |                      93,000 |
|     3 |   2,400 |  0.40 |  1.12 |       280 |                      80,000 |
|     5 |   4,000 |  0.00 |  1.00 |       250 |                      56,000 |
|     6 |   4,800 | -0.17 |  0.95 |      ~238 |     ~25,000 (667 sold each) |

Wheat purchases above 400 kg/day push the commodity level up (2 pairs: ~45/kg; 6 pairs: ~48/kg),
adding 5-8 per loaf; second-order. The natural M1 ceiling is about 5 pairs (80M capex); the sixth is
marginal. Later beats (first store chain, first acquisition, first IPO) belong to M2/M3 and are out
of scope here.

## 4. Levers to tune after the first sweeps

Owner of each file in brackets. Proposals only; none applied.

### 4.1 Demand 4,000/day vs supply 800/day: is the level drift the intended early pressure?

Answer: **no, it is a windfall, not pressure.** A sole seller in an undersupplied market gets a
higher reference price (1.24x) for free. As a signal ("the city wants more bread") it is right and
should stay, because it gives the build period something to watch and makes the second pair
attractive. As a profit source it is too strong: at level 1.0 one pair pays back in ~285 days; at
1.24 in ~150 days. Early pressure should come from capex, the cash trough and debt service, not
from price.

Candidate moves, in the order I want to test them:

1. **`products.json` bread `elasticity` 0.6 -> 1.5** (`content`). This is the main lever, because it
   also fixes the gouging exploit (section 5, item 1). Expected: stock-bound optimum
   r\* = 1 + 0.8/ε drops from 2.33 to 1.53.
2. **`economy/pricing.json` `kappa` 0.3 -> 0.2** (`content`). Plateau level 1.24 -> 1.16 (reference
   ~290); payback ~180 days. Only if (1) is not enough.
3. **`markets.json` bread `baseDailyDemand` 4,000 -> 2,400** (`content`). Saturates at 3 pairs,
   shortens the "fill the city" runway. Keep in reserve: M1 needs room for at least the loan-funded
   second pair, and M2 will widen anyway.
4. **Plant economics** (`facility_types.json`, `recipes.json`, `content`): if payback is still under
   ~9 months after (1)-(2), raise `bread_plant.dailyOperatingCost` 40,000 -> 55,000 (break-even rises
   from ~55% to ~66% utilisation at anchor price). Target band for one pair, follow-market play:
   **payback 8-12 months**, operating margin 20-30%.

### 4.2 Finance levers (`finance/banks.json`, `content`)

- `maxPrincipalToEquity` 1.5 caps the day-1 leverage rush at 27M (enough for 1.7 extra pairs). If
  sweeps show the max-leverage rush dominates, lower to 1.0.
- Spread tiers (6.0 / 7.5 / 9.0%) are small next to a ~150% annual ROI on a pair; they matter only
  once ROI is tuned down. Revisit after 4.1.
- `overdraftAnnualRate` 0.18 stays well above term-loan rates, so the term loan is always the better
  instrument. Keep.

### 4.3 Scenario levers (`data/scenarios`, mine)

- `startingCash` 18,000,000. If sweeps or playtests show players never borrow, lower to 16,500,000
  (cushion 500,000, ~7 days of fixed opex) so a small working-capital loan becomes the prudent first
  move; if first-timers hit the overdraft before first sales, raise to 20,000,000 (still < 24M).

## 5. Dominant strategy / dead-end watch list

| #   | Pattern                                                                                                                                                                                       | Kind            | Why it happens (shipped data)                                                                                                                                                                                                                                                                                                            | Watch metric                                                                         | Data lever / request                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | **Price gouging.** Set the store price to ~2.33x reference and still sell out.                                                                                                                | Dominant        | Sales = min(stock, floor(4000 x g(r))) with g = 1 - 0.6(r - 1); 800 loaves sell while g >= 0.2, i.e. r <= 2.33. Overpricing also shrinks effective supply S = qty x min(1, g), pushing the level to ~1.285 (reference ~321). Model: price ~750, ~460,000/day operating profit, ~152M cash at year end vs ~37M following the market (4x). | Store price / reference ratio in scripted runs; year-1 cash, follow-market vs gouge. | Bread `elasticity` 0.6 -> 1.5 (r\* 1.53). The g-weighted S is correct with competitors; M3 AI rivals are the real cure. |
| 2   | **Day-1 leverage rush.** Borrow the 27M maximum on tick 1 and build 2-3 pairs before the first is open.                                                                                       | Dominant        | ROI per pair (~150%/yr) dwarfs 9% interest; nothing in M1 punishes overbuilding until 5 pairs.                                                                                                                                                                                                                                           | Pairs owned at tick 60 vs loan size; default / missed-payment counts.                | Tune ROI first (4.1), then `maxPrincipalToEquity` 1.5 -> 1.0.                                                           |
| 3   | **Never borrow.** Payback ~5 months makes the loan optional.                                                                                                                                  | Skipped beat    | Cash flow funds the second pair by ~month 6 without debt.                                                                                                                                                                                                                                                                                | Share of scripted strategies that end year 1 better off without a loan.              | Lower ROI (4.1); or `startingCash` 16,500,000 (4.3).                                                                    |
| 4   | **Plant without a matching store.** A second plant feeding one store: shelf 1,000 < 1,600/day; plant output fills 2,000 storage and the plant idles (`storage_full`) while paying 40,000/day. | Trap            | `shelfCapacity` 1,000 vs plant 800/day: one store absorbs only 1.25 plants.                                                                                                                                                                                                                                                              | `production.starved` with `storage_full`; utilisation per plant.                     | Keep (a real lesson) but request `ui` to surface `starvedReason` prominently on the factory view.                       |
| 5   | **Store opened before the plant.**                                                                                                                                                            | Minor trap      | 14-day vs 30-day builds; store opex 25,000/day from opening.                                                                                                                                                                                                                                                                             | Store operating days with zero stock before first `store.sold`.                      | None; 400,000 lesson within the cushion.                                                                                |
| 6   | **Overpriced to zero sales.** Price >= 2.67x reference sells nothing; fixed opex drains cash.                                                                                                 | Dead end (soft) | g(r) = 0 for r >= 1 + 1/0.6.                                                                                                                                                                                                                                                                                                             | Days with offers > 0 and sold = 0.                                                   | None in data; `ui` already shows reference vs own price.                                                                |
| 7   | **Equity below `minEquity`.** A loss spiral that takes equity under 1,000,000 locks the player out of credit, leaving only the overdraft (5M) before `credit.insolvent`.                      | Dead end (hard) | Needs ~250 days of fixed opex with no revenue from 18M; unlikely in M1 but no recovery path exists.                                                                                                                                                                                                                                      | `credit.insolvent` count; min equity over the run.                                   | None in data. M3 (restructuring) owns recovery.                                                                         |
| 8   | **Saturation, nothing left to do.** Once ~5 pairs are built the M1 city has no further decisions.                                                                                             | Pacing          | Single product, single city.                                                                                                                                                                                                                                                                                                             | Tick at which the 5th pair opens in an aggressive scripted run.                      | Expected in M1; M2 widens. If reached before ~month 9, ROI is too high.                                                 |

## 6. Questions for qa's sweep metrics

Requested from `qa` (sim-tests) on `--scenario vertical_slice`, 5 seeds, 1-2 years. M1 has no RNG
consumers in these systems, so seeds should agree; disagreement is itself a finding.

1. **Price index path:** bread `level`, `imbalanceEma` and `referencePrice` per tick; wheat
   `unitPrice` per tick. Expected: ~1.22 at tick 30, plateau 1.24 (follow-market). Max |delta level|
   per tick vs the 2ακ = 0.03 bound.
2. **Utilisation:** batches started / capacity per day per plant; `starvedReason` histogram.
3. **Sell-through:** sold / offered per store per day, stockout rate, unmet demand.
4. **Months to payback:** first tick at which cumulative operating cash flow (excluding loan
   draws/repayments) reaches cumulative capex. Expected ~150 days for one pair.
5. **Cash trough:** minimum cash and its tick; count of `credit.overdrawn` (expect 0 in the scripted
   human run and a trough near 1.86M at tick 31).
6. **P&L shape:** monthly revenue, gross margin, operating margin, net income; first month with net
   income > 0 (expect month 2).
7. **Loan:** rate at issue, payments made, `loan.payment_missed` (expect 0), interest as a share of
   operating profit.
8. **Year-end:** cash, equity, ROE, total debt.
9. **Strategy comparison** (request to `qa` to script these in addition to the exit-criteria run):
   (a) follow-market, one pair, no loan; (b) follow-market + 16M loan at tick 31 for a second pair;
   (c) gouge at r = 2.33; (d) max-leverage rush at tick 1; (e) store built on tick 0. Report
   year-1 cash and equity for each. Items 1-3 of section 5 are confirmed or refuted by (a)-(d).

## 7. Open requests and follow-ups

- To `content`: no change requested yet. The elasticity / kappa / opex proposals in 4.1 wait for the
  first sweep evidence (section 6 items 4 and 9).
- To `qa`: the scripted strategies in section 6 item 9 and the payback / trough metrics.
- To `ui`: make `starvedReason` and the reference-vs-own price ratio prominent (traps 4 and 6).
- No schema fields were missing for the scenarios; no `REQ-NNN` filed.

## Changelog

- 2026-11-08: M1 scenarios `vertical_slice` (18,000,000) and `sandbox` (180,000,000); M1 arc, levers,
  watch list and sweep questions. Numbers are model estimates pending the first sweep.
