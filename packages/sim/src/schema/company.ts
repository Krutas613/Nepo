/** Company: the core slice entity, owned by the engine's built-in `core` system. */
import { z } from 'zod';
import { CompanyIdSchema, type CompanyId } from './ids.js';
import { NonNegativeIntegerSchema } from './money.js';

export type CompanyController = 'player' | 'ai' | 'npc';

export interface Company {
  id: CompanyId;
  name: string;
  controller: CompanyController;
  /** Ownership parent (subsidiaries, M2+); `null` for independent companies. */
  parentId: CompanyId | null;
  foundedTick: number;
}

export const CompanyControllerSchema = z.enum([
  'player',
  'ai',
  'npc',
]) satisfies z.ZodType<CompanyController>;

/** A company name: non-empty after trimming. */
export const CompanyNameSchema = z
  .string()
  .refine((s) => s.trim().length > 0, 'name must not be empty');

export const CompanySchema = z.strictObject({
  id: CompanyIdSchema,
  name: CompanyNameSchema,
  controller: CompanyControllerSchema,
  parentId: CompanyIdSchema.nullable(),
  foundedTick: NonNegativeIntegerSchema,
}) satisfies z.ZodType<Company>;
