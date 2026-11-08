/**
 * Property: for any sequence of valid postings (interleaved with rejected unbalanced postings and
 * period closes), every entity keeps Σ balance === 0 and assets === liabilities + equity under the
 * debit-normal signed-balance convention, and every report reconciles.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  companyId,
  money,
  type AccountCode,
  type CompanyId,
  type JournalEntryInput,
  type JournalLine,
} from '../schema/index.js';
import { ACCOUNTS, STANDARD_CHART } from './chart.js';
import { cr, dr } from './builders.js';
import { closePeriod } from './close.js';
import { checkLedgerInvariants } from './invariants.js';
import { createAccountingState, getLedger, openEntity, postEntry } from './ledger.js';
import { balanceSheet } from './statements.js';
import { makeTestEnv, testCloseDate } from './test-helpers.js';

const CODES: AccountCode[] = STANDARD_CHART.map((r) => r.code);
const accountArb = fc.constantFrom(...CODES);
const amountArb = fc.integer({ min: 1, max: 1_000_000_000 });

/** A balanced entry: 1-4 debit lines; their total split into 1-4 positive credit lines. */
const balancedLinesArb: fc.Arbitrary<JournalLine[]> = fc
  .tuple(
    fc.array(fc.tuple(accountArb, amountArb), { minLength: 1, maxLength: 4 }),
    fc.array(accountArb, { minLength: 1, maxLength: 4 }),
    fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 3, maxLength: 3 }),
  )
  .map(([debits, creditAccounts, cuts]) => {
    const total = debits.reduce((s, [, a]) => s + a, 0);
    const n = Math.min(creditAccounts.length, total);
    // n-1 distinct cut points in (0, total) -> n positive parts summing to total
    const points = [...new Set(cuts.slice(0, n - 1).map((c) => 1 + Math.floor(c * (total - 1))))]
      .filter((p) => p > 0 && p < total)
      .sort((a, b) => a - b);
    const bounds = [0, ...points, total];
    const credits: JournalLine[] = [];
    for (let i = 1; i < bounds.length; i++) {
      credits.push(
        cr(creditAccounts[i - 1] ?? ACCOUNTS.CASH, money((bounds[i] ?? 0) - (bounds[i - 1] ?? 0))),
      );
    }
    const lines = [...debits.map(([acc, a]) => dr(acc, money(a))), ...credits];
    return lines;
  });

type Action =
  | { kind: 'post'; entity: number; lines: JournalLine[] }
  | { kind: 'unbalanced'; entity: number; lines: JournalLine[]; lineIndex: number; delta: number }
  | { kind: 'advance'; days: number };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('post' as const),
      entity: fc.nat(2),
      lines: balancedLinesArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('unbalanced' as const),
      entity: fc.nat(2),
      lines: balancedLinesArb,
      lineIndex: fc.nat(7),
      delta: fc.integer({ min: 1, max: 1000 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      days: fc.integer({ min: 1, max: 45 }),
    }),
  },
);

function entry(lines: JournalLine[]): JournalEntryInput {
  return { memo: 'prop', lines, source: 'accounting' };
}

describe('ledger property', () => {
  it('random valid entries keep Σ balance === 0 and A = L + E; unbalanced entries are rejected atomically', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(actionArb, { maxLength: 60 }),
        (entityCount, actions) => {
          const state = createAccountingState();
          const env = makeTestEnv(0);
          const entities: CompanyId[] = [];
          for (let i = 0; i < entityCount; i++) {
            const id = companyId(`co_00000${i + 1}`);
            openEntity(state, id);
            entities.push(id);
          }
          let tick = 0;
          for (const action of actions) {
            if (action.kind === 'advance') {
              for (let d = 0; d < action.days; d++) {
                closePeriod(state, testCloseDate(tick), env);
                tick += 1;
                env.tick = tick;
              }
            } else {
              const entity = entities[action.entity % entities.length] ?? entities[0]!;
              if (action.kind === 'post') {
                const r = postEntry(state, entity, entry(action.lines), env);
                expect(r.ok).toBe(true);
              } else {
                const i = action.lineIndex % action.lines.length;
                const lines = action.lines.map((l, j) =>
                  j !== i
                    ? l
                    : l.debit > 0
                      ? dr(l.account, money(l.debit + action.delta))
                      : cr(l.account, money(l.credit + action.delta)),
                );
                const before = JSON.stringify(state);
                const issued = env.issued;
                const r = postEntry(state, entity, entry(lines), env);
                expect(r.ok).toBe(false);
                if (!r.ok) expect(r.error.code).toBe('unbalanced');
                expect(JSON.stringify(state)).toBe(before);
                expect(env.issued).toBe(issued);
              }
            }

            expect(checkLedgerInvariants(state)).toEqual([]);
            for (const id of entities) {
              const ledger = getLedger(state, id);
              let sum = 0;
              for (const code of CODES) sum += ledger.accounts[code]?.balance ?? NaN;
              expect(sum).toBe(0);
              const bs = balanceSheet(ledger);
              expect(bs.assets).toBe(bs.liabilities + bs.equity);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
