/**
 * Money rounding rules. This file is the ONLY place in the sim that turns a ratio into money
 * (ARCHITECTURE.md section 4, ADR-002, docs/design/accounting.md section 4).
 *
 * Rules:
 *
 * 1. Round once, at the end. Compute with floats as long as needed, then convert to `Money`
 *    exactly once with `scaleMoney`. Never round intermediate results and re-scale them.
 * 2. Half away from zero. `scaleMoney` rounds the float product `amount * ratio` to the nearest
 *    integer; exact halves go away from zero (2.5 -> 3, -2.5 -> -3). The result is symmetric:
 *    `scaleMoney(-a, r) === -scaleMoney(a, r)`. `-0` never escapes (normalised to `0`).
 * 3. Splits always reconcile. Proportional splits use `allocateMoney` (largest remainder):
 *    every part is the truncated share plus at most one extra minor unit, the extra units go to
 *    the largest fractional remainders, ties to the LOWEST index, and the parts always sum exactly
 *    to the total. For a negative total the split is done on the magnitude and negated, so the rule
 *    is sign-symmetric.
 * 4. Inputs are validated. A non-finite ratio, or weights that are negative, non-finite, empty or
 *    sum to zero, throw `InvariantError` (a caller passing such values is a bug). A result outside
 *    the safe-integer range throws `InvariantError('money.unsafe')`.
 *
 * Determinism: only IEEE-754 basic operations (`*`, `/`, `+`, `-`), `Math.floor`, `Math.trunc`
 * and `Math.abs` are used, all exactly specified by ECMAScript; the weight sum is accumulated in
 * array order.
 */
import { InvariantError, money, type Money } from '../schema/index.js';

/**
 * Rounds a finite float to the nearest integer, halves away from zero.
 *
 * Implemented as `sign(x) * (floor(|x|) + (|x| - floor(|x|) >= 0.5 ? 1 : 0))`. This is the design
 * doc's `sign(x) * floor(|x| + 0.5)` without its one float pitfall: `|x| + 0.5` can round up
 * (e.g. `0.49999999999999994 + 0.5 === 1`), whereas `|x| - floor(|x|)` is computed exactly.
 */
export function roundHalfAwayFromZero(x: number): number {
  if (!Number.isFinite(x)) {
    throw new InvariantError('money.non_finite', `cannot round ${String(x)}`, { value: x });
  }
  const a = Math.abs(x);
  const f = Math.floor(a);
  const r = a - f >= 0.5 ? f + 1 : f;
  if (r === 0) return 0; // never -0
  return x < 0 ? -r : r;
}

/**
 * `amount * ratio`, rounded half away from zero (rule 2). `ratio` must be finite.
 * Throws `InvariantError('money.non_finite_ratio')` otherwise, and `money.unsafe` if the result
 * leaves the safe-integer range.
 */
export function scaleMoney(amount: Money, ratio: number): Money {
  if (!Number.isFinite(ratio)) {
    throw new InvariantError('money.non_finite_ratio', `ratio must be finite: ${String(ratio)}`, {
      amount,
      ratio,
    });
  }
  return money(roundHalfAwayFromZero(amount * ratio));
}

/**
 * Splits `total` proportionally to `weights` with the largest-remainder method (rule 3).
 *
 * - `weights` must be non-empty, every weight finite and `>= 0`, and their sum `> 0`; otherwise
 *   throws `InvariantError('money.invalid_weights')`.
 * - `raw_i = |total| * w_i / Σw`, `base_i = trunc(raw_i)`; the `|total| - Σ base` leftover units go
 *   one each to the indices with the largest `raw_i - base_i`, ties to the lowest index; the result
 *   is negated for a negative total.
 * - Guarantees: `Σ result === total`, `|result_i - raw_i| < 1` (up to float error in `raw_i`), a
 *   zero weight gets `0`, and the result depends only on the inputs.
 */
export function allocateMoney(total: Money, weights: readonly number[]): Money[] {
  if (!Number.isSafeInteger(total)) {
    throw new InvariantError('money.unsafe', `total is not a safe integer: ${String(total)}`, {
      total,
    });
  }
  if (weights.length === 0) {
    throw new InvariantError('money.invalid_weights', 'weights must not be empty');
  }
  let weightSum = 0;
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) {
      throw new InvariantError('money.invalid_weights', `invalid weight ${String(w)}`, {
        weight: w,
      });
    }
    weightSum += w;
  }
  if (!(weightSum > 0) || !Number.isFinite(weightSum)) {
    throw new InvariantError('money.invalid_weights', 'weights must sum to a finite value > 0', {
      weightSum,
    });
  }

  const magnitude = Math.abs(total);
  const parts: number[] = [];
  const fractions: number[] = [];
  let assigned = 0;
  for (const w of weights) {
    const raw = w === 0 ? 0 : (magnitude * w) / weightSum;
    const base = Math.min(Math.trunc(raw), magnitude);
    parts.push(base);
    fractions.push(raw - base);
    assigned += base;
  }

  let leftover = magnitude - assigned;
  if (leftover !== 0) {
    // Indices by fractional remainder: descending (largest first), ties to the lowest index.
    const order = parts.map((_, i) => i);
    order.sort((a, b) => {
      const fa = fractions[a] ?? 0;
      const fb = fractions[b] ?? 0;
      return fa > fb ? -1 : fa < fb ? 1 : a - b;
    });
    // Zero weights never receive units.
    const eligible = order.filter((i) => (weights[i] ?? 0) > 0);
    if (leftover > 0) {
      // Normally leftover < eligible.length; cycling only guards against float error.
      for (let k = 0; leftover > 0; k++) {
        const i = eligible[k % eligible.length] ?? 0;
        parts[i] = (parts[i] ?? 0) + 1;
        leftover -= 1;
      }
    } else {
      // Float error over-assigned (only possible when a raw share sat within an ulp of an integer):
      // take units back from the smallest remainders, ties to the highest index.
      const reverse = eligible.slice().reverse();
      for (let k = 0; leftover < 0; k++) {
        const i = reverse[k % reverse.length] ?? 0;
        if ((parts[i] ?? 0) > 0) {
          parts[i] = (parts[i] ?? 0) - 1;
          leftover += 1;
        }
      }
    }
  }

  const negative = total < 0;
  return parts.map((p) => money(negative ? -p : p));
}
