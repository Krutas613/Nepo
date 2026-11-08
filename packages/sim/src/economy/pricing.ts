/**
 * Price discovery and demand response: pure functions over plain numbers (ADR-011,
 * docs/design/economy.md sections 4.2-4.4).
 *
 * The reference price of a (market, product) is `anchor x level`, where `level` is a dimensionless
 * price level that relaxes toward a target set by a smoothed supply/demand imbalance:
 *
 *   x      = (D - S) / max(D, S, 1)                 in [-1, 1]
 *   xbar  <- xbar + beta  * (x - xbar)              in [-1, 1]
 *   level <- level + alpha * (1 + kappa * xbar - level)
 *
 * Stability by construction: both updates are convex combinations with real poles `1 - beta` and
 * `1 - alpha` in (0, 1), so for `|xbar| <= 1` the level is confined to `[1 - kappa, 1 + kappa]` and
 * `|Δlevel| <= 2 alpha kappa` per step, whatever the input sequence (no oscillation, no runaway).
 * The property tests in `pricing.property.test.ts` check exactly these statements.
 *
 * Floats: only `+ - * /`, `Math.min/max/floor`, all exactly specified by ECMAScript, so results are
 * identical on every engine. The clamps are mathematically no-ops (the bounds hold in real
 * arithmetic); they absorb the last-ulp rounding of the convex combinations so the invariant checks
 * can be exact rather than "within 1e-9". Money is rounded exactly once, through accounting's
 * `scaleMoney` (ARCHITECTURE.md section 4).
 */
import { scaleMoney } from '../accounting/index.js';
import { maxMoney, money, type Money } from '../schema/index.js';

/** Smallest legal price: one minor unit. */
export const MIN_PRICE: Money = money(1);

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Supply/demand imbalance `x = (D - S) / max(D, S, 1)`; +1 means demand and no supply, -1 supply
 * and no demand, 0 balanced. Inputs are non-negative (D an integer, S a float).
 */
export function imbalance(demand: number, supply: number): number {
  const denominator = Math.max(demand, supply, 1);
  return clamp((demand - supply) / denominator, -1, 1);
}

/** `xbar <- xbar + beta (x - xbar)`, kept in [-1, 1]. */
export function updateImbalanceEma(ema: number, x: number, beta: number): number {
  return clamp(ema + beta * (x - ema), -1, 1);
}

/** Target the level relaxes toward: `1 + kappa * xbar`. */
export function levelTarget(ema: number, kappa: number): number {
  return 1 + kappa * ema;
}

/** Lower and upper bound of the level for a given `kappa`: `[1 - kappa, 1 + kappa]`. */
export function levelBounds(kappa: number): { lo: number; hi: number } {
  return { lo: 1 - kappa, hi: 1 + kappa };
}

/** Largest possible one-step change of the level: `2 alpha kappa`. */
export function maxLevelStep(alpha: number, kappa: number): number {
  return 2 * alpha * kappa;
}

/**
 * `level <- level + alpha (1 + kappa xbar - level)`, kept in `[1 - kappa, 1 + kappa]`.
 * A level that starts outside the band (e.g. `kappa` lowered in content between saves) is pulled
 * onto the band edge in one step; that single step may exceed `2 alpha kappa`.
 */
export function relaxLevel(level: number, ema: number, alpha: number, kappa: number): number {
  const { lo, hi } = levelBounds(kappa);
  return clamp(level + alpha * (levelTarget(ema, kappa) - level), lo, hi);
}

/**
 * Demand response `g(r) = clamp(1 - epsilon (r - 1), 0, maxCapture)` for a seller at `r` times the
 * reference price (economy.md 4.3). `g(1) = 1`; cheaper sellers capture more, up to `maxCapture`;
 * sellers at `r >= 1 + 1/epsilon` capture nothing.
 */
export function captureFraction(ratio: number, elasticity: number, maxCapture: number): number {
  return clamp(1 - elasticity * (ratio - 1), 0, maxCapture);
}

/** `g(price / referencePrice)` (the barrel's `demandResponse`). `referencePrice` is >= 1 in state. */
export function demandResponse(
  elasticity: number,
  price: Money,
  referencePrice: Money,
  tunables: { readonly maxCapture: number },
): number {
  return captureFraction(price / referencePrice, elasticity, tunables.maxCapture);
}

/** `max(1, scaleMoney(anchor, level))`: the single money rounding of price discovery. */
export function priceAtLevel(anchor: Money, level: number): Money {
  return maxMoney(MIN_PRICE, scaleMoney(anchor, level));
}
