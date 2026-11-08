import { useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { useElementSize } from './useElementSize.js';
import { computeWindow } from './virtual.js';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** CSS grid track, e.g. `120px`, `1fr`, `minmax(160px, 2fr)`. Default `1fr`. */
  width?: string;
  align?: 'left' | 'right' | 'center';
  render: (row: T, index: number) => ReactNode;
}

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T, index: number) => string;
  /** Row height in px; every row has the same height (that is what makes windowing O(1)). */
  rowHeight?: number;
  /** Fixed height in px. Omit to fill the parent (parent must be a sized flex/grid item). */
  height?: number;
  /** Show the last row first without copying the array. */
  reverse?: boolean;
  onRowClick?: (row: T, index: number) => void;
  selectedKey?: string | null;
  rowClassName?: (row: T) => string | undefined;
  empty?: ReactNode;
  'aria-label'?: string;
}

const OVERSCAN = 8;
const FALLBACK_VIEWPORT = 480;

/**
 * Virtualized table: only rows intersecting the viewport (plus overscan) are in the DOM, so
 * 100k rows cost the same as 30. Fixed row height, CSS-grid columns shared by header and rows.
 */
export function DataTable<T>(props: DataTableProps<T>): ReactElement {
  const { rows, columns, rowKey, rowHeight = 28, height, reverse = false, empty } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const size = useElementSize(scroller, { width: 0, height: height ?? FALLBACK_VIEWPORT });
  const viewport = size.height > 0 ? size.height : (height ?? FALLBACK_VIEWPORT);
  const count = rows.length;
  const win = computeWindow({ scrollTop, viewportHeight: viewport, rowHeight, count, overscan: OVERSCAN });

  const template = columns.map((c) => c.width ?? '1fr').join(' ');
  const gridStyle: CSSProperties = { gridTemplateColumns: template };
  const rowStyle: CSSProperties = { ...gridStyle, height: rowHeight };

  const visible: ReactElement[] = [];
  for (let i = win.start; i < win.end; i++) {
    const dataIndex = reverse ? count - 1 - i : i;
    const row = rows[dataIndex];
    if (row === undefined) continue;
    const key = rowKey(row, dataIndex);
    const cls = [
      'dt-row',
      props.onRowClick !== undefined ? 'clickable' : '',
      props.selectedKey === key ? 'selected' : '',
      props.rowClassName?.(row) ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    visible.push(
      <div
        key={key}
        role="row"
        aria-rowindex={i + 2}
        className={cls}
        style={rowStyle}
        onClick={
          props.onRowClick !== undefined
            ? () => {
                props.onRowClick?.(row, dataIndex);
              }
            : undefined
        }
      >
        {columns.map((c) => (
          <div key={c.key} role="cell" className={`dt-cell align-${c.align ?? 'left'}`}>
            {c.render(row, dataIndex)}
          </div>
        ))}
      </div>,
    );
  }

  return (
    <div
      className="dt"
      role="table"
      aria-label={props['aria-label']}
      aria-rowcount={count + 1}
      style={height !== undefined ? { height } : undefined}
    >
      <div className="dt-head" role="row" style={gridStyle}>
        {columns.map((c) => (
          <div key={c.key} role="columnheader" className={`dt-cell align-${c.align ?? 'left'}`}>
            {c.header}
          </div>
        ))}
      </div>
      <div
        ref={scroller}
        className="dt-scroll"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
        }}
      >
        {count === 0 ? (
          <div className="dt-empty">{empty ?? 'Nothing to show.'}</div>
        ) : (
          <div className="dt-sizer" style={{ height: win.totalHeight }}>
            <div className="dt-window" style={{ transform: `translateY(${String(win.offset)}px)` }}>
              {visible}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
