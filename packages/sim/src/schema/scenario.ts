/** Scenario: the authored starting conditions of a world (ARCHITECTURE.md section 15). */
import { z } from 'zod';
import { CompanyNameSchema } from './company.js';
import { MAX_SCENARIO_STARTING_CASH, MoneySchema, SafeIntegerSchema, type Money } from './money.js';

/** Controllers a scenario may assign; `npc` companies are created by systems, not scenarios. */
export type ScenarioController = 'player' | 'ai';

export interface ScenarioCompany {
  name: string;
  controller: ScenarioController;
  /** Opening capital in minor units, posted Dr 1000 / Cr 3000 by accounting. Non-negative. */
  startingCash: Money;
}

export interface Scenario {
  id: string;
  name: string;
  /** Calendar year of tick 0. */
  epochYear: number;
  /** Company `i` (0-based) becomes `co_00000{i+1}`. */
  companies: ScenarioCompany[];
}

export const ScenarioControllerSchema = z.enum([
  'player',
  'ai',
]) satisfies z.ZodType<ScenarioController>;

export const ScenarioCompanySchema = z.strictObject({
  name: CompanyNameSchema,
  controller: ScenarioControllerSchema,
  startingCash: MoneySchema.refine((m) => m >= 0, 'startingCash must not be negative'),
}) satisfies z.ZodType<ScenarioCompany>;

/**
 * Validates a scenario. Beyond shape: total starting cash must not exceed 2^50 minor units
 * (ADR-002), so the economy keeps three orders of magnitude of headroom before 2^53.
 */
export const ScenarioSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    epochYear: SafeIntegerSchema,
    companies: z.array(ScenarioCompanySchema),
  })
  .superRefine((scenario, ctx) => {
    let total = 0;
    for (const c of scenario.companies) total += c.startingCash;
    if (total > MAX_SCENARIO_STARTING_CASH) {
      ctx.addIssue({
        code: 'custom',
        path: ['companies'],
        message: `total startingCash ${String(total)} exceeds 2^50 minor units`,
      });
    }
  }) satisfies z.ZodType<Scenario>;
