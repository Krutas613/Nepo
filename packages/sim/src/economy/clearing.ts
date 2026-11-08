/**
 * Consumer-market clearing core (docs/design/economy.md section 5, `clearConsumerMarket` steps
 * 1-3), as a pure function over plain inputs so it can be tested without state or engine.
 *
 * Given today's remaining baseline demand `D`, the reference price and the product's elasticity,
 * and the offers of every store in array order (retail builds it from `sortedKeys(stores)`):
 *
 * 1. `g_i = g(price_i / referencePrice)`; weight `w_i = quantity_i > 0 ? g_i : 0`.
 * 2. `W = Σ w_i`. If `W === 0` nobody sells. Otherwise `want_i = floor(D g_i w_i / W)` and
 *    `sold_i = min(want_i, quantity_i)`. One redistribution pass: the unfilled `Σ (want_i - sold_i)`
 *    is offered to sellers with stock left, in array order, but the grand total never exceeds
 *    `floor(D max_i g_i)`.
 * 3. Effective supply `S = Σ quantity_i min(1, g_i)` (what feeds tomorrow's imbalance).
 *
 * Note `sold` may exceed `D` when a seller prices below reference (`g > 1`, up to `maxCapture`):
 * cheaper goods create demand. The per-clearing bound is `Σ sold <= floor(D max_i g_i) <= floor(D
 * maxCapture)`. Float sums run in array order (ARCHITECTURE.md section 10).
 */
import { quantity, type Money, type Quantity } from '../schema/index.js';
import { captureFraction } from './pricing.js';

export interface ClearingOffer {
  /** >= 1. */
  readonly price: Money;
  /** Units on offer. */
  readonly quantity: Quantity;
}

export interface ClearingParams {
  /** Remaining baseline demand `D` at the reference price (integer >= 0). */
  readonly demand: Quantity;
  /** Today's reference price (>= 1). */
  readonly referencePrice: Money;
  /** Product elasticity `epsilon` (0..5). */
  readonly elasticity: number;
  /** Upper clamp of `g` (1..3). */
  readonly maxCapture: number;
}

export interface ClearingResult {
  /** Aligned with the offers; `sold[i] <= offers[i].quantity`. */
  readonly sold: Quantity[];
  /** `Σ sold`. */
  readonly totalSold: Quantity;
  /** `Σ quantity_i min(1, g_i)`: effective supply for the imbalance tally. */
  readonly effectiveSupply: number;
  /** `g_i` per offer (for previews and tests). */
  readonly capture: number[];
}

export function clearOffers(
  params: ClearingParams,
  offers: readonly ClearingOffer[],
): ClearingResult {
  const capture: number[] = [];
  const weights: number[] = [];
  let weightSum = 0;
  let maxCapture = 0;
  let effectiveSupply = 0;
  for (const offer of offers) {
    const g = captureFraction(
      offer.price / params.referencePrice,
      params.elasticity,
      params.maxCapture,
    );
    const w = offer.quantity > 0 ? g : 0;
    capture.push(g);
    weights.push(w);
    weightSum += w;
    if (g > maxCapture) maxCapture = g;
    effectiveSupply += offer.quantity * Math.min(1, g);
  }

  const sold: number[] = offers.map(() => 0);
  let total = 0;
  if (weightSum > 0) {
    const demand = params.demand;
    let spill = 0;
    offers.forEach((offer, i) => {
      const g = capture[i] ?? 0;
      const w = weights[i] ?? 0;
      const want = Math.floor(demand * g * (w / weightSum));
      const s = Math.min(want, offer.quantity);
      sold[i] = s;
      total += s;
      spill += want - s;
    });
    const cap = Math.floor(demand * maxCapture);
    spill = Math.min(spill, Math.max(0, cap - total));
    for (let i = 0; i < offers.length && spill > 0; i++) {
      const room = (offers[i]?.quantity ?? 0) - (sold[i] ?? 0);
      if (room <= 0) continue;
      const take = Math.min(spill, room);
      sold[i] = (sold[i] ?? 0) + take;
      total += take;
      spill -= take;
    }
  }

  return {
    sold: sold.map((s) => quantity(s)),
    totalSold: quantity(total),
    effectiveSupply,
    capture,
  };
}
