/**
 * Commands (ARCHITECTURE.md section 7.1): the only way anything outside a system changes state.
 * Flat discriminated union on `type` (`'<domain>.<verb>'`, lower snake case). Payloads are plain data.
 *
 * Shape validation here is structural only. Semantic checks (ownership, non-empty names,
 * affordability) belong to the handling system and produce `command.rejected` events.
 */
import { z } from 'zod';
import { CompanyIdSchema, type CompanyId, type DistributiveOmit } from './ids.js';
import { NonNegativeIntegerSchema } from './money.js';
import { err, ok, type Result } from './result.js';

export interface CommandBase {
  /** Global monotonic sequence number stamped by `submit` (`++state.commandSeq`). */
  seq: number;
  /** The tick whose `ingest` phase processes this command. */
  tick: number;
  issuer: CompanyId;
}

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

/** Every command. M1 adds e.g. `facility.build`, `store.open`, `store.set_price`, `loan.draw`. */
export type Command = RenameCompanyCommand;

export type CommandType = Command['type'];

/** What `submit()` takes: a command without the engine-stamped `seq` and `tick`. */
export type CommandInput = DistributiveOmit<Command, 'seq' | 'tick'>;

/** Every command type, in declaration order. */
export const COMMAND_TYPES: readonly CommandType[] = ['company.rename'];

/** Returned by `submit` when the input fails shape validation. */
export interface CommandValidationError {
  code: 'invalid_shape';
  issues: string[];
}

// ---------------------------------------------------------------------------------------------
// zod validators
// ---------------------------------------------------------------------------------------------

export const CommandTypeSchema = z.enum(['company.rename']) satisfies z.ZodType<CommandType>;

export const RenameCompanyPayloadSchema = z.strictObject({
  name: z.string(),
  companyId: CompanyIdSchema.exactOptional(),
}) satisfies z.ZodType<RenameCompanyPayload>;

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

/** A full (stamped) command, as stored in `state.pendingCommands`. */
export const CommandSchema = z.discriminatedUnion('type', [
  RenameCompanyCommandSchema,
]) satisfies z.ZodType<Command>;

export const RenameCompanyCommandInputSchema = RenameCompanyCommandSchema.omit({
  seq: true,
  tick: true,
}) satisfies z.ZodType<DistributiveOmit<RenameCompanyCommand, 'seq' | 'tick'>>;

/** Shape validator for `submit()` input (no `seq`/`tick`). */
export const CommandInputSchema = z.discriminatedUnion('type', [
  RenameCompanyCommandInputSchema,
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
