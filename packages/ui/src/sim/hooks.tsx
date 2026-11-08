/**
 * React bindings for `GameStore`. Components read through `useSelector(selector, equality)`: the
 * selector runs at most once per store version, and the component re-renders only when the
 * selected value is not `equal` to the previous one. Select primitives or small tuples, never
 * large arrays rebuilt on every call.
 */
import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { GameStore, GameView } from './store.js';

/**
 * Cached selector reader over any `{ subscribe, getView }` store. Framework-free so its narrowing
 * behaviour is unit-testable in node; `useSelector` is a thin wrapper.
 */
export interface SelectorReader<T> {
  /** Returns the cached value when the store version and selector are unchanged. */
  read(selector: (view: GameView) => T, equal: (a: T, b: T) => boolean): T;
}

export function createSelectorReader<T>(getView: () => GameView): SelectorReader<T> {
  let cache: { version: number; selector: (view: GameView) => T; value: T } | null = null;
  return {
    read(selector, equal) {
      const view = getView();
      if (cache !== null && cache.version === view.version && cache.selector === selector) {
        return cache.value;
      }
      const next = selector(view);
      const value = cache !== null && equal(cache.value, next) ? cache.value : next;
      cache = { version: view.version, selector, value };
      return value;
    },
  };
}

const StoreContext = createContext<GameStore | null>(null);

export function GameProvider(props: { store: GameStore; children: ReactNode }): ReactElement {
  return <StoreContext value={props.store}>{props.children}</StoreContext>;
}

export function useGameStore(): GameStore {
  const store = useContext(StoreContext);
  if (store === null) throw new Error('useGameStore outside <GameProvider>');
  return store;
}

export function useSelector<T>(
  selector: (view: GameView) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useGameStore();
  const readerRef = useRef<{ store: GameStore; reader: SelectorReader<T> } | null>(null);
  if (readerRef.current?.store !== store) {
    readerRef.current = { store, reader: createSelectorReader<T>(store.getView) };
  }
  const reader = readerRef.current.reader;
  const get = (): T => reader.read(selector, equal);
  return useSyncExternalStore(store.subscribe, get, get);
}
