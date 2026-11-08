/**
 * Nepo `economy` module: markets, price discovery, demand and the NPC commodity source
 * (docs/design/economy.md, ADR-011). Owned by the `economy` agent.
 *
 * Other systems use `ctx.services.get(ECONOMY_SERVICE)`. The pure helpers are for the UI/AI
 * (previews) and tests; `checkEconomyInvariants` is for sim-tests.
 */
export { economySystem } from './system.js';
export {
  ECONOMY_SERVICE,
  createEconomyApi,
  type EconomyApi,
  type MarketClearing,
  type MarketOffer,
  type RawQuote,
} from './service.js';
export {
  MIN_PRICE,
  captureFraction,
  clamp,
  demandResponse,
  imbalance,
  levelBounds,
  levelTarget,
  maxLevelStep,
  priceAtLevel,
  relaxLevel,
  updateImbalanceEma,
} from './pricing.js';
export {
  clearOffers,
  type ClearingOffer,
  type ClearingParams,
  type ClearingResult,
} from './clearing.js';
export {
  advanceCommodity,
  advanceDay,
  advanceProductMarket,
  anchorPrice,
  anchorPriceOf,
  applyMacro,
  baselineDemand,
  clearConsumerMarketIn,
  createEconomyState,
  expectedCaptureFor,
  marketOfCityIn,
  quoteRawFrom,
  recordRawPurchase,
  type ConsumerClearing,
  type EconomyEnv,
  type ReadonlyContent,
  type ReadonlyEconomyState,
} from './state.js';
export {
  checkEconomyInvariants,
  type EconomyInvariantCode,
  type EconomyInvariantViolation,
} from './invariants.js';
