import type { ReactElement } from 'react';
import { formatMoney, formatMoneyCompact, type NegativeStyle } from '../format/index.js';

export interface MoneyProps {
  /** Integer minor units. */
  value: number;
  negative?: NegativeStyle;
  /** No currency symbol (statement columns). */
  plain?: boolean;
  compact?: boolean;
  /** Tint negative values. Default true. */
  tint?: boolean;
  /** Tint positive values too (P&L deltas). */
  tintPositive?: boolean;
}

/** Money in the tabular monospace face; negatives are tinted and signed consistently. */
export function Money({
  value,
  negative = 'minus',
  plain = false,
  compact = false,
  tint = true,
  tintPositive = false,
}: MoneyProps): ReactElement {
  const text = compact
    ? formatMoneyCompact(value)
    : formatMoney(value, { negative, symbol: plain ? '' : '$' });
  const cls = ['num', tint && value < 0 ? 'neg' : '', tintPositive && value > 0 ? 'pos' : '']
    .filter(Boolean)
    .join(' ');
  return <span className={cls}>{text}</span>;
}
