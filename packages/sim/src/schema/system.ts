/** System identifiers and the canonical execution order (ARCHITECTURE.md section 6.1). */
import { z } from 'zod';

export type SystemId =
  | 'core'
  | 'accounting'
  | 'economy'
  | 'manufacturing'
  | 'logistics'
  | 'retail'
  | 'finance'
  | 'ai'
  | 'hr';

/** Canonical order within every phase. Contains every `SystemId` exactly once. */
export const SYSTEM_ORDER: readonly SystemId[] = [
  'core',
  'accounting',
  'economy',
  'manufacturing',
  'logistics',
  'retail',
  'finance',
  'ai',
  'hr',
];

export const SystemIdSchema = z.enum([
  'core',
  'accounting',
  'economy',
  'manufacturing',
  'logistics',
  'retail',
  'finance',
  'ai',
  'hr',
]) satisfies z.ZodType<SystemId>;

export function isSystemId(value: unknown): value is SystemId {
  return SystemIdSchema.safeParse(value).success;
}

/** Position of `id` in `SYSTEM_ORDER`, for sorting systems. */
export function systemOrderIndex(id: SystemId): number {
  return SYSTEM_ORDER.indexOf(id);
}
