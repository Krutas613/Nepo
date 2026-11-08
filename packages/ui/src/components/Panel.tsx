import type { ReactElement, ReactNode } from 'react';

export interface PanelProps {
  title?: ReactNode;
  /** Right-aligned header content (filters, buttons). */
  actions?: ReactNode;
  children: ReactNode;
  /** Remove body padding (tables that should touch the edges). */
  flush?: boolean;
  /** Let the body grow and scroll inside a flex column parent. */
  fill?: boolean;
  className?: string;
}

export function Panel({
  title,
  actions,
  children,
  flush,
  fill,
  className,
}: PanelProps): ReactElement {
  const cls = ['panel', fill ? 'panel-fill' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <section className={cls}>
      {(title !== undefined || actions !== undefined) && (
        <header className="panel-head">
          <h2 className="panel-title">{title}</h2>
          {actions !== undefined && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}
