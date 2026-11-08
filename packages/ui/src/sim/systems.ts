/**
 * The ONE place the UI decides which systems and scenario a game is built from.
 * Pass 2 swaps these for `DEFAULT_SYSTEMS` and the content-backed `vertical_slice` scenario.
 */
import { accountingSystem } from '@nepo/sim/accounting';
import type { AnySystem } from '@nepo/sim/engine';
import { SMOKE_SCENARIO, type Scenario } from '@nepo/sim/schema';

export const SYSTEMS: readonly AnySystem[] = [accountingSystem];

export const DEFAULT_SCENARIO: Scenario = SMOKE_SCENARIO;

export const DEFAULT_SEED = 1;
