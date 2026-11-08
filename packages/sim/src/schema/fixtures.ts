/**
 * Shared fixtures for tests (ARCHITECTURE.md sections 13, 15; docs/design/schema-m1.md section 4).
 * Deep-frozen: copy before mutating. `data/` remains the authored source for the game; these exist
 * so unit tests need no file I/O.
 */
import { EMPTY_CONTENT_PACK, type ContentPack } from './content.js';
import { deepFreeze } from './freeze.js';
import {
  bankId,
  cityId,
  facilityTypeId,
  marketId,
  productId,
  recipeId,
  regionId,
  storeFormatId,
} from './ids.js';
import { money, quantity } from './money.js';
import type { Scenario } from './scenario.js';

/** No companies, empty content. */
export const EMPTY_SCENARIO: Scenario = deepFreeze({
  id: 'empty',
  name: 'Empty world',
  epochYear: 2000,
  companies: [],
  content: EMPTY_CONTENT_PACK,
});

/** Two companies (player + ai), 100,000,000 minor units of starting cash each; empty content. */
export const SMOKE_SCENARIO: Scenario = deepFreeze({
  id: 'smoke',
  name: 'Smoke test',
  epochYear: 2000,
  companies: [
    { name: 'Player Holdings', controller: 'player', startingCash: money(100_000_000) },
    { name: 'Rival Industries', controller: 'ai', startingCash: money(100_000_000) },
  ],
  content: EMPTY_CONTENT_PACK,
});

const GRAIN = productId('grain');
const BREAD = productId('bread');
const BAKE_BREAD = recipeId('bake_bread');
const BAKERY = facilityTypeId('bakery');
const GROCERY = storeFormatId('grocery');
const HEARTLAND = regionId('heartland');
const SPRINGFIELD = cityId('springfield');
const SPRINGFIELD_MARKET = marketId('springfield_market');
const FIRST_NATIONAL = bankId('first_national');

/**
 * Minimal M1 content, one of each thing (schema-m1.md section 11 shape): raw `grain` (with a
 * commodity source) baked into consumer `bread` at a `bakery`, sold through a `grocery` in
 * `springfield` (region `heartland`, market `springfield_market`), financed by `first_national`.
 * Prices in cents per kg / per loaf; every price >= 1 minor unit.
 */
export const M1_CONTENT_PACK: ContentPack = deepFreeze({
  products: {
    [BREAD]: {
      id: BREAD,
      name: 'Bread',
      category: 'consumer',
      unit: 'loaf',
      basePrice: money(250),
      elasticity: 1.5,
    },
    [GRAIN]: {
      id: GRAIN,
      name: 'Grain',
      category: 'raw',
      unit: 'kg',
      basePrice: money(30),
      elasticity: 0.5,
    },
  },
  recipes: {
    [BAKE_BREAD]: {
      id: BAKE_BREAD,
      name: 'Bake bread',
      facilityType: BAKERY,
      inputs: [{ product: GRAIN, quantity: quantity(50) }],
      outputs: [{ product: BREAD, quantity: quantity(100) }],
      durationTicks: 2,
      laborCostPerBatch: money(5_000),
    },
  },
  facilityTypes: {
    [BAKERY]: {
      id: BAKERY,
      name: 'Bakery',
      kind: 'factory',
      buildCost: money(5_000_000),
      constructionTicks: 10,
      dailyOperatingCost: money(20_000),
      capacity: quantity(5),
      storageCapacity: quantity(2_000),
      usefulLifeMonths: 120,
    },
  },
  storeFormats: {
    [GROCERY]: {
      id: GROCERY,
      name: 'Grocery',
      buildCost: money(2_000_000),
      constructionTicks: 5,
      dailyOperatingCost: money(10_000),
      shelfCapacity: quantity(1_000),
      usefulLifeMonths: 120,
      categories: ['consumer'],
      shrinkagePerMille: 0,
    },
  },
  regions: {
    [HEARTLAND]: { id: HEARTLAND, name: 'Heartland' },
  },
  cities: {
    [SPRINGFIELD]: {
      id: SPRINGFIELD,
      name: 'Springfield',
      region: HEARTLAND,
      population: quantity(100_000),
    },
  },
  markets: {
    [SPRINGFIELD_MARKET]: {
      id: SPRINGFIELD_MARKET,
      name: 'Springfield',
      city: SPRINGFIELD,
      demand: [{ product: BREAD, baseDailyDemand: quantity(400), priceFactor: 1 }],
    },
  },
  economy: {
    pricing: { alpha: 0.05, beta: 0.25, kappa: 0.3, maxCapture: 1.5 },
    macro: { inflationAnnual: 0, policyRate: 0.04, demandIndex: 1 },
    commodities: {
      [GRAIN]: { product: GRAIN, referenceDailyVolume: quantity(1_000), alpha: 0.1, kappa: 0.25 },
    },
  },
  finance: {
    banks: {
      [FIRST_NATIONAL]: {
        id: FIRST_NATIONAL,
        name: 'First National',
        spreadTiers: [
          { maxLeverage: 0.5, spread: 0.02 },
          { maxLeverage: 1, spread: 0.035 },
          { maxLeverage: 2, spread: 0.05 },
        ],
        minEquity: money(1),
        minTermMonths: 6,
        maxTermMonths: 60,
        minPrincipal: money(100_000),
        maxPrincipalToEquity: 1,
        latePenaltySpread: 0.05,
        defaultAfterMissed: 3,
        overdraftLimit: money(5_000_000),
        overdraftAnnualRate: 0.18,
      },
    },
  },
});

/** schema-m1.md section 11: one player company in `springfield`, `M1_CONTENT_PACK`. */
export const VERTICAL_SLICE_SCENARIO: Scenario = deepFreeze({
  id: 'vertical_slice',
  name: 'Vertical slice',
  epochYear: 2000,
  companies: [
    {
      name: 'Player Co',
      controller: 'player',
      startingCash: money(50_000_000),
      homeCity: SPRINGFIELD,
    },
  ],
  content: M1_CONTENT_PACK,
});
