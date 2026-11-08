/**
 * Nepo `retail` module: stores, shelf lots, prices, restocking and daily sales
 * (docs/design/retail.md, ADR-012/013). Owned by the `retail` agent.
 *
 * Other systems use `ctx.services.get(RETAIL_SERVICE)`. The pure functions are for the UI/AI
 * (previews) and tests; `checkRetailInvariants` is for sim-tests.
 */
export { retailSystem } from './system.js';
export {
  RETAIL_SERVICE,
  createRetailApi,
  receiveGoods,
  type ReceiveError,
  type ReceiveErrorCode,
  type ReceiveSource,
  type RetailApi,
} from './service.js';
export { emptyLot, issueFrom, lotInvariantErrors, receiveInto } from './lots.js';
export {
  applyShrinkage,
  buildOffer,
  createStore,
  depreciationCharge,
  effectivePrice,
  freeCapacity,
  newShelfLine,
  resetDay,
  restockQuantity,
  settleSale,
  shelfUnits,
  shelfValue,
  shrinkageUnits,
  unmetDemand,
  type NewStoreInput,
  type ReadonlyStoreFormat,
  type SaleSettlement,
  type ShrinkResult,
} from './store.js';
export {
  validateBuild,
  validateSetPrice,
  validateSetRestockPolicy,
  type BuildFacts,
  type BuildPlan,
  type Rejection,
  type RestockFacts,
  type RetailRejectionCode,
  type StoreProductFacts,
} from './commands.js';
export {
  checkRetailInvariants,
  ppeOfStores,
  type RetailInvariantCode,
  type RetailInvariantState,
  type RetailInvariantViolation,
} from './invariants.js';
export {
  shelfUnitCost,
  storeDayPreview,
  storeSummary,
  type ShelfLineSummary,
  type StoreDayPreview,
  type StoreSummary,
} from './preview.js';
