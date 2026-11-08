# ADR-011: Price discovery is a bounded relaxation toward an imbalance target; demand response is linear

**Status:** Accepted (Milestone 1 design)

## Context

Markets must be stable (no runaway or oscillation) yet responsive, deterministic across JS engines
(section 10 bans `Math.exp/log/pow`), and integer in money. Candidates: (1) an order-book-lite
clearing price each day (jumpy with one buyer and one seller, needs many participants to be smooth);
(2) a multiplicative random-walk price nudged by imbalance (unbounded, noisy); (3) a reference price
that relaxes toward a target set by a damped supply/demand imbalance, with hard bounds.

## Decision

Option (3), expressed as a dimensionless **price level** per (market, product) and per commodity.

- `anchor = scaleMoney(product.basePrice × market.priceFactor, macro.priceIndex)` (the inflation-adjusted
  base). `referencePrice = max(1, scaleMoney(anchor, level))`. All rounding goes through accounting's
  `scaleMoney`; no other rounding of money exists in the economy.
- Imbalance from the previous day: `x = (D − S) / max(D, S, 1)` in `[−1, 1]`, where `D` is the
  day's baseline demand at reference and `S` the effective supply offered (units offered weighted by
  `min(1, g(r))`). Smoothed: `xbar ← xbar + β (x − xbar)`. Target: `1 + κ·xbar`. Level:
  `level ← level + α (target − level)`, with `0 < α, β < 1` and `0 < κ ≤ 0.5` from `data/economy/pricing.json`.
- Demand response of a seller at price `P` relative to reference, `r = P / referencePrice`:
  `g(r) = clamp(1 − ε (r − 1), 0, maxCapture)` with `ε = product.elasticity`. Linear, exactly
  computable, zero at `r = 1 + 1/ε`.
- Commodities (raw materials from the NPC supplier) use the same relaxation with
  `y = (V − V0) / max(V, V0, 1)` (purchased volume vs the supplier's reference volume) and their own
  `α_c, κ_c`; quantity is unlimited in M1.

## Why it cannot oscillate

The update is a cascade of two first-order IIR filters (`xbar`, then `level`) with real poles
`1 − β` and `1 − α` in `(0, 1)`: given any input sequence, the response is a convex combination of
past targets and never overshoots the target range. Because `|xbar| ≤ 1`, `level` is confined to
`[1 − κ, 1 + κ]` by construction, and `|Δlevel| ≤ 2ακ` per day. The only feedback path is through
agents (stores, factories, AI) reacting to the published price; that reaction is lagged by at least
one tick (prices update in `macro` from the previous day's tallies) and its effect on the target is
bounded by `κ`. Agents can at worst make the level wander inside the band, never diverge.

## Consequences

- Prices are smooth and bounded; a market with no supply drifts to `1 + κ` (an "unserved market
  premium" the player can see), a flooded market to `1 − κ`.
- An elastic but never-exhausted NPC commodity supplier is an M1 simplification; M2 adds capacity,
  cycle and shock terms to the commodity target without changing the filter.
- Order-book or auction clearing for B2B (M2) can coexist: this ADR governs consumer reference prices
  and NPC commodity quotes only.
- Tunables `α, β, κ, maxCapture` live in `data/economy/pricing.json`; `elasticity` per product in
  `data/products.json`. Changing the equations is a new ADR; changing numbers is content.
