/**
 * Node-only loader for `data/` (ADR-010). Reads the M1 content files from a directory and runs the
 * single validator, `assembleContentPack`, from `@nepo/sim/schema`. Owned by `content`.
 *
 * sim-tests and the UI build reuse `loadContentFromDir`; they then attach the pack to a scenario
 * (`{ ...scenarioFile, content }`) and pass that to `createWorld`. Nothing in `packages/sim` reads
 * files: this module is the only place that does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assembleContentPack,
  type ContentFiles,
  type ContentPack,
  type ContentValidationError,
} from '@nepo/sim/schema';

/** Path of each `ContentFiles` entry, relative to the data directory (ARCHITECTURE.md section 15). */
export const CONTENT_FILE_PATHS: Readonly<Record<keyof ContentFiles, string>> = {
  products: 'products.json',
  recipes: 'recipes.json',
  facilityTypes: 'facility_types.json',
  storeFormats: 'store_formats.json',
  regions: 'regions.json',
  cities: 'cities.json',
  markets: 'markets.json',
  pricing: 'economy/pricing.json',
  macro: 'economy/macro.json',
  commodities: 'economy/commodities.json',
  banks: 'finance/banks.json',
};

export type ContentLoadErrorCode = 'missing_file' | 'invalid_json' | ContentValidationError['code'];

/** Thrown by the loader. `issues` holds `path: message` strings, the same form the validator uses. */
export class ContentLoadError extends Error {
  readonly code: ContentLoadErrorCode;
  readonly issues: readonly string[];

  constructor(code: ContentLoadErrorCode, issues: readonly string[]) {
    super(`content load failed (${code}):\n  ${issues.join('\n  ')}`);
    this.name = 'ContentLoadError';
    this.code = code;
    this.issues = issues;
  }
}

/** Reads and parses one data file. Returns the raw JSON value, or a message for a missing or unparseable file. */
export function readRawContentFile(
  dir: string,
  key: keyof ContentFiles,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const path = join(dir, CONTENT_FILE_PATHS[key]);
  if (!existsSync(path))
    return { ok: false, message: `${CONTENT_FILE_PATHS[key]}: file is missing` };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, message: `${CONTENT_FILE_PATHS[key]}: cannot read (${String(e)})` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, message: `${CONTENT_FILE_PATHS[key]}: invalid JSON (${String(e)})` };
  }
}

/** Reads every content file in `dir`. Throws `ContentLoadError` on the first missing or unparseable file. */
export function readContentFiles(dir: string): ContentFiles {
  const issues: string[] = [];
  const out: Partial<Record<keyof ContentFiles, unknown>> = {};
  for (const key of Object.keys(CONTENT_FILE_PATHS) as (keyof ContentFiles)[]) {
    const read = readRawContentFile(dir, key);
    if (read.ok) out[key] = read.value;
    else issues.push(read.message);
  }
  if (issues.length > 0) throw new ContentLoadError('missing_file', issues);
  return out as ContentFiles;
}

/** Assembles an already-read set of files. Throws `ContentLoadError` carrying the validator's code and issues. */
export function assembleOrThrow(files: ContentFiles): ContentPack {
  const result = assembleContentPack(files);
  if (!result.ok) throw new ContentLoadError(result.error.code, result.error.issues);
  return result.value;
}

/** Loads and validates the whole content pack from `dir` (e.g. the repository's `data/`). */
export function loadContentFromDir(dir: string): ContentPack {
  return assembleOrThrow(readContentFiles(dir));
}
