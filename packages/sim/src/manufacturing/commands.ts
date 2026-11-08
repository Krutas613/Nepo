/**
 * Command handlers for the `apply` phase (docs/design/manufacturing.md section 4). Each command is
 * fully applied or fully rejected: validation precedes every mutation and posting. Written over a
 * small `CommandEnv` so the table of rejections is testable without the engine.
 */
import { SPEND_CLASS, canSpend, capex } from '../accounting/index.js';
import {
  quantity,
  type Command,
  type EventInput,
  type Facility,
  type FacilityId,
  type JournalEntryInput,
  type ManufacturingState,
  type Money,
  type CompanyId,
} from '../schema/index.js';
import { newFacility, type ManufacturingContent } from './facility.js';
import { lotFor } from './lots.js';

export interface CommandEnv {
  readonly tick: number;
  readonly content: ManufacturingContent;
  cash(ownerId: CompanyId): Money;
  post(ownerId: CompanyId, entry: JournalEntryInput): void;
  issueFacilityId(): FacilityId;
  emit(event: EventInput): void;
  reject(command: Command, code: string, reason: string): void;
}

/** Commands this module handles (the `System.handles` list). */
export const MANUFACTURING_COMMANDS = [
  'facility.build',
  'facility.set_recipe',
  'facility.set_production',
] as const satisfies readonly Command['type'][];

/** Applies one command to the slice; commands of other types are ignored. */
export function applyCommand(state: ManufacturingState, command: Command, env: CommandEnv): void {
  if (command.type === 'facility.build') build(state, command, env);
  else if (command.type === 'facility.set_recipe') setRecipe(state, command, env);
  else if (command.type === 'facility.set_production') setProduction(state, command, env);
}

function build(
  state: ManufacturingState,
  command: Extract<Command, { type: 'facility.build' }>,
  env: CommandEnv,
): void {
  const { companyId, facilityTypeId, cityId } = command.payload;
  if (companyId !== command.issuer) {
    env.reject(command, 'not_owner', `${command.issuer} cannot build for ${companyId}`);
    return;
  }
  const type = env.content.facilityTypes[facilityTypeId];
  if (type === undefined) {
    env.reject(command, 'unknown_facility_type', `unknown facility type ${facilityTypeId}`);
    return;
  }
  if (env.content.cities[cityId] === undefined) {
    env.reject(command, 'unknown_city', `unknown city ${cityId}`);
    return;
  }
  const cash = env.cash(companyId);
  if (!canSpend(SPEND_CLASS.capex, cash, type.buildCost)) {
    env.reject(
      command,
      'insufficient_cash',
      `building ${type.name} costs ${String(type.buildCost)} but cash is ${String(cash)}`,
    );
    return;
  }
  const id = env.issueFacilityId();
  const facility = newFacility({ id, ownerId: companyId, type, cityId, orderedTick: env.tick });
  // A zero-cost build has nothing to capitalise (a zero ledger line is invalid).
  if (type.buildCost > 0) {
    env.post(companyId, capex(type.buildCost, 'manufacturing', { ref: { kind: 'facility', id } }));
  }
  state.facilities[id] = facility;
  env.emit({
    type: 'facility.ordered',
    payload: {
      facilityId: id,
      companyId,
      facilityTypeId,
      cityId,
      completesTick: facility.completesTick,
    },
  });
}

function setRecipe(
  state: ManufacturingState,
  command: Extract<Command, { type: 'facility.set_recipe' }>,
  env: CommandEnv,
): void {
  const { facilityId, recipeId } = command.payload;
  const facility: Facility | undefined = state.facilities[facilityId];
  if (facility === undefined) {
    env.reject(command, 'unknown_facility', `unknown facility ${facilityId}`);
    return;
  }
  if (facility.ownerId !== command.issuer) {
    env.reject(command, 'not_owner', `${command.issuer} does not own ${facilityId}`);
    return;
  }
  if (recipeId !== null) {
    const recipe = env.content.recipes[recipeId];
    if (recipe === undefined) {
      env.reject(command, 'unknown_recipe', `unknown recipe ${recipeId}`);
      return;
    }
    if (recipe.facilityType !== facility.typeId) {
      env.reject(
        command,
        'recipe_mismatch',
        `recipe ${recipeId} needs ${recipe.facilityType}, facility is ${facility.typeId}`,
      );
      return;
    }
    // Existing WIP keeps its own recipe. Touch the lots so a withdrawal of a product the recipe
    // makes reads "insufficient" (not "unknown product") before the first batch completes.
    for (const line of recipe.inputs) lotFor(facility.inputs, line.product);
    for (const line of recipe.outputs) lotFor(facility.outputs, line.product);
  }
  facility.recipeId = recipeId;
  env.emit({ type: 'facility.recipe_set', payload: { facilityId, recipeId } });
}

function setProduction(
  state: ManufacturingState,
  command: Extract<Command, { type: 'facility.set_production' }>,
  env: CommandEnv,
): void {
  const { facilityId, targetBatches } = command.payload;
  const facility: Facility | undefined = state.facilities[facilityId];
  if (facility === undefined) {
    env.reject(command, 'unknown_facility', `unknown facility ${facilityId}`);
    return;
  }
  if (facility.ownerId !== command.issuer) {
    env.reject(command, 'not_owner', `${command.issuer} does not own ${facilityId}`);
    return;
  }
  const capacity = env.content.facilityTypes[facility.typeId]?.capacity ?? targetBatches;
  facility.targetBatches = quantity(Math.min(targetBatches, capacity));
  env.emit({
    type: 'facility.production_set',
    payload: { facilityId, targetBatches: facility.targetBatches },
  });
}
