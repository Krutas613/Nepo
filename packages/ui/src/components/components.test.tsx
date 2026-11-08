import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DataTable, Money, Panel, Stat, Tabs, niceTicks, parseNumberInput } from './index.js';
import { computeWindow } from './virtual.js';

describe('computeWindow', () => {
  const base = { rowHeight: 28, viewportHeight: 280, overscan: 5 };

  it('renders only a viewport-sized slice of a huge table', () => {
    const w = computeWindow({ ...base, scrollTop: 0, count: 1_000_000 });
    expect(w.start).toBe(0);
    expect(w.end).toBeLessThan(25);
    expect(w.totalHeight).toBe(28_000_000);
  });

  it('follows the scroll position with overscan on both sides', () => {
    const w = computeWindow({ ...base, scrollTop: 28 * 1000, count: 100_000 });
    expect(w.start).toBe(995);
    expect(w.end).toBe(1000 + 11 + 5);
    expect(w.offset).toBe(995 * 28);
  });

  it('clamps beyond the end and handles empty tables', () => {
    const w = computeWindow({ ...base, scrollTop: 10 ** 9, count: 50 });
    expect(w.end).toBe(50);
    expect(w.start).toBeGreaterThanOrEqual(0);
    expect(computeWindow({ ...base, scrollTop: 0, count: 0 })).toMatchObject({ start: 0, end: 0 });
  });
});

describe('DataTable (server render)', () => {
  it('puts at most a window of rows in the DOM for 100k rows', () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => ({ id: i }));
    const html = renderToStaticMarkup(
      <DataTable
        rows={rows}
        height={280}
        columns={[{ key: 'id', header: 'Id', render: (r) => r.id }]}
        rowKey={(r) => String(r.id)}
      />,
    );
    const rendered = html.match(/role="row"/g)?.length ?? 0;
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(40);
    expect(html).toContain('aria-rowcount="100001"');
  });

  it('reverse shows the newest row first', () => {
    const html = renderToStaticMarkup(
      <DataTable
        rows={['a', 'b', 'c']}
        reverse
        height={200}
        columns={[{ key: 'v', header: 'V', render: (r) => r }]}
        rowKey={(r) => r}
      />,
    );
    expect(html.indexOf('>c<')).toBeLessThan(html.indexOf('>a<'));
  });

  it('shows the empty state', () => {
    const html = renderToStaticMarkup(
      <DataTable
        rows={[] as string[]}
        empty="None"
        columns={[{ key: 'v', header: 'V', render: (r) => r }]}
        rowKey={(r) => r}
      />,
    );
    expect(html).toContain('None');
  });
});

describe('primitives', () => {
  it('Money tints negatives and keeps sign style consistent', () => {
    expect(renderToStaticMarkup(<Money value={-150} />)).toBe(
      '<span class="num neg">-$1.50</span>',
    );
    expect(renderToStaticMarkup(<Money value={-150} negative="parens" />)).toContain('($1.50)');
    expect(renderToStaticMarkup(<Money value={150} />)).toBe('<span class="num">$1.50</span>');
  });

  it('Panel, Stat and Tabs render their content', () => {
    expect(renderToStaticMarkup(<Panel title="T">body</Panel>)).toContain('body');
    expect(renderToStaticMarkup(<Stat label="Cash" value="1" hint="h" />)).toContain('Cash');
    const tabs = renderToStaticMarkup(
      <Tabs
        tabs={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ]}
        value="b"
        onChange={() => undefined}
      />,
    );
    expect(tabs).toContain('aria-selected="true"');
  });

  it('parseNumberInput parses, clamps and rejects', () => {
    expect(parseNumberInput('1,234.5')).toBe(1234.5);
    expect(parseNumberInput('12.6', { integer: true })).toBe(13);
    expect(parseNumberInput('-5', { min: 0 })).toBe(0);
    expect(parseNumberInput('500', { max: 100 })).toBe(100);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
    expect(parseNumberInput('1e3')).toBeNull();
  });

  it('niceTicks returns round values inside the range', () => {
    const ticks = niceTicks(0, 1000);
    expect(ticks[0]).toBe(0);
    expect(ticks.every((t) => t >= 0 && t <= 1000)).toBe(true);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});
