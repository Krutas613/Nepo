import type { ReactElement, ReactNode } from 'react';

export type Tone = 'neutral' | 'positive' | 'negative' | 'warning';

export interface StatProps {
  label: string;
  value: ReactNode;
  /** Secondary line under the value. */
  hint?: ReactNode;
  tone?: Tone;
}

export function Stat({ label, value, hint, tone = 'neutral' }: StatProps): ReactElement {
  return (
    <div className={`stat tone-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {hint !== undefined && <div className="stat-hint">{hint}</div>}
    </div>
  );
}
