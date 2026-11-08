import type { ReactElement } from 'react';

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string> {
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  id?: string;
  'aria-label'?: string;
  disabled?: boolean;
}

export function Select<V extends string>({
  value,
  options,
  onChange,
  id,
  disabled,
  ...rest
}: SelectProps<V>): ReactElement {
  return (
    <select
      className="field select"
      id={id}
      value={value}
      disabled={disabled}
      aria-label={rest['aria-label']}
      onChange={(e) => {
        const picked = options.find((o) => o.value === e.target.value);
        if (picked !== undefined) onChange(picked.value);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
