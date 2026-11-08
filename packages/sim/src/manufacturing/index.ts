/**
 * Nepo `manufacturing` module: facilities, construction, production (WIP), input and finished-goods
 * lots and their postings (docs/design/manufacturing.md, ADR-012). Owned by the `manufacturing`
 * agent.
 *
 * Other systems use `ctx.services.get(MANUFACTURING_SERVICE)` (retail: `withdraw`). The pure helpers
 * are for the UI (previews) and tests; `checkManufacturingInvariants` is for sim-tests.
 */
export { manufacturingSystem } from './system.js';
export {
  MANUFACTURING_SERVICE,
  createManufacturingApi,
  type ManufacturingApi,
  type WithdrawError,
  type WithdrawErrorCode,
  type Withdrawal,
} from './service.js';
export { MANUFACTURING_COMMANDS, applyCommand, type CommandEnv } from './commands.js';
export {
  affordableUnits,
  chargeDepreciation,
  chargeOperatingCost,
  completeWip,
  insertWip,
  runFacilityDay,
  startBatches,
  type ProductionEnv,
  type RawPrice,
} from './production.js';
export {
  advanceConstruction,
  batchesThatFit,
  constructionCompletesTick,
  depreciationSchedule,
  newFacility,
  nextDepreciationCharge,
  pendingOutput,
  previewBuild,
  previewBuildCost,
  primaryOutput,
  wipBatchCount,
  type BuildPreview,
  type ManufacturingContent,
  type NewFacilityArgs,
} from './facility.js';
export {
  emptyLot,
  issueCost,
  issueFromLot,
  lotFor,
  receiveIntoLot,
  totalLotValue,
  unitCostOf,
} from './lots.js';
export {
  checkManufacturingInvariants,
  ppeByEntity,
  type ManufacturingInvariantCode,
  type ManufacturingInvariantInput,
  type ManufacturingInvariantViolation,
} from './invariants.js';
