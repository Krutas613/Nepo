import { describe, expect, it } from 'vitest';
import { M1_CONTENT_PACK, facilityId, money, quantity, type Facility } from '../schema/index.js';
import {
  validateBuild,
  validateSetPrice,
  validateSetRestockPolicy,
  type BuildFacts,
  type RestockFacts,
} from './commands.js';
import {
  BREAD,
  FACILITY_1,
  GRAIN,
  GROCERY_FORMAT,
  OTHER,
  OWNER,
  SPRINGFIELD,
  SPRINGFIELD_MARKET,
  makeStore,
} from './test-helpers.js';

const city = M1_CONTENT_PACK.cities[SPRINGFIELD]!;
const bread = M1_CONTENT_PACK.products[BREAD]!;
const grain = M1_CONTENT_PACK.products[GRAIN]!;

function build(over: Partial<BuildFacts> = {}) {
  return validateBuild({
    issuer: OWNER,
    companyId: OWNER,
    format: GROCERY_FORMAT,
    city,
    marketId: SPRINGFIELD_MARKET,
    cash: money(GROCERY_FORMAT.buildCost),
    ...over,
  });
}

describe('validateBuild', () => {
  it('accepts a valid build, with cash exactly equal to the cost', () => {
    const r = build();
    expect(r.ok).toBe(true);
  });
  it('rejects in the documented order', () => {
    const code = (r: ReturnType<typeof build>) => (r.ok ? 'ok' : r.error.code);
    expect(code(build({ companyId: OTHER, format: undefined, city: undefined }))).toBe('not_owner');
    expect(
      code(build({ format: undefined, city: undefined, marketId: null, cash: money(0) })),
    ).toBe('unknown_store_format');
    expect(code(build({ city: undefined, marketId: null, cash: money(0) }))).toBe('unknown_city');
    expect(code(build({ marketId: null, cash: money(0) }))).toBe('no_market');
    expect(code(build({ cash: money(GROCERY_FORMAT.buildCost - 1) }))).toBe('insufficient_cash');
  });
});

function base(over: Partial<RestockFacts> = {}): RestockFacts {
  return {
    issuer: OWNER,
    store: makeStore(),
    format: GROCERY_FORMAT,
    product: bread,
    sourceFacilityId: FACILITY_1,
    facility: { id: FACILITY_1, ownerId: OWNER, cityId: SPRINGFIELD } as unknown as Facility,
    targetStock: quantity(100),
    ...over,
  };
}

describe('validateSetPrice', () => {
  const facts = (over = {}) => ({
    issuer: OWNER,
    store: makeStore(),
    format: GROCERY_FORMAT,
    product: bread,
    ...over,
  });
  const code = (r: ReturnType<typeof validateSetPrice>) => (r.ok ? 'ok' : r.error.code);
  it('accepts null and prices >= 1', () => {
    expect(code(validateSetPrice(facts(), null))).toBe('ok');
    expect(code(validateSetPrice(facts(), money(1)))).toBe('ok');
  });
  it('rejects in order', () => {
    expect(code(validateSetPrice(facts({ store: undefined, issuer: OTHER }), money(0)))).toBe(
      'unknown_store',
    );
    expect(code(validateSetPrice(facts({ issuer: OTHER, product: undefined }), money(0)))).toBe(
      'not_owner',
    );
    expect(code(validateSetPrice(facts({ product: undefined }), money(0)))).toBe('unknown_product');
    expect(code(validateSetPrice(facts({ product: grain }), money(0)))).toBe(
      'category_not_allowed',
    );
    expect(code(validateSetPrice(facts(), money(0)))).toBe('invalid_price');
    expect(code(validateSetPrice(facts(), -5 as never))).toBe('invalid_price');
  });
});

describe('validateSetRestockPolicy', () => {
  const code = (r: ReturnType<typeof validateSetRestockPolicy>) => (r.ok ? 'ok' : r.error.code);
  it('accepts a valid policy and a null source', () => {
    expect(code(validateSetRestockPolicy(base()))).toBe('ok');
    expect(code(validateSetRestockPolicy(base({ sourceFacilityId: null, facility: null })))).toBe(
      'ok',
    );
    expect(
      code(validateSetRestockPolicy(base({ targetStock: quantity(GROCERY_FORMAT.shelfCapacity) }))),
    ).toBe('ok');
  });
  it('rejects in the documented order', () => {
    const bad = {
      id: facilityId('fa_000009'),
      ownerId: OTHER,
      cityId: 'elsewhere',
    } as unknown as Facility;
    const wrongCity = { ...bad, ownerId: OWNER };
    const over = quantity(GROCERY_FORMAT.shelfCapacity + 1);
    expect(
      code(
        validateSetRestockPolicy(
          base({ store: undefined, issuer: OTHER, facility: null, targetStock: over }),
        ),
      ),
    ).toBe('unknown_store');
    expect(
      code(validateSetRestockPolicy(base({ issuer: OTHER, product: undefined, facility: null }))),
    ).toBe('not_owner');
    expect(code(validateSetRestockPolicy(base({ product: undefined, facility: null })))).toBe(
      'unknown_product',
    );
    expect(code(validateSetRestockPolicy(base({ product: grain, facility: null })))).toBe(
      'category_not_allowed',
    );
    expect(code(validateSetRestockPolicy(base({ facility: null, targetStock: over })))).toBe(
      'unknown_facility',
    );
    expect(code(validateSetRestockPolicy(base({ facility: bad, targetStock: over })))).toBe(
      'facility_not_owner',
    );
    expect(code(validateSetRestockPolicy(base({ facility: wrongCity, targetStock: over })))).toBe(
      'not_same_city',
    );
    expect(code(validateSetRestockPolicy(base({ targetStock: over })))).toBe(
      'target_exceeds_capacity',
    );
    expect(
      code(
        validateSetRestockPolicy(
          base({ sourceFacilityId: null, facility: null, targetStock: over }),
        ),
      ),
    ).toBe('target_exceeds_capacity');
  });
});
