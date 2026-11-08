import { useState, type ReactElement } from 'react';
import { Button } from '../components/index.js';
import { useGameStore, useSelector } from '../sim/hooks.js';
import { usePlayerId, usePlayerName } from '../sim/queries-hooks.js';

/**
 * The one working command form in pass 1. Exercises the whole path: `dispatch` -> queued command
 * -> next `step` -> `company.renamed` or `command.rejected` -> status below the field.
 */
export function RenameCompanyForm(): ReactElement {
  const store = useGameStore();
  const playerId = usePlayerId();
  const currentName = usePlayerName();
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState<{ seq: number; name: string } | null>(null);
  const [shapeError, setShapeError] = useState<string | null>(null);

  const seq = submitted?.seq ?? -1;
  const rejection = useSelector((v) => v.rejections.find((r) => r.commandSeq === seq) ?? null);
  const queued = useSelector((v) => v.world.state.pendingCommands.some((c) => c.seq === seq));

  const submit = (): void => {
    if (playerId === null) return;
    const result = store.dispatch({
      type: 'company.rename',
      issuer: playerId,
      payload: { name },
    });
    if (result.ok) {
      setSubmitted({ seq: result.seq, name });
      setShapeError(null);
      setName('');
    } else {
      setSubmitted(null);
      setShapeError(result.error.issues.join('; '));
    }
  };

  let status: ReactElement | null = null;
  if (shapeError !== null) {
    status = <p className="form-status neg">Invalid command: {shapeError}</p>;
  } else if (submitted !== null) {
    if (rejection !== null) {
      status = (
        <p className="form-status neg">
          Rejected ({rejection.code}): {rejection.reason}
        </p>
      );
    } else if (queued) {
      status = (
        <p className="form-status muted">
          Queued as command #{submitted.seq}. Executes tomorrow: advance one day to apply.
        </p>
      );
    } else {
      status = <p className="form-status pos">Renamed to &ldquo;{submitted.name}&rdquo;.</p>;
    }
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="form-label" htmlFor="rename-company">
        Company name
      </label>
      <div className="form-row">
        <input
          id="rename-company"
          className="field"
          value={name}
          placeholder={currentName}
          autoComplete="off"
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <Button type="submit" variant="primary" disabled={playerId === null}>
          Rename
        </Button>
      </div>
      {status}
    </form>
  );
}
