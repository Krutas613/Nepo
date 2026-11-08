import { useState, type ReactElement } from 'react';

export interface NumberConstraints {
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * Parses user text to a number honouring constraints. Returns `null` for empty/invalid input and
 * clamps into `[min, max]`. Accepts thousands separators.
 */
export function parseNumberInput(text: string, c: NumberConstraints = {}): number | null {
  const cleaned = text.trim().replace(/,/g, '');
  if (cleaned === '' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  let n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (c.integer === true) n = Math.round(n);
  if (c.min !== undefined) n = Math.max(c.min, n);
  if (c.max !== undefined) n = Math.min(c.max, n);
  return n;
}

export interface NumberInputProps extends NumberConstraints {
  value: number | null;
  onChange: (value: number | null) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Unit label shown inside the right edge. */
  suffix?: string;
  'aria-label'?: string;
}

/** Text input with a draft string; commits a parsed number on blur or Enter. */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  integer,
  suffix,
  id,
  placeholder,
  disabled,
  ...rest
}: NumberInputProps): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? '' : String(value));
  const commit = (): void => {
    if (draft === null) return;
    const constraints: NumberConstraints = {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(integer !== undefined ? { integer } : {}),
    };
    onChange(parseNumberInput(draft, constraints));
    setDraft(null);
  };
  return (
    <span className="numinput">
      <input
        className="field num"
        id={id}
        inputMode={integer === true ? 'numeric' : 'decimal'}
        value={shown}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={rest['aria-label']}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
      {suffix !== undefined && <span className="numinput-suffix">{suffix}</span>}
    </span>
  );
}
