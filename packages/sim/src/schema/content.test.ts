import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BankSchema,
  CitySchema,
  CommoditySourceSchema,
  ContentPackSchema,
  EMPTY_CONTENT_PACK,
  EMPTY_SCENARIO,
  FacilityTypeSchema,
  M1_CONTENT_PACK,
  MacroTunablesSchema,
  MarketSchema,
  PricingTunablesSchema,
  ProductSchema,
  RecipeSchema,
  RegionSchema,
  ScenarioSchema,
  SMOKE_SCENARIO,
  SnapshotEnvelopeSchema,
  StoreFormatSchema,
  VERTICAL_SLICE_SCENARIO,
  assembleContentPack,
  type ContentFiles,
  type ContentPack,
} from './index.js';

type Path = readonly (string | number)[];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Sets `value` at `path` inside an untyped JSON tree (bypasses the brands on purpose). */
function setPath(root: unknown, path: Path, value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (last === undefined) throw new Error('empty path');
  node[last] = value;
}

function withValue(root: unknown, path: Path, value: unknown): unknown {
  const copy = clone(root);
  setPath(copy, path, value);
  return copy;
}

function valuesOf<T>(record: Readonly<Record<string, T>>): T[] {
  return Object.keys(record)
    .sort()
    .map((k) => record[k] as T);
}

/** The `data/`-file form of a pack (arrays in id order, plus the two tunables objects). */
function filesOf(pack: ContentPack): ContentFiles {
  return clone({
    products: valuesOf(pack.products),
    recipes: valuesOf(pack.recipes),
    facilityTypes: valuesOf(pack.facilityTypes),
    storeFormats: valuesOf(pack.storeFormats),
    regions: valuesOf(pack.regions),
    cities: valuesOf(pack.cities),
    markets: valuesOf(pack.markets),
    pricing: pack.economy.pricing,
    macro: pack.economy.macro,
    commodities: valuesOf(pack.economy.commodities),
    banks: valuesOf(pack.finance.banks),
  });
}

const PACK = M1_CONTENT_PACK;
const BREAD = PACK.products['bread' as keyof typeof PACK.products];
const GRAIN = PACK.products['grain' as keyof typeof PACK.products];
const RECIPE = valuesOf(PACK.recipes)[0];
const BAKERY = valuesOf(PACK.facilityTypes)[0];
const GROCERY = valuesOf(PACK.storeFormats)[0];
const REGION = valuesOf(PACK.regions)[0];
const CITY = valuesOf(PACK.cities)[0];
const MARKET = valuesOf(PACK.markets)[0];
const SOURCE = valuesOf(PACK.economy.commodities)[0];
const BANK = valuesOf(PACK.finance.banks)[0];

describe('content definitions', () => {
  it('accept the fixture items', () => {
    expect(ProductSchema.parse(BREAD)).toEqual(BREAD);
    expect(ProductSchema.parse(GRAIN)).toEqual(GRAIN);
    expect(RecipeSchema.parse(RECIPE)).toEqual(RECIPE);
    expect(FacilityTypeSchema.parse(BAKERY)).toEqual(BAKERY);
    expect(StoreFormatSchema.parse(GROCERY)).toEqual(GROCERY);
    expect(RegionSchema.parse(REGION)).toEqual(REGION);
    expect(CitySchema.parse(CITY)).toEqual(CITY);
    expect(MarketSchema.parse(MARKET)).toEqual(MARKET);
    expect(CommoditySourceSchema.parse(SOURCE)).toEqual(SOURCE);
    expect(BankSchema.parse(BANK)).toEqual(BANK);
    expect(PricingTunablesSchema.parse(PACK.economy.pricing)).toEqual(PACK.economy.pricing);
    expect(MacroTunablesSchema.parse(PACK.economy.macro)).toEqual(PACK.economy.macro);
  });

  it.each<[string, { safeParse: (v: unknown) => { success: boolean } }, unknown, Path, unknown]>([
    ['product basePrice 0', ProductSchema, BREAD, ['basePrice'], 0],
    ['product elasticity > 5', ProductSchema, BREAD, ['elasticity'], 5.5],
    ['product elasticity -0', ProductSchema, BREAD, ['elasticity'], -0],
    ['product uppercase id', ProductSchema, BREAD, ['id'], 'Bread'],
    ['product missing elasticity', ProductSchema, BREAD, ['elasticity'], undefined],
    ['recipe without outputs', RecipeSchema, RECIPE, ['outputs'], []],
    ['recipe old `facility` key', RecipeSchema, RECIPE, ['facility'], 'bakery'],
    ['recipe negative labour', RecipeSchema, RECIPE, ['laborCostPerBatch'], -1],
    ['recipe zero-quantity line', RecipeSchema, RECIPE, ['inputs', 0, 'quantity'], 0],
    ['facility type kind warehouse', FacilityTypeSchema, BAKERY, ['kind'], 'warehouse'],
    ['facility type storage 0', FacilityTypeSchema, BAKERY, ['storageCapacity'], 0],
    ['facility type life 0', FacilityTypeSchema, BAKERY, ['usefulLifeMonths'], 0],
    ['facility type fractional ticks', FacilityTypeSchema, BAKERY, ['constructionTicks'], 1.5],
    ['store format no categories', StoreFormatSchema, GROCERY, ['categories'], []],
    ['store format shrinkage 101', StoreFormatSchema, GROCERY, ['shrinkagePerMille'], 101],
    ['city without region field', CitySchema, CITY, ['region'], undefined],
    ['market priceFactor 0.05', MarketSchema, MARKET, ['demand', 0, 'priceFactor'], 0.05],
    ['market with region (M0 field)', MarketSchema, MARKET, ['region'], 'heartland'],
    ['commodity kappa 0.6', CommoditySourceSchema, SOURCE, ['kappa'], 0.6],
    ['commodity alpha 1', CommoditySourceSchema, SOURCE, ['alpha'], 1],
    ['pricing beta 0', PricingTunablesSchema, PACK.economy.pricing, ['beta'], 0],
    ['pricing maxCapture 4', PricingTunablesSchema, PACK.economy.pricing, ['maxCapture'], 4],
    ['macro demandIndex 0', MacroTunablesSchema, PACK.economy.macro, ['demandIndex'], 0],
    ['bank no tiers', BankSchema, BANK, ['spreadTiers'], []],
    ['bank tiers not ascending', BankSchema, BANK, ['spreadTiers', 1, 'maxLeverage'], 0.5],
    ['bank minTerm > maxTerm', BankSchema, BANK, ['minTermMonths'], 61],
    ['bank maxTerm 121', BankSchema, BANK, ['maxTermMonths'], 121],
    ['bank minPrincipal 0', BankSchema, BANK, ['minPrincipal'], 0],
    ['bank NaN overdraft rate', BankSchema, BANK, ['overdraftAnnualRate'], NaN],
  ])('rejects %s', (_label, schema, base, path, value) => {
    expect(schema.safeParse(clone(base)).success).toBe(true);
    const bad = clone(base);
    setPath(bad, path, value);
    expect(schema.safeParse(bad).success).toBe(false);
  });
});

describe('ContentPackSchema', () => {
  it('accepts M1_CONTENT_PACK and EMPTY_CONTENT_PACK unchanged', () => {
    expect(ContentPackSchema.parse(clone(M1_CONTENT_PACK))).toEqual(M1_CONTENT_PACK);
    expect(ContentPackSchema.parse(clone(EMPTY_CONTENT_PACK))).toEqual(EMPTY_CONTENT_PACK);
    expect(EMPTY_CONTENT_PACK.economy.pricing).toEqual({
      alpha: 0.05,
      beta: 0.25,
      kappa: 0.3,
      maxCapture: 1.5,
    });
    expect(EMPTY_CONTENT_PACK.economy.macro).toEqual({
      inflationAnnual: 0,
      policyRate: 0.04,
      demandIndex: 1,
    });
  });

  it('fixtures are deep-frozen', () => {
    expect(Object.isFrozen(EMPTY_CONTENT_PACK.economy.pricing)).toBe(true);
    expect(Object.isFrozen(M1_CONTENT_PACK.finance.banks)).toBe(true);
    expect(Object.isFrozen(MARKET?.demand[0])).toBe(true);
  });

  it.each<[string, Path, unknown]>([
    ['product keyed under another id', ['products', 'bread', 'id'], 'grain'],
    ['bank keyed under another id', ['finance', 'banks', 'first_national', 'id'], 'other_bank'],
    [
      'commodity keyed under another product',
      ['economy', 'commodities', 'grain', 'product'],
      'bread',
    ],
    ['integer-like product key', ['products', '123'], BREAD],
  ])('rejects %s', (_label, path, value) => {
    expect(ContentPackSchema.safeParse(withValue(M1_CONTENT_PACK, path, value)).success).toBe(
      false,
    );
  });
});

describe('assembleContentPack', () => {
  it('assembles the fixture files into M1_CONTENT_PACK', () => {
    const r = assembleContentPack(filesOf(M1_CONTENT_PACK));
    expect(r).toEqual({ ok: true, value: M1_CONTENT_PACK });
  });

  it('assembles empty files into EMPTY_CONTENT_PACK', () => {
    expect(assembleContentPack(filesOf(EMPTY_CONTENT_PACK))).toEqual({
      ok: true,
      value: EMPTY_CONTENT_PACK,
    });
  });

  function expectError(files: unknown, code: string, fragment: string): void {
    const r = assembleContentPack(files as ContentFiles);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(r.error.issues.join('\n')).toContain(fragment);
    }
  }

  it('invalid_shape: reports every bad file, prefixed with the file name', () => {
    const files = filesOf(M1_CONTENT_PACK);
    setPath(files, ['products', 0, 'basePrice'], 0);
    setPath(files, ['macro'], { inflationAnnual: 0 });
    setPath(files, ['banks'], { first_national: BANK });
    const r = assembleContentPack(files);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_shape');
      const text = r.error.issues.join('\n');
      expect(text).toContain('products.0.basePrice');
      expect(text).toContain('macro.');
      expect(text).toContain('banks');
    }
  });

  it('invalid_shape: single-bank rules', () => {
    const files = filesOf(M1_CONTENT_PACK);
    setPath(files, ['banks', 0, 'minTermMonths'], 100);
    expectError(files, 'invalid_shape', 'banks.0.minTermMonths');
  });

  it('duplicate_id: per file (commodities by product)', () => {
    const files = filesOf(M1_CONTENT_PACK);
    setPath(files, ['regions'], [REGION, REGION]);
    expectError(files, 'duplicate_id', "regions.1: duplicate id 'heartland'");
    const files2 = filesOf(M1_CONTENT_PACK);
    setPath(files2, ['commodities'], [SOURCE, SOURCE]);
    expectError(files2, 'duplicate_id', "commodities.1: duplicate id 'grain'");
  });

  it.each<[string, Path, unknown, string]>([
    [
      'recipe input is not a product',
      ['recipes', 0, 'inputs', 0, 'product'],
      'flour',
      'recipes.bake_bread.inputs.0.product',
    ],
    [
      'recipe output is not a product',
      ['recipes', 0, 'outputs', 0, 'product'],
      'cake',
      'recipes.bake_bread.outputs.0.product',
    ],
    [
      'recipe facility type unknown',
      ['recipes', 0, 'facilityType'],
      'mill',
      'recipes.bake_bread.facilityType',
    ],
    ['city region unknown', ['cities', 0, 'region'], 'coast', 'cities.springfield.region'],
    [
      'market city unknown',
      ['markets', 0, 'city'],
      'shelbyville',
      'markets.springfield_market.city',
    ],
    [
      'market demand for unknown product',
      ['markets', 0, 'demand', 0, 'product'],
      'cake',
      'unknown product',
    ],
    [
      'market demand for a raw product',
      ['markets', 0, 'demand', 0, 'product'],
      'grain',
      'raw product',
    ],
    ['commodity for a non-raw product', ['commodities', 0, 'product'], 'bread', 'is not raw'],
    [
      'raw product without a source',
      ['commodities'],
      [],
      "raw product 'grain' has no commodity source",
    ],
  ])('cross_reference: %s', (_label, path, value, fragment) => {
    const files = filesOf(M1_CONTENT_PACK);
    setPath(files, path, value);
    expectError(files, 'cross_reference', fragment);
  });

  it('cross_reference: at most one market per city; no duplicate demand line', () => {
    const files = filesOf(M1_CONTENT_PACK);
    setPath(files, ['markets'], [MARKET, { ...MARKET, id: 'springfield_two' }]);
    expectError(files, 'cross_reference', "already has market 'springfield_market'");
    const files2 = filesOf(M1_CONTENT_PACK);
    const line = MARKET?.demand[0];
    setPath(files2, ['markets', 0, 'demand'], [line, line]);
    expectError(files2, 'cross_reference', "duplicate demand for product 'bread'");
  });

  it('property: the result does not depend on the order of items within files', () => {
    const extraProducts = Array.from({ length: 6 }, (_, i) => ({
      id: `good_${i}`,
      name: `Good ${i}`,
      category: 'consumer',
      unit: 'unit',
      basePrice: 10 + i,
      elasticity: 1,
    }));
    const base = filesOf(M1_CONTENT_PACK);
    const products = [...(base.products as unknown[]), ...extraProducts];
    const expected = assembleContentPack({ ...base, products });
    expect(expected.ok).toBe(true);
    fc.assert(
      fc.property(fc.shuffledSubarray(products, { minLength: products.length }), (shuffled) => {
        const r = assembleContentPack({ ...base, products: shuffled });
        expect(r).toEqual(expected);
        if (r.ok)
          expect(Object.keys(r.value.products)).toEqual(Object.keys(r.value.products).sort());
      }),
    );
  });
});

describe('scenario content', () => {
  it('VERTICAL_SLICE_SCENARIO validates', () => {
    expect(ScenarioSchema.parse(clone(VERTICAL_SLICE_SCENARIO))).toEqual(VERTICAL_SLICE_SCENARIO);
    expect(VERTICAL_SLICE_SCENARIO.companies[0]?.homeCity).toBe('springfield');
  });

  it('a v1 scenario without `content` parses with EMPTY_CONTENT_PACK', () => {
    const { content: _content, ...v1 } = clone(SMOKE_SCENARIO);
    const parsed = ScenarioSchema.parse(v1);
    expect(parsed.content).toEqual(EMPTY_CONTENT_PACK);
    expect(parsed).toEqual(SMOKE_SCENARIO);
    // A v1 snapshot envelope (scenario without content) still parses.
    const envelope = {
      format: 'nepo/snapshot',
      schemaVersion: 1,
      engineVersion: '0.0.0',
      hash: '0123456789abcdef',
      scenario: v1,
      state: {},
    };
    const env = SnapshotEnvelopeSchema.parse(envelope);
    expect(env.scenario.content).toEqual(EMPTY_CONTENT_PACK);
  });

  it('rejects an unknown homeCity and invalid content', () => {
    const bad = withValue(
      EMPTY_SCENARIO,
      ['companies'],
      [{ name: 'A', controller: 'player', startingCash: 1, homeCity: 'springfield' }],
    );
    expect(ScenarioSchema.safeParse(bad).success).toBe(false);
    expect(
      ScenarioSchema.safeParse(
        withValue(VERTICAL_SLICE_SCENARIO, ['companies', 0, 'homeCity'], 'nowhere'),
      ).success,
    ).toBe(false);
    expect(
      ScenarioSchema.safeParse(withValue(VERTICAL_SLICE_SCENARIO, ['content', 'cities'], {}))
        .success,
    ).toBe(false);
  });
});
