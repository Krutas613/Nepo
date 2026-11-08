/** Scenario: the authored starting conditions of a world (ARCHITECTURE.md section 15, ADR-010). */
import { z } from 'zod';
import { CompanyNameSchema } from './company.js';
import { ContentPackSchema, EMPTY_CONTENT_PACK, type ContentPack } from './content.js';
import { CityIdSchema, type CityId } from './ids.js';
import { MAX_SCENARIO_STARTING_CASH, MoneySchema, SafeIntegerSchema, type Money } from './money.js';

/** Controllers a scenario may assign; `npc` companies are created by systems, not scenarios. */
export type ScenarioController = 'player' | 'ai';

export interface ScenarioCompany {
  name: string;
  controller: ScenarioController;
  /** Opening capital in minor units, posted Dr 1000 / Cr 3000 by accounting. Non-negative. */
  startingCash: Money;
  /** Informational home city (UI default); must exist in `content.cities`. */
  homeCity?: CityId;
}

export interface Scenario {
  id: string;
  name: string;
  /** Calendar year of tick 0. */
  epochYear: number;
  /** Company `i` (0-based) becomes `co_00000{i+1}`. */
  companies: ScenarioCompany[];
  /**
   * Authored content (ADR-010). Required in the type; `ScenarioSchema` fills a missing value with
   * `EMPTY_CONTENT_PACK`, so v1 envelopes, fixtures and `data/scenarios/*.json` still parse.
   */
  content: ContentPack;
}

export const ScenarioControllerSchema = z.enum([
  'player',
  'ai',
]) satisfies z.ZodType<ScenarioController>;

export const ScenarioCompanySchema = z.strictObject({
  name: CompanyNameSchema,
  controller: ScenarioControllerSchema,
  startingCash: MoneySchema.refine((m) => m >= 0, 'startingCash must not be negative'),
  homeCity: CityIdSchema.exactOptional(),
}) satisfies z.ZodType<ScenarioCompany>;

/**
 * Validates a scenario. Beyond shape: total starting cash must not exceed 2^50 minor units
 * (ADR-002); every `homeCity` exists in `content.cities`. A missing `content` parses as a fresh
 * copy of `EMPTY_CONTENT_PACK` (validated like any other pack).
 */
export const ScenarioSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    epochYear: SafeIntegerSchema,
    companies: z.array(ScenarioCompanySchema),
    content: ContentPackSchema.prefault(EMPTY_CONTENT_PACK),
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
    scenario.companies.forEach((c, i) => {
      if (c.homeCity !== undefined && scenario.content.cities[c.homeCity] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['companies', i, 'homeCity'],
          message: `unknown city '${c.homeCity}'`,
        });
      }
    });
  }) satisfies z.ZodType<Scenario>;
