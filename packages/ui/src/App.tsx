import { useEffect, useState, type ReactElement } from 'react';
import { GameProvider } from './sim/hooks.js';
import { GameStore } from './sim/store.js';
import { Shell } from './views/Shell.js';

/** Owns the single `GameStore` for the page's lifetime. */
export function App(): ReactElement {
  const [store] = useState(() => new GameStore());
  useEffect(() => {
    // The store is created in state (StrictMode double-invokes effects, not initializers); pause on unmount.
    return () => {
      store.pause();
    };
  }, [store]);
  return (
    <GameProvider store={store}>
      <Shell />
    </GameProvider>
  );
}
