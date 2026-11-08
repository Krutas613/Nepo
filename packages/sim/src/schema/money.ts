/**
 * Money and quantities (ARCHITECTURE.md section 4, ADR-002).
 *
 * `Money` is integer minor units (cents) and may be negative. `Quantity` is an integer count of
 * units and is never negative. Both are asserted `Number.isSafeInteger` at every construction and
 * arithmetic step; an unsafe result throws `InvariantError`, never wraps silently.
 *
 * Rounding (ratio -> money) is owned by accounting (`scaleMoney`, `allocateMoney`); nothing here
 * rounds. `-0` is normalised to `0` because `-0` is forbidden in state.
 */
import { z } from 'zod';
import { InvariantError } from './errors.js';
import type { Brand } from './ids.js';

export type Money = Brand<number, 'Money'>;
export type Quantity = Brand<number, 'Quantity'>;

/** Total scenario starting cash must not exceed 2^50 minor units (ADR-002 headroom rule). */
export const MAX_SCENARIO_STARTING_CASH = 2 ** 50;

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

/** Constructs `Money`. Throws `InvariantError('money.unsafe')` unless `Number.isSafeInteger(n)`. */
export function money(n: number): Money {
  if (!Number.isSafeInteger(n)) {
    throw new InvariantError('money.unsafe', `not a safe integer: ${String(n)}`, { value: n });
  }
  return (n === 0 ? 0 : n) as Money;
}

export const ZERO_MONEY: Money = money(0);

export function isMoney(n: unknown): n is Money {
  return typeof n === 'number' && Number.isSafeInteger(n) && !Object.is(n, -0);
}

export function addMoney(a: Money, b: Money): Money {
  return money(a + b);
}

export function subMoney(a: Money, b: Money): Money {
  return money(a - b);
}

export function negMoney(a: Money): Money {
  return money(0 - a);
}

export function absMoney(a: Money): Money {
  return money(Math.abs(a));
}

/** Exact integer multiple, e.g. unit price x units. `factor` must be a safe integer (no rounding here). */
export function mulMoney(a: Money, factor: number): Money {
  if (!Number.isSafeInteger(factor)) {
    throw new InvariantError('money.unsafe', `factor is not a safe integer: ${String(factor)}`, {
      factor,
    });
  }
  return money(a * factor);
}

/** Sum in array order; every partial sum is range-checked. */
export function sumMoney(amounts: readonly Money[]): Money {
  let total = ZERO_MONEY;
  for (const a of amounts) total = addMoney(total, a);
  return total;
}

/** -1, 0 or 1. Suitable as an `Array.prototype.sort` comparator. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minMoney(a: Money, b: Money): Money {
  return a <= b ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return a >= b ? a : b;
}

export function isPositiveMoney(a: Money): boolean {
  return a > 0;
}

export function isNegativeMoney(a: Money): boolean {
  return a < 0;
}

// ---------------------------------------------------------------------------------------------
// Quantity
// ---------------------------------------------------------------------------------------------

/**
 * Constructs `Quantity`. Throws `InvariantError('quantity.unsafe')` unless `Number.isSafeInteger(n)`,
 * and `InvariantError('quantity.negative')` if `n < 0`.
 */
export function quantity(n: number): Quantity {
  if (!Number.isSafeInteger(n)) {
    throw new InvariantError('quantity.unsafe', `not a safe integer: ${String(n)}`, { value: n });
  }
  if (n < 0) {
    throw new InvariantError('quantity.negative', `negative quantity: ${String(n)}`, { value: n });
  }
  return (n === 0 ? 0 : n) as Quantity;
}

export const ZERO_QUANTITY: Quantity = quantity(0);

export function isQuantity(n: unknown): n is Quantity {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
}

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  return quantity(a + b);
}

/** Throws `InvariantError('quantity.negative')` if `b > a`. */
export function subQuantity(a: Quantity, b: Quantity): Quantity {
  return quantity(a - b);
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// zod numeric building blocks (shared by every schema in this module)
// ---------------------------------------------------------------------------------------------

const notNegativeZero = (n: number): boolean => !Object.is(n, -0);

/** Finite number, not `-0` (zod 4 `z.number()` already rejects NaN and +-Infinity). */
export const FiniteNumberSchema = z.number().refine(notNegativeZero, 'must not be -0');

/** Safe integer (zod 4 `z.int()` is the safe-integer range), not `-0`. */
export const SafeIntegerSchema = z.int().refine(notNegativeZero, 'must not be -0');

/** Non-negative safe integer: ticks, seqs, counters. */
export const NonNegativeIntegerSchema = z.int().min(0).refine(notNegativeZero, 'must not be -0');

export const MoneySchema: z.ZodType<Money, number> = SafeIntegerSchema.transform((n) => n as Money);

export const QuantitySchema: z.ZodType<Quantity, number> = NonNegativeIntegerSchema.transform(
  (n) => n as Quantity,
);
