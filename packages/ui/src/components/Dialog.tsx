import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: number;
}

/** Modal built on the native `<dialog>`: focus trap, Escape and backdrop come from the browser. */
export function Dialog({ open, onClose, title, children, width = 520 }: DialogProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      style={{ width }}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog-inner">
          <header className="dialog-head">
            <h2>{title}</h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Close"
              onClick={onClose}
            >
              Close
            </button>
          </header>
          <div className="dialog-body">{children}</div>
        </div>
      )}
    </dialog>
  );
}
