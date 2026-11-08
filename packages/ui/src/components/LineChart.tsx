import { useRef, type ReactElement } from 'react';
import { useElementSize } from './useElementSize.js';

export interface ChartPoint {
  x: number;
  y: number;
}

export interface LineChartProps {
  points: readonly ChartPoint[];
  height?: number;
  formatY: (y: number) => string;
  formatX: (x: number) => string;
  'aria-label': string;
}

/** Round-number ticks spanning [min, max] (about `target` of them). */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(v);
  return ticks;
}

const M = { top: 8, right: 12, bottom: 22, left: 76 };

/** Minimal dependency-free SVG line chart: one series, grid, end labels. Theme via CSS vars. */
export function LineChart({
  points,
  height = 180,
  formatY,
  formatX,
  ...rest
}: LineChartProps): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(box, { width: 600, height });
  const w = Math.max(200, width);
  const innerW = w - M.left - M.right;
  const innerH = height - M.top - M.bottom;

  let body: ReactElement | null = null;
  if (points.length >= 2) {
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const flat = maxY === minY;
    const flatValue = minY;
    if (flat) {
      // A constant series: centre it in a window of +-5% and label just its value.
      const half = Math.max(1, Math.abs(minY) * 0.05);
      maxY += half;
      minY -= half;
    } else {
      const pad = (maxY - minY) * 0.06;
      minY -= pad;
      maxY += pad;
    }
    const sx = (x: number): number => M.left + ((x - minX) / Math.max(1, maxX - minX)) * innerW;
    const sy = (y: number): number => M.top + (1 - (y - minY) / (maxY - minY)) * innerH;
    // Decimate to about 2 points per pixel column; the buffer can hold thousands.
    const stride = Math.max(1, Math.floor(points.length / (innerW * 2)));
    const path: string[] = [];
    for (let i = 0; i < points.length; i += stride) {
      const p = points[i];
      if (p !== undefined)
        path.push(`${path.length === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`);
    }
    const last = points[points.length - 1];
    if (last !== undefined && (points.length - 1) % stride !== 0) {
      path.push(`L${sx(last.x).toFixed(1)},${sy(last.y).toFixed(1)}`);
    }
    body = (
      <>
        {(flat ? [flatValue] : niceTicks(minY, maxY)).map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={M.left} x2={w - M.right} y1={sy(t)} y2={sy(t)} />
            <text
              className="chart-label"
              x={M.left - 6}
              y={sy(t)}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {formatY(t)}
            </text>
          </g>
        ))}
        <text className="chart-label" x={M.left} y={height - 6} textAnchor="start">
          {formatX(minX)}
        </text>
        <text className="chart-label" x={w - M.right} y={height - 6} textAnchor="end">
          {formatX(maxX)}
        </text>
        <path className="chart-line" d={path.join('')} />
        {last !== undefined && (
          <circle className="chart-dot" cx={sx(last.x)} cy={sy(last.y)} r={3} />
        )}
      </>
    );
  }

  return (
    <div ref={box} className="chart" style={{ height }}>
      <svg width={w} height={height} role="img" aria-label={rest['aria-label']}>
        {body ?? (
          <text className="chart-label" x={w / 2} y={height / 2} textAnchor="middle">
            Not enough data yet
          </text>
        )}
      </svg>
    </div>
  );
}
