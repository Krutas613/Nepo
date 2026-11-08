/** Shared scenario fixtures for tests (ARCHITECTURE.md sections 13, 15). Deep-frozen. */
import { money } from './money.js';
import type { Scenario } from './scenario.js';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** No companies. */
export const EMPTY_SCENARIO: Scenario = deepFreeze({
  id: 'empty',
  name: 'Empty world',
  epochYear: 2000,
  companies: [],
});

/** Two companies (player + ai), 100,000,000 minor units of starting cash each. */
export const SMOKE_SCENARIO: Scenario = deepFreeze({
  id: 'smoke',
  name: 'Smoke test',
  epochYear: 2000,
  companies: [
    { name: 'Player Holdings', controller: 'player', startingCash: money(100_000_000) },
    { name: 'Rival Industries', controller: 'ai', startingCash: money(100_000_000) },
  ],
});
