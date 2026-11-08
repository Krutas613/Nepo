import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Button, Money } from '../components/index.js';
import { formatDate } from '../format/index.js';
import { useGameStore, useSelector } from '../sim/hooks.js';
import { useCalendar, usePlayerCash, usePlayerName } from '../sim/queries-hooks.js';
import { downloadText } from '../util/download.js';
import { Events } from './Events.js';
import { Ledger } from './Ledger.js';
import { NewGameDialog } from './NewGameDialog.js';
import { Overview } from './Overview.js';
import { SaveLoadDialog } from './SaveLoadDialog.js';
import { Statements } from './Statements.js';
import { TimeControls } from './TimeControls.js';

export type ViewId = 'overview' | 'statements' | 'ledger' | 'events';

const NAV: { group: string; items: { id: string; label: string; view?: ViewId }[] }[] = [
  {
    group: 'Empire',
    items: [{ id: 'overview', label: 'Overview', view: 'overview' }],
  },
  {
    group: 'Finance',
    items: [
      { id: 'statements', label: 'Statements', view: 'statements' },
      { id: 'ledger', label: 'Ledger', view: 'ledger' },
    ],
  },
  {
    group: 'Operations',
    items: [
      { id: 'factories', label: 'Factories' },
      { id: 'stores', label: 'Stores' },
      { id: 'market', label: 'Market' },
      { id: 'bank', label: 'Bank' },
    ],
  },
  { group: 'System', items: [{ id: 'events', label: 'Event log', view: 'events' }] },
];

export const VIEW_IDS: readonly ViewId[] = ['overview', 'statements', 'ledger', 'events'];

export function viewFromHash(hash: string): ViewId {
  const id = hash.replace(/^#\/?/, '');
  return VIEW_IDS.find((v) => v === id) ?? 'overview';
}

const TITLES: Record<ViewId, string> = {
  overview: 'Overview',
  statements: 'Financial statements',
  ledger: 'Ledger',
  events: 'Event log',
};

function ViewBody({ view }: { view: ViewId }): ReactElement {
  switch (view) {
    case 'overview':
      return <Overview />;
    case 'statements':
      return <Statements />;
    case 'ledger':
      return <Ledger />;
    case 'events':
      return <Events />;
  }
}

function PoisonBanner(): ReactElement | null {
  const poisoned = useSelector((v) => v.poisoned);
  const lastGood = useSelector((v) => v.lastGood);
  if (poisoned === null) return null;
  return (
    <div className="banner banner-error" role="alert">
      <div>
        <strong>The simulation stopped.</strong> An invariant failed at day {poisoned.tick} (seed{' '}
        {poisoned.seed}, code <span className="num">{poisoned.code}</span>). Stepping is disabled.
        <div className="muted">{poisoned.message}</div>
      </div>
      <Button
        disabled={lastGood === null}
        onClick={() => {
          if (lastGood !== null) {
            downloadText(`nepo-seed${String(poisoned.seed)}-last-good.json`, lastGood);
          }
        }}
      >
        Export last good snapshot
      </Button>
    </div>
  );
}

function Header(props: { onSave: () => void; onNew: () => void }): ReactElement {
  const name = usePlayerName();
  const cash = usePlayerCash();
  const cal = useCalendar();
  return (
    <header className="app-header">
      <div className="brand">Nepo</div>
      <div className="hdr-company" title="Company">
        {name}
      </div>
      <div className="hdr-stat">
        <span className="hdr-label">Date</span>
        <span className="num">{formatDate(cal)}</span>
      </div>
      <div className="hdr-stat">
        <span className="hdr-label">Cash</span>
        {cash === null ? <span className="num">&mdash;</span> : <Money value={cash} />}
      </div>
      <div className="hdr-spacer" />
      <TimeControls />
      <div className="hdr-actions">
        <Button variant="ghost" onClick={props.onSave}>
          Save / Load
        </Button>
        <Button variant="ghost" onClick={props.onNew}>
          New game
        </Button>
      </div>
    </header>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function Shell(): ReactElement {
  const store = useGameStore();
  const [view, setView] = useState<ViewId>(() =>
    viewFromHash(typeof window === 'undefined' ? '' : window.location.hash),
  );
  const [dialog, setDialog] = useState<'save' | 'new' | null>(null);

  useEffect(() => {
    const onHash = (): void => {
      setView(viewFromHash(typeof window === 'undefined' ? '' : window.location.hash));
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  useEffect(() => {
    document.title = `${TITLES[view]} · Nepo`;
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('dialog[open]') !== null) return;
      if (e.key === ' ') {
        e.preventDefault();
        store.toggle();
      } else if (e.key === '.') {
        store.stepOnce();
      } else if (e.key === '1') store.setSpeed(1);
      else if (e.key === '2') store.setSpeed(5);
      else if (e.key === '3') store.setSpeed(30);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [store]);

  const navTo = (id: ViewId): void => {
    window.location.hash = `/${id}`;
  };

  const nav: ReactNode = NAV.map((g) => (
    <div key={g.group} className="nav-group">
      <div className="nav-heading">{g.group}</div>
      {g.items.map((item) =>
        item.view === undefined ? (
          <span key={item.id} className="nav-item disabled" aria-disabled="true">
            {item.label}
            <span className="nav-soon">soon</span>
          </span>
        ) : (
          <a
            key={item.id}
            href={`#/${item.view}`}
            className={item.view === view ? 'nav-item is-active' : 'nav-item'}
            aria-current={item.view === view ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              if (item.view !== undefined) navTo(item.view);
            }}
          >
            {item.label}
          </a>
        ),
      )}
    </div>
  ));

  return (
    <div className="app">
      <Header
        onSave={() => {
          setDialog('save');
        }}
        onNew={() => {
          setDialog('new');
        }}
      />
      <nav className="app-nav" aria-label="Main">
        {nav}
      </nav>
      <main className="app-main">
        <PoisonBanner />
        <ViewBody view={view} />
      </main>
      <SaveLoadDialog
        open={dialog === 'save'}
        onClose={() => {
          setDialog(null);
        }}
      />
      <NewGameDialog
        open={dialog === 'new'}
        onClose={() => {
          setDialog(null);
        }}
      />
    </div>
  );
}
