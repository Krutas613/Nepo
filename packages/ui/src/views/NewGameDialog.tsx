import { useState, type ReactElement } from 'react';
import { Button, Dialog } from '../components/index.js';
import { parseSeedText } from '../format/index.js';
import { useGameStore } from '../sim/hooks.js';
import { DEFAULT_SEED } from '../sim/systems.js';

export function NewGameDialog(props: { open: boolean; onClose: () => void }): ReactElement {
  const store = useGameStore();
  const [text, setText] = useState(String(DEFAULT_SEED));
  const seed = parseSeedText(text);
  const start = (): void => {
    if (seed === null) return;
    store.newGame(seed);
    props.onClose();
  };
  return (
    <Dialog open={props.open} onClose={props.onClose} title="New game" width={440}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <label className="form-label" htmlFor="new-seed">
          Seed
        </label>
        <div className="form-row">
          <input
            id="new-seed"
            className="field num"
            inputMode="numeric"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
          <Button
            onClick={() => {
              // The seed only picks which world is created; the sim itself stays deterministic.
              setText(String(Math.floor(Math.random() * 1_000_000_000)));
            }}
          >
            Random
          </Button>
        </div>
        <p className={seed === null ? 'form-status neg' : 'form-status muted'}>
          {seed === null
            ? 'The seed must be a whole number from 0 to 999,999,999,999,999.'
            : 'The same seed always produces the same game. Note it to replay a run.'}
        </p>
        <p className="note">
          Starting a new game discards the current one. Save first if you want to keep it.
        </p>
        <div className="form-row end">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={seed === null}>
            Start game
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
