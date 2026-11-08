/** Pure windowing math for `DataTable` (unit-tested). */
export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan: number;
}

export interface WindowRange {
  /** First rendered row index (inclusive). */
  start: number;
  /** Last rendered row index (exclusive). */
  end: number;
  /** Total scrollable height in px. */
  totalHeight: number;
  /** Y offset of the first rendered row. */
  offset: number;
}

export function computeWindow(i: WindowInput): WindowRange {
  const rowHeight = Math.max(1, i.rowHeight);
  const count = Math.max(0, i.count);
  const totalHeight = count * rowHeight;
  const maxScroll = Math.max(0, totalHeight - i.viewportHeight);
  const scrollTop = Math.min(Math.max(0, i.scrollTop), maxScroll);
  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.ceil(i.viewportHeight / rowHeight) + 1;
  const start = Math.max(0, first - i.overscan);
  const end = Math.min(count, first + visible + i.overscan);
  return { start, end, totalHeight, offset: start * rowHeight };
}
