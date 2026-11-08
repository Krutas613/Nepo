import type { ButtonHTMLAttributes, ReactElement } from 'react';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  /** Pressed state for toggle/segmented buttons. */
  active?: boolean;
  type?: 'button' | 'submit';
}

export function Button({
  variant = 'secondary',
  size = 'md',
  active,
  type = 'button',
  className,
  ...rest
}: ButtonProps): ReactElement {
  const cls = [
    'btn',
    `btn-${variant}`,
    `btn-${size}`,
    active === true ? 'is-active' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return <button type={type} aria-pressed={active} className={cls} {...rest} />;
}
