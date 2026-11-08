import type { ReactElement } from 'react';
import { Button } from '../components/index.js';
import { SPEEDS } from '../sim/clock.js';
import { useGameStore, useSelector } from '../sim/hooks.js';

function PlayIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 1.5v9l7-4.5z" fill="currentColor" />
    </svg>
  );
}
function PauseIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor" />
    </svg>
  );
}
function StepIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 1.5v9l6-4.5zM9 1.5h1.5v9H9z" fill="currentColor" />
    </svg>
  );
}

export function TimeControls(): ReactElement {
  const store = useGameStore();
  const running = useSelector((v) => v.clock.running);
  const speed = useSelector((v) => v.clock.ticksPerSecond);
  const poisoned = useSelector((v) => v.poisoned !== null);
  return (
    <div className="timecontrols" role="group" aria-label="Time controls">
      <Button
        variant="primary"
        disabled={poisoned}
        onClick={() => {
          store.toggle();
        }}
        title="Play / pause (Space)"
      >
        {running ? <PauseIcon /> : <PlayIcon />}
        <span>{running ? 'Pause' : 'Play'}</span>
      </Button>
      <Button
        disabled={poisoned}
        onClick={() => {
          store.stepOnce();
        }}
        title="Advance one day (.)"
      >
        <StepIcon />
        <span>Step</span>
      </Button>
      <div className="segmented" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <Button
            key={s}
            size="md"
            active={s === speed}
            onClick={() => {
              store.setSpeed(s);
            }}
            title={`${String(s)} day${s === 1 ? '' : 's'} per second`}
          >
            {s}x
          </Button>
        ))}
      </div>
    </div>
  );
}
