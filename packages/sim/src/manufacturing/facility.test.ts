import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  M1_CONTENT_PACK,
  facilityId,
  facilityTypeId,
  money,
  productId,
  quantity,
} from '../schema/index.js';
import {
  advanceConstruction,
  batchesThatFit,
  depreciationSchedule,
  newFacility,
  nextDepreciationCharge,
  pendingOutput,
  previewBuild,
  previewBuildCost,
  wipBatchCount,
  type ManufacturingContent,
} from './facility.js';
import { BAKE_BREAD, BAKERY, FAC, PLAYER, SPRINGFIELD, BREAD } from './test-helpers.js';
import type { WipBatch } from '../schema/index.js';

const type = M1_CONTENT_PACK.facilityTypes[BAKERY]!;

describe('facility construction', () => {
  it('a new facility is under construction, off, capitalised at the build cost', () => {
    const f = newFacility({ id: FAC, ownerId: PLAYER, type, cityId: SPRINGFIELD, orderedTick: 4 });
    expect(f).toMatchObject({
      status: 'under_construction',
      orderedTick: 4,
      completesTick: 14,
      recipeId: null,
      targetBatches: 0,
      cost: 5_000_000,
      accumulatedDepreciation: 0,
      starvedReason: null,
      wip: [],
    });
  });

  it('advanceConstruction flips exactly on completesTick', () => {
    const f = newFacility({
      id: FAC,
      ownerId: PLAYER,
      type: { ...type, constructionTicks: 3 },
      cityId: SPRINGFIELD,
      orderedTick: 0,
    });
    expect([0, 1, 2].map((t) => advanceConstruction(f, t))).toEqual([false, false, false]);
    expect(f.status).toBe('under_construction');
    expect(advanceConstruction(f, 3)).toBe(true);
    expect(f.status).toBe('operating');
    expect(advanceConstruction(f, 4)).toBe(false);
  });

  it('zero construction ticks is due on the order tick', () => {
    const f = newFacility({
      id: facilityId('fa_000002'),
      ownerId: PLAYER,
      type: { ...type, constructionTicks: 0 },
      cityId: SPRINGFIELD,
      orderedTick: 9,
    });
    expect(advanceConstruction(f, 9)).toBe(true);
  });
});

describe('build previews', () => {
  it('previewBuildCost / previewBuild read the content, null for unknown types', () => {
    expect(previewBuildCost(M1_CONTENT_PACK, BAKERY)).toBe(5_000_000);
    expect(previewBuildCost(M1_CONTENT_PACK, facilityTypeIdOf('nope'))).toBeNull();
    expect(previewBuild(M1_CONTENT_PACK, BAKERY)).toMatchObject({
      buildCost: 5_000_000,
      constructionTicks: 10,
      dailyOperatingCost: 20_000,
      capacity: 5,
      storageCapacity: 2_000,
      usefulLifeMonths: 120,
      firstMonthDepreciation: 41_667,
    });
    expect(previewBuild(M1_CONTENT_PACK, facilityTypeIdOf('nope'))).toBeNull();
  });
});

function facilityTypeIdOf(s: string) {
  return facilityTypeId(s);
}

describe('straight-line depreciation schedule', () => {
  it('life 7 / cost 1000: charges sum to exactly 1000 and then stop', () => {
    let acc = money(0);
    const charges: number[] = [];
    for (let month = 0; month < 12; month++) {
      const c = nextDepreciationCharge(money(1000), 7, acc);
      charges.push(c);
      acc = money(acc + c);
    }
    expect(charges).toEqual([143, 143, 143, 143, 143, 143, 142, 0, 0, 0, 0, 0]);
    expect(acc).toBe(1000);
  });

  it('finishes in exactly `life` charges even where per-month rounding would not (cost 1000, life 3)', () => {
    expect(depreciationSchedule(money(1000), 3)).toEqual([334, 333, 333]);
  });

  it('a cost smaller than the life depreciates one unit per month', () => {
    expect(depreciationSchedule(money(5), 12)).toEqual([1, 1, 1, 1, 1]);
  });

  it('zero cost never depreciates', () => {
    expect(nextDepreciationCharge(money(0), 12, money(0))).toBe(0);
  });

  it('property: the chained charges equal the schedule, sum to cost, and take at most `life` months', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.integer({ min: 1, max: 600 }),
        (cost, life) => {
          let acc = money(0);
          let months = 0;
          for (;;) {
            const c = nextDepreciationCharge(money(cost), life, acc);
            if (c === 0) break;
            expect(c).toBeGreaterThan(0);
            acc = money(acc + c);
            months += 1;
            expect(months).toBeLessThanOrEqual(life);
          }
          expect(acc).toBe(cost);
          const schedule = depreciationSchedule(money(cost), life);
          expect(schedule.reduce((a, b) => a + b, 0)).toBe(cost);
          expect(months).toBe(schedule.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('storage planning', () => {
  const wip = (batches: number): WipBatch => ({
    recipeId: BAKE_BREAD,
    batches: quantity(batches),
    startedTick: 0,
    completesTick: 2,
    value: money(0),
  });
  const content = M1_CONTENT_PACK as ManufacturingContent;

  it('pendingOutput counts batches x primary output of each batch recipe', () => {
    expect(pendingOutput([wip(2), wip(3)], content.recipes, BREAD)).toBe(500);
    expect(pendingOutput([wip(2)], content.recipes, facilityProduct('grain'))).toBe(0);
  });

  it('batchesThatFit floors and never goes negative', () => {
    expect(batchesThatFit(2000, 1850, 0, 100)).toBe(1);
    expect(batchesThatFit(2000, 1900, 100, 100)).toBe(0);
    expect(batchesThatFit(2000, 2500, 0, 100)).toBe(0);
  });

  it('wipBatchCount sums', () => {
    expect(wipBatchCount([wip(2), wip(3)])).toBe(5);
  });
});

function facilityProduct(s: string) {
  return productId(s);
}
