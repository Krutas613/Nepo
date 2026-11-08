import type { ReactElement } from 'react';
import { formatQty } from '../format/index.js';

export function Qty({ value, unit }: { value: number; unit?: string }): ReactElement {
  return <span className="num">{formatQty(value, unit)}</span>;
}
