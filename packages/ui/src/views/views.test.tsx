import { calendarFromTick } from '@nepo/sim/engine';
import { money } from '@nepo/sim/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GameProvider } from '../sim/hooks.js';
import { createMemoryStorage } from '../sim/saves.js';
import { GameStore } from '../sim/store.js';
import {
  eventFilterOptions,
  firstEventAtOrAfter,
  matchesEventFilter,
  summarizeEvent,
} from './eventFilter.js';
import { Overview } from './Overview.js';
import { Shell, viewFromHash } from './Shell.js';
import { Statements } from './Statements.js';
import { balanceSheetRows, cashFlowRows, incomeStatementRows } from './statementRows.js';
import { liveReport } from '../sim/queries.js';
import { playerCompanyId } from '../sim/selectors.js';
import { filterEntries } from './Ledger.js';

const noFrames = { request: () => 0, cancel: () => undefined };
function store(): GameStore {
  return new GameStore({ scheduler: noFrames, storage: createMemoryStorage(), seed: 1 });
}

describe('statement rows', () => {
  it('balance sheet rows foot: assets equal liabilities plus equity, check row is zero', () => {
    const s = store();
    s.stepMany(40);
    const state = s.getWorld().state;
    const live = liveReport(state, playerCompanyId(state));
    if (live === null) throw new Error('no report');
    const rows = balanceSheetRows(live.balance);
    const get = (label: string) => rows.find((r) => r.label === label)?.amount;
    expect(get('Total assets')).toBe(100_000_000);
    expect(get('Total liabilities and equity')).toBe(100_000_000);
    expect(rows.find((r) => r.kind === 'check')?.amount).toBe(0);
    expect(rows.find((r) => r.label === 'Cash')?.amount).toBe(100_000_000);
    expect(rows.find((r) => r.label === 'Share Capital')?.amount).toBe(100_000_000);
  });

  it('shows credit-normal accounts in their natural sign and drops zero lines', () => {
    const rows = incomeStatementRows({
      revenue: money(500),
      cogs: money(200),
      grossProfit: money(300),
      opex: money(100),
      operatingIncome: money(200),
      otherIncome: money(10),
      pretaxIncome: money(210),
      incomeTax: money(40),
      netIncome: money(170),
      byAccount: {
        a4000: -500,
        a5000: 200,
        a6000: 100,
        a6100: 0,
        a7100: -10,
        a7900: 40,
      } as never,
    });
    const line = (code: string) => rows.find((r) => r.code === code)?.amount;
    expect(line('4000')).toBe(500);
    expect(line('5000')).toBe(200);
    expect(line('7100')).toBe(10);
    expect(rows.some((r) => r.code === '6100')).toBe(false);
    expect(rows.at(-1)).toMatchObject({ label: 'Net income', amount: 170 });
  });

  it('cash flow rows tie opening, change and closing', () => {
    const rows = cashFlowRows({
      netIncome: money(10),
      operating: money(15),
      investing: money(-5),
      financing: money(0),
      netChange: money(10),
      openingCash: money(100),
      closingCash: money(110),
    });
    expect(rows.find((r) => r.label === 'Working capital and non-cash adjustments')?.amount).toBe(
      5,
    );
    expect(rows.find((r) => r.label === 'Closing cash')?.amount).toBe(110);
  });

  it('adds current period earnings to equity so the sheet foots', () => {
    const rows = balanceSheetRows({
      assets: money(1_100),
      liabilities: money(0),
      equity: money(1_100),
      byAccount: { a1000: 1_100, a3000: -1_000 } as never,
    });
    expect(rows.find((r) => r.label === 'Current period earnings')?.amount).toBe(100);
  });
});

describe('event helpers', () => {
  it('filters by prefix and exact type', () => {
    expect(matchesEventFilter('ledger.posted', 'all')).toBe(true);
    expect(matchesEventFilter('ledger.posted', 'prefix:ledger')).toBe(true);
    expect(matchesEventFilter('ledger.posted', 'prefix:led')).toBe(false);
    expect(matchesEventFilter('ledger.posted', 'type:ledger.posted')).toBe(true);
    expect(matchesEventFilter('period.closed', 'type:ledger.posted')).toBe(false);
    const opts = eventFilterOptions(['b.x', 'a.y', 'b.x']);
    expect(opts.map((o) => o.value)).toEqual([
      'all',
      'prefix:a',
      'prefix:b',
      'type:a.y',
      'type:b.x',
    ]);
  });

  it('binary-searches the first event of a tick window and summarizes events', () => {
    const s = store();
    s.stepMany(70);
    const events = s.getView().events;
    const idx = firstEventAtOrAfter(events, 30);
    expect(events[idx]?.tick).toBeGreaterThanOrEqual(30);
    expect(idx === 0 || (events[idx - 1]?.tick ?? 0) < 30).toBe(true);
    const closed = events.find((e) => e.type === 'period.closed');
    expect(closed && summarizeEvent(closed)).toContain('closed');
  });
});

describe('ledger filter', () => {
  it('filters by account and memo', () => {
    const s = store();
    const journal = s.getWorld().state.accounting.journal;
    expect(journal.length).toBeGreaterThan(0);
    expect(filterEntries(journal, null, 'all', '')).toBe(journal);
    expect(filterEntries(journal, null, 'a1000', '').length).toBeGreaterThan(0);
    expect(filterEntries(journal, null, 'a2500', '')).toHaveLength(0);
    expect(filterEntries(journal, null, 'all', 'zzzz-no-match')).toHaveLength(0);
  });
});

describe('views render (server)', () => {
  it('Overview, Statements and Shell render against a real store', () => {
    const s = store();
    s.stepMany(65);
    const wrap = (el: React.ReactElement) =>
      renderToStaticMarkup(<GameProvider store={s}>{el}</GameProvider>);
    const overview = wrap(<Overview />);
    expect(overview).toContain('$1,000,000.00');
    expect(overview).toContain('Net income');
    const statements = wrap(<Statements />);
    expect(statements).toContain('Income statement');
    expect(statements).toContain('Net income');
    const shell = wrap(<Shell />);
    expect(shell).toContain('Player Holdings');
    expect(shell).toContain('Y2000 M03 D06');
    expect(calendarFromTick(65, 2000).month).toBe(3);
  });

  it('routes from the hash', () => {
    expect(viewFromHash('#/ledger')).toBe('ledger');
    expect(viewFromHash('#events')).toBe('events');
    expect(viewFromHash('#/nonsense')).toBe('overview');
    expect(viewFromHash('')).toBe('overview');
  });
});
