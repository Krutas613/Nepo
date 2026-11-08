/**
 * Plain JSON values (ARCHITECTURE.md section 2): the most general shape allowed anywhere in state.
 *
 * Used for slices whose type has not landed yet (see `world.ts`). Numbers must be finite and not
 * `-0`; `undefined`, functions, `Map`/`Set`/`bigint` and class instances are rejected; object keys
 * must not be integer-like (`RecordKeySchema`, the state-wide record key rule).
 */
import { z } from 'zod';
import { RecordKeySchema } from './ids.js';
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
    z.record(RecordKeySchema, JsonValueSchema),
  ]),
);
