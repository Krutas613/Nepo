/**
 * `pnpm --filter @nepo/tools validate-data`: validates everything under `data/` against the schema
 * validators (per-file shape, then `assembleContentPack` for duplicates and cross-references, then
 * any scenario files). Prints each file's status and every issue path; exits 1 on any failure.
 * Owned by `content`. Usage: `validate-data [dataDir]` (default: the repository `data/`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BankSchema,
  CommoditySourceSchema,
  CitySchema,
  FacilityTypeSchema,
  MacroTunablesSchema,
  MarketSchema,
  PricingTunablesSchema,
  ProductSchema,
  RecipeSchema,
  RegionSchema,
  ScenarioSchema,
  StoreFormatSchema,
  assembleContentPack,
  formatSchemaIssues,
  type ContentFiles,
  type ContentPack,
} from '@nepo/sim/schema';
import { CONTENT_FILE_PATHS, readRawContentFile } from './load-content.js';

type ZodLike = Parameters<typeof formatSchemaIssues>[0];
interface ItemValidator {
  safeParse(value: unknown): { success: true } | { success: false; error: ZodLike };
}

/** Per-file item validator and whether the file is a JSON array of items or a single object. */
const FILE_VALIDATORS: Record<
  keyof ContentFiles,
  { shape: 'array' | 'object'; item: ItemValidator }
> = {
  products: { shape: 'array', item: ProductSchema },
  recipes: { shape: 'array', item: RecipeSchema },
  facilityTypes: { shape: 'array', item: FacilityTypeSchema },
  storeFormats: { shape: 'array', item: StoreFormatSchema },
  regions: { shape: 'array', item: RegionSchema },
  cities: { shape: 'array', item: CitySchema },
  markets: { shape: 'array', item: MarketSchema },
  pricing: { shape: 'object', item: PricingTunablesSchema },
  macro: { shape: 'object', item: MacroTunablesSchema },
  commodities: { shape: 'array', item: CommoditySourceSchema },
  banks: { shape: 'array', item: BankSchema },
};

interface FileReport {
  file: string;
  items: number;
  issues: string[];
}

const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));

function itemIssues(prefix: string, error: ZodLike): string[] {
  return error.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].join('.');
    return `${path}: ${issue.message}`;
  });
}

/** Shape-checks one raw file against its item validator. */
function checkShape(key: keyof ContentFiles, raw: unknown): FileReport {
  const file = CONTENT_FILE_PATHS[key];
  const spec = FILE_VALIDATORS[key];
  const report: FileReport = { file, items: 0, issues: [] };
  if (spec.shape === 'object') {
    report.items = 1;
    const result = spec.item.safeParse(raw);
    if (!result.success) report.issues.push(...itemIssues(key, result.error));
    return report;
  }
  if (!Array.isArray(raw)) {
    report.issues.push(`${key}: expected a JSON array`);
    return report;
  }
  report.items = raw.length;
  raw.forEach((item: unknown, i) => {
    const result = spec.item.safeParse(item);
    if (!result.success) report.issues.push(...itemIssues(`${key}.${i}`, result.error));
  });
  return report;
}

/** Maps a `path: message` issue from `assembleContentPack` to the data file it concerns. */
function fileForIssue(issue: string): keyof ContentFiles | undefined {
  const [path = ''] = issue.split(':');
  const parts = path.split('.');
  const head = parts[0];
  if (head === 'economy') {
    const section = parts[1];
    if (section === 'pricing' || section === 'macro' || section === 'commodities') return section;
    return undefined;
  }
  if (head === 'finance') return 'banks';
  const direct: Partial<Record<string, keyof ContentFiles>> = {
    products: 'products',
    recipes: 'recipes',
    facilityTypes: 'facilityTypes',
    storeFormats: 'storeFormats',
    regions: 'regions',
    cities: 'cities',
    markets: 'markets',
    commodities: 'commodities',
    banks: 'banks',
  };
  return head === undefined ? undefined : direct[head];
}

function printFile(report: FileReport): boolean {
  const ok = report.issues.length === 0;
  const status = ok ? 'OK  ' : 'FAIL';
  console.log(`  ${status}  ${report.file.padEnd(28)} ${String(report.items)} item(s)`);
  for (const issue of report.issues) console.log(`          - ${issue}`);
  return ok;
}

function main(): number {
  // pnpm forwards a literal `--` before user arguments; skip it.
  const arg = process.argv.slice(2).find((a) => a !== '--');
  const dataDir = resolve(arg ?? DEFAULT_DATA_DIR);
  console.log(`nepo validate-data: ${dataDir}`);
  console.log('files:');

  const reports = new Map<keyof ContentFiles, FileReport>();
  const files: Partial<Record<keyof ContentFiles, unknown>> = {};
  const readFailures: FileReport[] = [];
  for (const key of Object.keys(CONTENT_FILE_PATHS) as (keyof ContentFiles)[]) {
    const read = readRawContentFile(dataDir, key);
    if (!read.ok) {
      readFailures.push({ file: CONTENT_FILE_PATHS[key], items: 0, issues: [read.message] });
      continue;
    }
    files[key] = read.value;
    reports.set(key, checkShape(key, read.value));
  }
  let failures = 0;
  for (const key of Object.keys(CONTENT_FILE_PATHS) as (keyof ContentFiles)[]) {
    const report = reports.get(key);
    if (report !== undefined) {
      if (!printFile(report)) failures += 1;
    } else {
      const failed = readFailures.find((r) => r.file === CONTENT_FILE_PATHS[key]);
      if (failed !== undefined) {
        printFile(failed);
        failures += 1;
      }
    }
  }

  console.log('assembly (duplicate ids, cross-references):');
  let pack: ContentPack | undefined;
  if (readFailures.length > 0) {
    console.log('  SKIP  not run: some files could not be read');
    failures += 1;
  } else {
    const result = assembleContentPack(files as ContentFiles);
    if (result.ok) {
      pack = result.value;
      console.log('  OK    all cross-references resolve');
    } else if (result.error.code === 'invalid_shape') {
      console.log('  SKIP  not run: shape errors above must be fixed first');
    } else {
      failures += 1;
      console.log(`  FAIL  ${result.error.code}`);
      for (const issue of result.error.issues) {
        const file = fileForIssue(issue);
        const where = file === undefined ? 'data' : CONTENT_FILE_PATHS[file];
        console.log(`          - ${where}: ${issue}`);
      }
    }
  }

  console.log(
    'scenarios (data/scenarios/*.json, Scenario shape with the assembled pack attached):',
  );
  const scenarioDir = join(dataDir, 'scenarios');
  const scenarioFiles = existsSync(scenarioDir)
    ? readdirSync(scenarioDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  if (scenarioFiles.length === 0) console.log('  (none)');
  for (const name of scenarioFiles) {
    const report: FileReport = { file: `scenarios/${name}`, items: 1, issues: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(scenarioDir, name), 'utf8')) as unknown;
    } catch (e) {
      report.issues.push(`invalid JSON (${String(e)})`);
    }
    if (raw !== undefined) {
      if (pack === undefined) {
        report.issues.push('not checked: content did not assemble');
      } else if (typeof raw === 'object' && raw !== null && 'content' in raw) {
        report.issues.push(
          'content: must not be authored in a scenario file; data/ content is attached by the loader',
        );
      } else {
        const parsed = ScenarioSchema.safeParse({ ...raw, content: pack });
        if (!parsed.success) report.issues.push(...formatSchemaIssues(parsed.error));
      }
    }
    if (!printFile(report)) failures += 1;
  }

  if (failures > 0) {
    console.log(`FAILED: ${String(failures)} check(s) failed.`);
    return 1;
  }
  console.log('OK: all data files validate.');
  return 0;
}

process.exitCode = main();
