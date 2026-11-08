import { accountingSystem } from '@nepo/sim/accounting';
import { createWorld, step, type World } from '@nepo/sim/engine';
import { SMOKE_SCENARIO, type Scenario } from '@nepo/sim/schema';

export const SYSTEMS = [accountingSystem];
export const SEEDS = [1, 2, 3, 4, 5];

export function makeWorld(seed: number, scenario: Scenario = SMOKE_SCENARIO): World {
  return createWorld({ seed, scenario, systems: SYSTEMS });
}

export function advance(
  world: World,
  ticks: number,
  opts?: { checkSliceOwnership?: boolean },
): void {
  for (let i = 0; i < ticks; i++) step(world, opts);
}
