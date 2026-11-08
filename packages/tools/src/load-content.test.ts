import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assembleContentPack,
  bankId,
  marketId,
  productId,
  recipeId,
  type ContentFiles,
} from '@nepo/sim/schema';
import { ContentLoadError, loadContentFromDir, readContentFiles } from './load-content.js';

const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));

/** A deep copy of the shipped files, so each corruption is independent. */
function copyOfShippedFiles(): ContentFiles {
  return structuredClone(readContentFiles(DATA_DIR));
}

describe('shipped data/', () => {
  it('loads and validates through assembleContentPack', () => {
    const pack = loadContentFromDir(DATA_DIR);
    expect(Object.keys(pack.products).sort()).toEqual(['bread', 'wheat']);
    expect(pack.recipes[recipeId('bread_batch')]?.facilityType).toBe('bread_plant');
    expect(pack.markets[marketId('harbour_bay')]?.city).toBe('harbour_bay');
    expect(pack.economy.commodities[productId('wheat')]?.referenceDailyVolume).toBe(400);
    expect(pack.finance.banks[bankId('coastal_savings')]?.overdraftLimit).toBe(5_000_000);
  });

  it('has one raw material with exactly one commodity source and one market per city', () => {
    const pack = loadContentFromDir(DATA_DIR);
    const raws = Object.values(pack.products).filter((p) => p.category === 'raw');
    expect(raws.map((p) => p.id)).toEqual(['wheat']);
    expect(Object.keys(pack.economy.commodities)).toEqual(['wheat']);
    const cities = Object.keys(pack.cities);
    expect(
      cities.every((c) => Object.values(pack.markets).filter((m) => m.city === c).length === 1),
    ).toBe(true);
  });
});

describe('corrupted copies of data/', () => {
  it("fails with a cross-reference issue when a city's region is missing", () => {
    const files = copyOfShippedFiles();
    files.regions = [];
    const result = assembleContentPack(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cross_reference');
    expect(result.error.issues).toContain(
      "cities.harbour_bay.region: unknown region 'coastal_plains'",
    );
  });

  it('throws ContentLoadError carrying the same issue from loadContentFromDir-equivalent assembly', () => {
    const files = copyOfShippedFiles();
    files.regions = [];
    const result = assembleContentPack(files);
    if (result.ok) throw new Error('expected failure');
    const error = new ContentLoadError(result.error.code, result.error.issues);
    expect(error.code).toBe('cross_reference');
    expect(error.issues).toContain("cities.harbour_bay.region: unknown region 'coastal_plains'");
  });

  it('fails when the raw material loses its commodity source', () => {
    const files = copyOfShippedFiles();
    files.commodities = [];
    const result = assembleContentPack(files);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toContain(
      "products.wheat: raw product 'wheat' has no commodity source",
    );
  });
});
