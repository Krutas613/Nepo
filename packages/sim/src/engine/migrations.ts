/**
 * Snapshot state migrations (ARCHITECTURE.md section 11).
 *
 * An ordered table of steps keyed by the version they migrate FROM: `MIGRATIONS[n]` turns a
 * version-`n` state into a version-`n + 1` state. Steps are authored by the engine agent from the
 * schema agent's migration notes in docs/schema-requests.md.
 *
 * Steps run on UNVALIDATED input (the envelope leaves `state` as `unknown`; `restore` deep-validates
 * the result with `SnapshotSchema`). So every step is defensive: it rewrites only the parts that have
 * the expected shape, leaves anything else as it is for validation to reject, never throws on
 * malformed input, and never mutates its argument (it returns new objects along the changed paths).
 */
import { EMPTY_TYPED_SLICES, SCHEMA_VERSION, SnapshotError } from '../schema/index.js';

export type MigrationStep = (state: unknown) => unknown;
export type MigrationTable = Readonly<Partial<Record<number, MigrationStep>>>;

// -------------------------------------------------------------------------------------------------
// v1 -> v2 (docs/schema-requests.md changelog, "Migration note v1 -> v2"; REQ-002, REQ-004)
// -------------------------------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Plain-JSON deep copy (sources are schema's deep-frozen constants). */
function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** `Object.fromEntries` defines own properties, so a hostile `__proto__` key stays inert. */
function mapRecord(
  record: JsonRecord,
  fn: (key: string, value: unknown) => [string, unknown],
): JsonRecord {
  return Object.fromEntries(Object.keys(record).map((key) => fn(key, record[key])));
}

/** Note step 2: `'1000'` -> `'a1000'`; anything else (already prefixed, malformed) unchanged. */
export function rekeyAccountCode(code: string): string {
  return /^[0-9]{4}$/.test(code) ? 'a' + code : code;
}

function rekeyKeys(value: unknown): unknown {
  return isRecord(value) ? mapRecord(value, (k, v) => [rekeyAccountCode(k), v]) : value;
}

/**
 * Chart rows that REQ-004 adds to every ledger migrated from v1. Hard-coded because the engine may
 * not import accounting (schema <- engine <- accounting); a test asserts they equal accounting's
 * `STANDARD_CHART` rows (plus `balance: 0`).
 */
export const V2_ADDED_ACCOUNTS: readonly { code: string; name: string; type: 'asset' }[] =
  Object.freeze([
    Object.freeze({ code: 'a1205', name: 'Inventory - Work in Progress', type: 'asset' as const }),
    Object.freeze({ code: 'a1230', name: 'Inventory - Merchandise', type: 'asset' as const }),
  ]);

/** Note step 1: replace `economy`/`manufacturing`/`retail`/`finance` with fresh empty slices. */
function installTypedSlicesV2(state: JsonRecord): JsonRecord {
  return {
    ...state,
    economy: jsonCopy(EMPTY_TYPED_SLICES.economy),
    manufacturing: jsonCopy(EMPTY_TYPED_SLICES.manufacturing),
    retail: jsonCopy(EMPTY_TYPED_SLICES.retail),
    finance: jsonCopy(EMPTY_TYPED_SLICES.finance),
  };
}

function rekeyReport(report: unknown): unknown {
  if (!isRecord(report)) return report;
  const out: JsonRecord = { ...report };
  for (const part of ['income', 'balance'] as const) {
    const statement = report[part];
    if (isRecord(statement))
      out[part] = { ...statement, byAccount: rekeyKeys(statement['byAccount']) };
  }
  return out;
}

function rekeyLedger(ledger: unknown): unknown {
  if (!isRecord(ledger)) return ledger;
  const out: JsonRecord = { ...ledger };
  const accounts = ledger['accounts'];
  if (isRecord(accounts)) {
    out['accounts'] = mapRecord(accounts, (k, account) => [
      rekeyAccountCode(k),
      isRecord(account) && typeof account['code'] === 'string'
        ? { ...account, code: rekeyAccountCode(account['code']) }
        : account,
    ]);
  }
  out['monthOpening'] = rekeyKeys(ledger['monthOpening']);
  out['yearOpening'] = rekeyKeys(ledger['yearOpening']);
  const reports = ledger['reports'];
  if (Array.isArray(reports)) out['reports'] = reports.map(rekeyReport);
  return out;
}

function rekeyEntry(entry: unknown): unknown {
  if (!isRecord(entry) || !Array.isArray(entry['lines'])) return entry;
  return {
    ...entry,
    lines: entry['lines'].map((line: unknown) =>
      isRecord(line) && typeof line['account'] === 'string'
        ? { ...line, account: rekeyAccountCode(line['account']) }
        : line,
    ),
  };
}

function mapAccounting(state: JsonRecord, fn: (accounting: JsonRecord) => JsonRecord): JsonRecord {
  const accounting = state['accounting'];
  return isRecord(accounting) ? { ...state, accounting: fn(accounting) } : state;
}

function mapLedgers(accounting: JsonRecord, fn: (ledger: unknown) => unknown): JsonRecord {
  const entities = accounting['entities'];
  if (!isRecord(entities)) return accounting;
  return { ...accounting, entities: mapRecord(entities, (k, ledger) => [k, fn(ledger)]) };
}

/** Note step 2 (idempotent): prefix every 4-digit account code in `state.accounting`. */
export function rekeyAccountCodesV2(state: unknown): unknown {
  if (!isRecord(state)) return state;
  return mapAccounting(state, (accounting) => {
    const out = mapLedgers(accounting, rekeyLedger);
    const journal = accounting['journal'];
    if (Array.isArray(journal)) out['journal'] = journal.map(rekeyEntry);
    return out;
  });
}

/** Note step 3 (idempotent): add `a1205`/`a1230` (balance 0, zero openings) where missing. */
export function addChartAccountsV2(state: unknown): unknown {
  if (!isRecord(state)) return state;
  return mapAccounting(state, (accounting) =>
    mapLedgers(accounting, (ledger) => {
      if (!isRecord(ledger) || !isRecord(ledger['accounts'])) return ledger;
      const accounts: JsonRecord = { ...ledger['accounts'] };
      const monthOpening = isRecord(ledger['monthOpening']) ? { ...ledger['monthOpening'] } : null;
      const yearOpening = isRecord(ledger['yearOpening']) ? { ...ledger['yearOpening'] } : null;
      for (const row of V2_ADDED_ACCOUNTS) {
        if (Object.hasOwn(accounts, row.code)) continue;
        accounts[row.code] = { ...row, balance: 0 };
        if (monthOpening !== null) monthOpening[row.code] = 0;
        if (yearOpening !== null) yearOpening[row.code] = 0;
      }
      return {
        ...ledger,
        accounts,
        ...(monthOpening !== null && { monthOpening }),
        ...(yearOpening !== null && { yearOpening }),
      };
    }),
  );
}

/**
 * `MIGRATIONS[1]`: steps 1-3 of the note, in order; step 4 (nothing else changes) holds by
 * construction. Steps 2-3 are idempotent; step 1 is valid only for v1 input (the table guarantees
 * it never runs on v2 data).
 */
export function migrateV1ToV2(state: unknown): unknown {
  if (!isRecord(state)) return state;
  return addChartAccountsV2(rekeyAccountCodesV2(installTypedSlicesV2(state)));
}

export const MIGRATIONS: MigrationTable = Object.freeze({ 1: migrateV1ToV2 });

export interface MigrationResult {
  state: unknown;
  /** Number of steps applied (0 when the input was already at `toVersion`). */
  steps: number;
}

/**
 * Migrates `state` from `fromVersion` to `toVersion` (default `SCHEMA_VERSION`). Throws
 * `SnapshotError('too_new')` if `fromVersion > toVersion` and `SnapshotError('no_migration')` when
 * a step is missing.
 */
export function migrateSnapshot(
  state: unknown,
  fromVersion: number,
  toVersion: number = SCHEMA_VERSION,
  table: MigrationTable = MIGRATIONS,
): MigrationResult {
  if (fromVersion > toVersion) {
    throw new SnapshotError(
      'too_new',
      `snapshot schema v${fromVersion} is newer than v${toVersion}`,
      {
        fromVersion,
        toVersion,
      },
    );
  }
  let current = state;
  let steps = 0;
  for (let version = fromVersion; version < toVersion; version++) {
    const migrate = table[version];
    if (migrate === undefined) {
      throw new SnapshotError('no_migration', `no migration from schema v${version}`, {
        fromVersion: version,
      });
    }
    current = migrate(current);
    steps += 1;
  }
  return { state: current, steps };
}
