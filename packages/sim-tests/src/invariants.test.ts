import { describe, expect, it } from 'vitest';
import { ACCOUNTS } from '@nepo/sim/accounting';
import { hashState, step, type World } from '@nepo/sim/engine';
import { companyId, money, type Money } from '@nepo/sim/schema';
import {
  compareHashSequences,
  economicSanityInvariant,
  goodsConservationInvariant,
  negativeQuantityInvariant,
  INVARIANTS,
  isFirstTickAfterYearEnd,
  runInvariants,
  yearEndCloseInvariant,
  snapshotEquivalence,
} from './invariants.js';
import { advance, makeWorld, SYSTEMS } from './helpers.js';

const ctx = { seed: 1 };
const ids = (w: World): string[] => [
  ...new Set(runInvariants(w, ctx).violations.map((v) => v.invariant)),
];

function cash(world: World): { balance: Money } {
  const acct = world.state.accounting.entities[companyId('co_000001')]?.accounts[ACCOUNTS.CASH];
  if (acct === undefined) throw new Error('no cash account');
  return acct;
}

describe('invariants detect corruption', () => {
  it('clean world has no violations', () => {
    const w = makeWorld(1);
    advance(w, 70);
    expect(runInvariants(w, ctx).violations).toEqual([]);
  });

  it('1-ledger and 2-balance-sheet: mutated ledger balance', () => {
    const w = makeWorld(1);
    advance(w, 5);
    const c = cash(w);
    c.balance = money(c.balance + 1);
    expect(ids(w)).toEqual(expect.arrayContaining(['1-ledger', '2-balance-sheet']));
    const v = runInvariants(w, ctx).violations.find((x) => x.invariant === '1-ledger');
    expect(v?.entity).toBe(companyId('co_000001'));
    expect(v?.seed).toBe(1);
    expect(v?.tick).toBe(5);
  });

  it('1-ledger: unbalanced journal entry', () => {
    const w = makeWorld(1);
    const line = w.state.accounting.journal[0]?.lines[0];
    if (line === undefined) throw new Error('no journal line');
    line.debit = money(line.debit + 5);
    expect(ids(w)).toContain('1-ledger');
  });

  it('2-balance-sheet: report with wrong netChange', () => {
    const w = makeWorld(1);
    advance(w, 35);
    const report = w.state.accounting.entities[companyId('co_000001')]?.reports[0];
    if (report === undefined) throw new Error('no report after a month');
    report.cashFlow.netChange = money(report.cashFlow.netChange + 7);
    const v = runInvariants(w, ctx).violations.filter((x) => x.invariant === '2-balance-sheet');
    expect(v.some((x) => x.detail.includes('netChange'))).toBe(true);
  });

  it('5-finite: NaN and Infinity in state', () => {
    const w = makeWorld(1);
    w.state.commandSeq = Number.NaN;
    expect(ids(w)).toContain('5-finite');
    w.state.commandSeq = Number.POSITIVE_INFINITY;
    expect(ids(w)).toContain('5-finite');
  });

  it('6-hash-stability: diverging hash sequences are reported with the first index', () => {
    const v = compareHashSequences(['a', 'b', 'c'], ['a', 'x', 'c'], 3, 'test');
    expect(v).toHaveLength(1);
    expect(v[0]?.tick).toBe(1);
    expect(v[0]?.invariant).toBe('6-hash-stability');
    expect(compareHashSequences(['a'], ['a', 'b'], 3, 'len')).toHaveLength(1);
    expect(compareHashSequences(['a'], ['a'], 3, 'same')).toEqual([]);
  });

  it('6-hash-stability: snapshot equivalence detects a divergent continuation', () => {
    const w = makeWorld(2);
    advance(w, 10);
    let calls = 0;
    const v = snapshotEquivalence(
      w,
      SYSTEMS,
      5,
      (x) => {
        step(x);
        calls += 1;
        // Perturb only the restored world (second call of each pair).
        if (calls % 2 === 0) x.state.commandSeq += 1;
      },
      2,
    );
    expect(v).toHaveLength(1);
    expect(hashState(w.state)).toBeTypeOf('string');
  });

  it('6-hash-stability: snapshot equivalence passes on a healthy world', () => {
    const w = makeWorld(2);
    advance(w, 10);
    expect(snapshotEquivalence(w, SYSTEMS, 30, (x) => void step(x), 2)).toEqual([]);
  });

  it('stubs 3, 4, 7 report skipped, never green', () => {
    const w = makeWorld(1);
    const run = runInvariants(w, ctx);
    expect(run.skipped.map((s) => s.invariant)).toEqual([
      '3-non-negative',
      '4-goods-conservation',
      '7-economic-sanity',
    ]);
    for (const s of run.skipped) expect(s.reason).toMatch(/^not-applicable-until: M[12]/);
    for (const inv of [
      negativeQuantityInvariant,
      goodsConservationInvariant,
      economicSanityInvariant,
    ]) {
      expect(inv.applicable(w)).toBe(false);
    }
  });

  describe('8-year-end-close', () => {
    function revenue(world: World): { balance: Money } {
      const ledger = world.state.accounting.entities[companyId('co_000001')];
      const acct = Object.entries(ledger?.accounts ?? {}).find(([code]) => code.startsWith('4'));
      if (acct === undefined) throw new Error('no 4xxx account');
      return acct[1];
    }

    it('is registered as an active invariant', () => {
      expect(INVARIANTS).toContain(yearEndCloseInvariant);
      expect(yearEndCloseInvariant.applicable(makeWorld(1))).toBe(true);
    });

    it('passes on a clean world on the first tick after year end and detects corruption', () => {
      const w = makeWorld(1);
      advance(w, 360);
      expect(isFirstTickAfterYearEnd(w)).toBe(true);
      expect(runInvariants(w, ctx).violations).toEqual([]);
      const acct = revenue(w);
      expect(acct.balance).toBe(0);
      acct.balance = money(acct.balance + 3);
      const v = runInvariants(w, ctx).violations.filter((x) => x.invariant === '8-year-end-close');
      expect(v).toHaveLength(1);
      expect(v[0]?.entity).toBe(companyId('co_000001'));
      expect(v[0]?.tick).toBe(360);
    });

    it('is silent on other ticks (mid-year balances are legitimately non-zero)', () => {
      const w = makeWorld(1);
      advance(w, 359);
      expect(isFirstTickAfterYearEnd(w)).toBe(false);
      revenue(w).balance = money(5);
      expect(ids(w)).not.toContain('8-year-end-close');
    });

    it('fires exactly at ticks 360, 720, ... derived from the calendar', () => {
      const w = makeWorld(1);
      const fired: number[] = [];
      for (let i = 0; i < 1100; i++) {
        step(w);
        if (isFirstTickAfterYearEnd(w)) fired.push(w.state.tick);
      }
      expect(fired).toEqual([360, 720, 1080]);
    });
  });
});
