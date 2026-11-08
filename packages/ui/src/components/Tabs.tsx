import type { KeyboardEvent, ReactElement, ReactNode } from 'react';

export interface TabDef<Id extends string> {
  id: Id;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<Id extends string> {
  tabs: readonly TabDef<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  'aria-label'?: string;
}

/** Tab strip (caller renders the panel). Arrow keys, Home and End move between enabled tabs. */
export function Tabs<Id extends string>({ tabs, value, onChange, ...rest }: TabsProps<Id>): ReactElement {
  const enabled = tabs.filter((t) => t.disabled !== true);
  const onKey = (e: KeyboardEvent): void => {
    const index = enabled.findIndex((t) => t.id === value);
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else return;
    e.preventDefault();
    const target = enabled[next];
    if (target !== undefined) onChange(target.id);
  };
  return (
    <div className="tabs" role="tablist" aria-label={rest['aria-label']} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          disabled={t.disabled}
          className={t.id === value ? 'tab is-active' : 'tab'}
          onClick={() => {
            onChange(t.id);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
