import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, Dialog } from '../components/index.js';
import { useGameStore, useSelector } from '../sim/hooks.js';
import {
  deleteSave,
  listSaves,
  normalizeSlotName,
  writeSave,
  type SaveMeta,
} from '../sim/saves.js';
import { downloadText } from '../util/download.js';

export function SaveLoadDialog(props: { open: boolean; onClose: () => void }): ReactElement {
  const store = useGameStore();
  const tick = useSelector((v) => v.tick);
  const seed = useSelector((v) => v.seed);
  const poisoned = useSelector((v) => v.poisoned);
  const lastGood = useSelector((v) => v.lastGood);
  const [slot, setSlot] = useState('quicksave');
  const [message, setMessage] = useState<{ tone: 'pos' | 'neg'; text: string } | null>(null);
  const [saves, setSaves] = useState<SaveMeta[]>(() =>
    store.storage === null ? [] : listSaves(store.storage),
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const hash = props.open && poisoned === null ? store.stateHash() : null;

  const refresh = (): void => {
    setSaves(store.storage === null ? [] : listSaves(store.storage));
  };
  useEffect(() => {
    if (props.open) refresh();
  }, [props.open]);
  const fail = (text: string): void => {
    setMessage({ tone: 'neg', text });
  };

  const save = (): void => {
    const name = normalizeSlotName(slot);
    if (name === null) {
      fail('Enter a slot name of 1 to 32 characters.');
      return;
    }
    if (store.storage === null) {
      fail('Browser storage is unavailable. Use Export instead.');
      return;
    }
    try {
      const meta = writeSave(store.storage, name, store.getWorld(), Date.now());
      setMessage({
        tone: 'pos',
        text: `Saved "${name}" at day ${String(meta.tick)} (hash ${meta.hash}).`,
      });
      refresh();
    } catch (error) {
      fail(error instanceof Error ? `Save failed: ${error.message}` : 'Save failed.');
    }
  };

  const load = (name: string): void => {
    const result = store.loadSlot(name);
    if (result.ok) props.onClose();
    else fail(result.message);
  };

  const exportFile = (): void => {
    const text = store.serialize() ?? lastGood;
    if (text === null) {
      fail('Nothing to export.');
      return;
    }
    downloadText(`nepo-seed${String(seed)}-day${String(tick)}.json`, text);
  };

  const importFile = (file: File): void => {
    void file.text().then((text) => {
      const result = store.loadFromText(text);
      if (result.ok) props.onClose();
      else fail(result.message);
    });
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title="Save / load" width={600}>
      <div className="form">
        <label className="form-label" htmlFor="save-slot">
          Save current game as
        </label>
        <div className="form-row">
          <input
            id="save-slot"
            className="field"
            value={slot}
            maxLength={32}
            onChange={(e) => {
              setSlot(e.target.value);
            }}
          />
          <Button variant="primary" onClick={save} disabled={poisoned !== null}>
            Save
          </Button>
        </div>
      </div>

      <dl className="kv kv-tight">
        <dt>Seed</dt>
        <dd className="num">{seed}</dd>
        <dt>Day</dt>
        <dd className="num">{tick}</dd>
        <dt>State hash</dt>
        <dd className="num">{hash ?? '—'}</dd>
      </dl>

      {message !== null && <p className={`form-status ${message.tone}`}>{message.text}</p>}

      <h3 className="subhead">Saved games</h3>
      {store.storage === null && (
        <p className="note">Browser storage is blocked; slots are unavailable.</p>
      )}
      {store.storage !== null && saves.length === 0 && <p className="note">No saved games yet.</p>}
      <ul className="save-list">
        {saves.map((s) => (
          <li key={s.slot}>
            <div className="save-main">
              <strong>{s.slot}</strong>
              <span className="muted">
                {s.company} &middot; seed {s.seed} &middot; day {s.tick} &middot;{' '}
                {s.savedAtMs > 0 ? new Date(s.savedAtMs).toLocaleString() : 'unknown time'} &middot;{' '}
                {Math.round(s.bytes / 1024)} KB
              </span>
            </div>
            <div className="save-actions">
              <Button
                size="sm"
                onClick={() => {
                  load(s.slot);
                }}
              >
                Load
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  if (store.storage !== null) deleteSave(store.storage, s.slot);
                  refresh();
                }}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="subhead">File</h3>
      <div className="form-row">
        <Button onClick={exportFile}>Export snapshot</Button>
        <Button
          onClick={() => {
            fileInput.current?.click();
          }}
        >
          Import snapshot&hellip;
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) importFile(file);
            e.target.value = '';
          }}
        />
      </div>
    </Dialog>
  );
}
