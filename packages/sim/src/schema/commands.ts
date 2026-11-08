/**
 * Commands (ARCHITECTURE.md section 7.1): the only way anything outside a system changes state.
 * Flat discriminated union on `type` (`'<domain>.<verb>'`, lower snake case). Payloads are plain data.
 *
 * Shape validation here is structural only. Semantic checks (ownership, non-empty names,
 * affordability) belong to the handling system and produce `command.rejected` events.
 */
import { z } from 'zod';
import {
  CityIdSchema,
  CompanyIdSchema,
  FacilityIdSchema,
  FacilityTypeIdSchema,
  LoanIdSchema,
  ProductIdSchema,
  RecipeIdSchema,
  StoreFormatIdSchema,
  StoreIdSchema,
  type CityId,
  type CompanyId,
  type DistributiveOmit,
  type FacilityId,
  type FacilityTypeId,
  type LoanId,
  type ProductId,
  type RecipeId,
  type StoreFormatId,
  type StoreId,
} from './ids.js';
import {
  MoneySchema,
  NonNegativeIntegerSchema,
  QuantitySchema,
  type Money,
  type Quantity,
} from './money.js';
import { err, ok, type Result } from './result.js';

export interface CommandBase {
  /** Global monotonic sequence number stamped by `submit` (`++state.commandSeq`). */
  seq: number;
  /** The tick whose `ingest` phase processes this command. */
  tick: number;
  issuer: CompanyId;
}

// ---------------------------------------------------------------------------------------------
// core
// ---------------------------------------------------------------------------------------------

export interface RenameCompanyPayload {
  name: string;
  /**
   * Target company. Omitted means the issuer itself. Present so the `core` handler can reject
   * `not_owner` when `companyId !== issuer` (docs/design/engine.md section 3).
   */
  companyId?: CompanyId;
}

export interface RenameCompanyCommand extends CommandBase {
  type: 'company.rename';
  payload: RenameCompanyPayload;
}

// ---------------------------------------------------------------------------------------------
// manufacturing (docs/design/manufacturing.md section 4)
// ---------------------------------------------------------------------------------------------

export interface BuildFacilityPayload {
  companyId: CompanyId;
  facilityTypeId: FacilityTypeId;
  cityId: CityId;
}

export interface BuildFacilityCommand extends CommandBase {
  type: 'facility.build';
  payload: BuildFacilityPayload;
}

export interface SetRecipePayload {
  facilityId: FacilityId;
  /** `null` clears the recipe. */
  recipeId: RecipeId | null;
}

export interface SetRecipeCommand extends CommandBase {
  type: 'facility.set_recipe';
  payload: SetRecipePayload;
}

export interface SetProductionPayload {
  facilityId: FacilityId;
  /** 0 = off; clamped to capacity by the handler. */
  targetBatches: Quantity;
}

export interface SetProductionCommand extends CommandBase {
  type: 'facility.set_production';
  payload: SetProductionPayload;
}

// ---------------------------------------------------------------------------------------------
// retail (docs/design/retail.md section 4)
// ---------------------------------------------------------------------------------------------

export interface BuildStorePayload {
  companyId: CompanyId;
  storeFormatId: StoreFormatId;
  cityId: CityId;
}

export interface BuildStoreCommand extends CommandBase {
  type: 'store.build';
  payload: BuildStorePayload;
}

export interface SetPricePayload {
  storeId: StoreId;
  productId: ProductId;
  /** `null` = sell at the reference price; `< 1` is rejected by the handler (`invalid_price`). */
  price: Money | null;
}

export interface SetPriceCommand extends CommandBase {
  type: 'store.set_price';
  payload: SetPricePayload;
}

export interface SetRestockPolicyPayload {
  storeId: StoreId;
  productId: ProductId;
  /** `null` = no restocking. */
  sourceFacilityId: FacilityId | null;
  targetStock: Quantity;
}

export interface SetRestockPolicyCommand extends CommandBase {
  type: 'store.set_restock_policy';
  payload: SetRestockPolicyPayload;
}

// ---------------------------------------------------------------------------------------------
// finance (docs/design/finance.md section 5)
// ---------------------------------------------------------------------------------------------

export interface RequestLoanPayload {
  companyId: CompanyId;
  /** Any `Money` shape-wise; underwriting rejects out-of-range principals. */
  principal: Money;
  /** int >= 1. */
  termMonths: number;
}

export interface RequestLoanCommand extends CommandBase {
  type: 'loan.request';
  payload: RequestLoanPayload;
}

export interface RepayLoanPayload {
  loanId: LoanId;
  /** Any `Money` shape-wise; `< 1` is rejected by the handler (`invalid_amount`). */
  amount: Money;
}

export interface RepayLoanCommand extends CommandBase {
  type: 'loan.repay';
  payload: RepayLoanPayload;
}

/** Every command. */
export type Command =
  | RenameCompanyCommand
  | BuildFacilityCommand
  | SetRecipeCommand
  | SetProductionCommand
  | BuildStoreCommand
  | SetPriceCommand
  | SetRestockPolicyCommand
  | RequestLoanCommand
  | RepayLoanCommand;

export type CommandType = Command['type'];

/** What `submit()` takes: a command without the engine-stamped `seq` and `tick`. */
export type CommandInput = DistributiveOmit<Command, 'seq' | 'tick'>;

/** Every command type, in declaration order. */
export const COMMAND_TYPES: readonly CommandType[] = [
  'company.rename',
  'facility.build',
  'facility.set_recipe',
  'facility.set_production',
  'store.build',
  'store.set_price',
  'store.set_restock_policy',
  'loan.request',
  'loan.repay',
];

/** Returned by `submit` when the input fails shape validation. */
export interface CommandValidationError {
  code: 'invalid_shape';
  issues: string[];
}

// ---------------------------------------------------------------------------------------------
// zod validators (shape only; semantics belong to the handling system)
// ---------------------------------------------------------------------------------------------

export const CommandTypeSchema = z.enum([
  'company.rename',
  'facility.build',
  'facility.set_recipe',
  'facility.set_production',
  'store.build',
  'store.set_price',
  'store.set_restock_policy',
  'loan.request',
  'loan.repay',
]) satisfies z.ZodType<CommandType>;

export const RenameCompanyPayloadSchema = z.strictObject({
  name: z.string(),
  companyId: CompanyIdSchema.exactOptional(),
}) satisfies z.ZodType<RenameCompanyPayload>;

export const BuildFacilityPayloadSchema = z.strictObject({
  companyId: CompanyIdSchema,
  facilityTypeId: FacilityTypeIdSchema,
  cityId: CityIdSchema,
}) satisfies z.ZodType<BuildFacilityPayload>;

export const SetRecipePayloadSchema = z.strictObject({
  facilityId: FacilityIdSchema,
  recipeId: RecipeIdSchema.nullable(),
}) satisfies z.ZodType<SetRecipePayload>;

export const SetProductionPayloadSchema = z.strictObject({
  facilityId: FacilityIdSchema,
  targetBatches: QuantitySchema,
}) satisfies z.ZodType<SetProductionPayload>;

export const BuildStorePayloadSchema = z.strictObject({
  companyId: CompanyIdSchema,
  storeFormatId: StoreFormatIdSchema,
  cityId: CityIdSchema,
}) satisfies z.ZodType<BuildStorePayload>;

export const SetPricePayloadSchema = z.strictObject({
  storeId: StoreIdSchema,
  productId: ProductIdSchema,
  price: MoneySchema.nullable(),
}) satisfies z.ZodType<SetPricePayload>;

export const SetRestockPolicyPayloadSchema = z.strictObject({
  storeId: StoreIdSchema,
  productId: ProductIdSchema,
  sourceFacilityId: FacilityIdSchema.nullable(),
  targetStock: QuantitySchema,
}) satisfies z.ZodType<SetRestockPolicyPayload>;

export const RequestLoanPayloadSchema = z.strictObject({
  companyId: CompanyIdSchema,
  principal: MoneySchema,
  termMonths: z.int().min(1),
}) satisfies z.ZodType<RequestLoanPayload>;

export const RepayLoanPayloadSchema = z.strictObject({
  loanId: LoanIdSchema,
  amount: MoneySchema,
}) satisfies z.ZodType<RepayLoanPayload>;

const commandBaseShape = {
  seq: NonNegativeIntegerSchema,
  tick: NonNegativeIntegerSchema,
  issuer: CompanyIdSchema,
};

export const RenameCompanyCommandSchema = z.strictObject({
  ...commandBaseShape,
  type: z.literal('company.rename'),
  payload: RenameCompanyPayloadSchema,
}) satisfies z.ZodType<RenameCompanyCommand>;

export const BuildFacilityCommandSchema = z.strictObject({
  ...commandBaseShape,
  type: z.literal('facility.build'),
  payload: BuildFacilityPayloadSchema,
}) satisfies z.ZodType<BuildFacilityCommand>;

export const SetRecipeCommandSchema = z.strictObject({
  ...commandBaseShape,
  type: z.literal('facility.set_recipe'),
  payload: SetRecipePayloadSchema,
}) satisfies z.ZodType<SetRecipeCommand>;

export const SetProductionCommandSchema = z.strictObject({
  ...commandBaseShape,
  type: z.literal('facility.set_production'),
  payload: SetProductionPayloadSchema,
}) satisfies z.ZodType<SetProductionCommand>;

export const BuildStoreCommandSchema = z.strictObject({
  ...commandBaseShape,
  type: z.literal('store.build'),
  payload: BuildStorePayloadSchema,
}) satisfies z.ZodType<BuildStoreCommand>;

export const SetPriceCommandSchema = z.strictObject({
  ...commandBaseShape,
  type: z.literal('store.set_price'),
  payload: SetPricePayloadSchema,
}) satisfies z.ZodType<SetPriceCommand>;

export const SetRestockPolicyCommandSchema = z.strictObject({
  ...commandBaseShape,
  type: z.literal('store.set_restock_policy'),
  payload: SetRestockPolicyPayloadSchema,
}) satisfies z.ZodType<SetRestockPolicyCommand>;

export const RequestLoanCommandSchema = z.strictObject({
  ...commandBaseShape,
  type: z.literal('loan.request'),
  payload: RequestLoanPayloadSchema,
}) satisfies z.ZodType<RequestLoanCommand>;

export const RepayLoanCommandSchema = z.strictObject({
  ...commandBaseShape,
  type: z.literal('loan.repay'),
  payload: RepayLoanPayloadSchema,
}) satisfies z.ZodType<RepayLoanCommand>;

/** A full (stamped) command, as stored in `state.pendingCommands`. */
export const CommandSchema = z.discriminatedUnion('type', [
  RenameCompanyCommandSchema,
  BuildFacilityCommandSchema,
  SetRecipeCommandSchema,
  SetProductionCommandSchema,
  BuildStoreCommandSchema,
  SetPriceCommandSchema,
  SetRestockPolicyCommandSchema,
  RequestLoanCommandSchema,
  RepayLoanCommandSchema,
]) satisfies z.ZodType<Command>;

const unstamped = { seq: true, tick: true } as const;

export const RenameCompanyCommandInputSchema = RenameCompanyCommandSchema.omit(
  unstamped,
) satisfies z.ZodType<DistributiveOmit<RenameCompanyCommand, 'seq' | 'tick'>>;

/** Shape validator for `submit()` input (no `seq`/`tick`). */
export const CommandInputSchema = z.discriminatedUnion('type', [
  RenameCompanyCommandInputSchema,
  BuildFacilityCommandSchema.omit(unstamped),
  SetRecipeCommandSchema.omit(unstamped),
  SetProductionCommandSchema.omit(unstamped),
  BuildStoreCommandSchema.omit(unstamped),
  SetPriceCommandSchema.omit(unstamped),
  SetRestockPolicyCommandSchema.omit(unstamped),
  RequestLoanCommandSchema.omit(unstamped),
  RepayLoanCommandSchema.omit(unstamped),
]) satisfies z.ZodType<CommandInput>;

/** Formats zod issues as `path: message` strings for `CommandValidationError.issues`. */
export function formatSchemaIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
}

/** Validates `submit()` input shape. */
export function validateCommandInput(input: unknown): Result<CommandInput, CommandValidationError> {
  const parsed = CommandInputSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err({ code: 'invalid_shape', issues: formatSchemaIssues(parsed.error) });
}
