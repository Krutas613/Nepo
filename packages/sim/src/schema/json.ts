/**
 * Plain JSON values (ARCHITECTURE.md section 2): the most general shape allowed anywhere in state.
 *
 * Used for slices whose type has not landed yet (see `world.ts`). Numbers must be finite and not
 * `-0`; `undefined`, functions, `Map`/`Set`/`bigint` and class instances are rejected.
 */
import { z } from 'zod';
import { FiniteNumberSchema } from './money.js';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    FiniteNumberSchema,
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
