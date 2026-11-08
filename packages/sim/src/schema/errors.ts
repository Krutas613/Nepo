/**
 * Error classes (ARCHITECTURE.md section 12). These are runtime objects, never part of state.
 *
 * - Player/AI mistakes are never thrown (shape errors are returned from `submit`, semantic errors
 *   become `command.rejected` events).
 * - Impossible states throw `InvariantError` with a stable dotted `code` (e.g. `money.unsafe`).
 */

export type ErrorDetails = Record<string, unknown>;

/**
 * Base error. Constructor accepts either `(code, message?, details?)` or `(code, details)`;
 * the message defaults to the code.
 */
export class NepoError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(code: string, messageOrDetails?: string | ErrorDetails, details?: ErrorDetails) {
    const message = typeof messageOrDetails === 'string' ? messageOrDetails : code;
    super(message === code ? code : `${code}: ${message}`);
    this.name = new.target.name;
    this.code = code;
    this.details = typeof messageOrDetails === 'object' ? messageOrDetails : (details ?? {});
  }
}

/** A bug: an impossible state was reached. The world is poisoned; callers must not continue. */
export class InvariantError extends NepoError {}

/** An unreadable, mismatched (`hash_mismatch`) or too-new (`too_new`) snapshot. */
export class SnapshotError extends NepoError {}

/** Throws `InvariantError(code, message, details)` unless `condition` is truthy. */
export function invariant(
  condition: unknown,
  code: string,
  message: string,
  details?: ErrorDetails,
): asserts condition {
  if (!condition) {
    throw new InvariantError(code, message, details ?? {});
  }
}
