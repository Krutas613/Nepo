/** Public surface of the sim adapter. Views import from here, never from `@nepo/sim` internals. */
export {
  GameClock,
  SPEEDS,
  browserScheduler,
  type FrameScheduler,
  type TicksPerSecond,
} from './clock.js';
export { GameProvider, createSelectorReader, useGameStore, useSelector } from './hooks.js';
export { GameStore, type DispatchResult, type GameView, type LoadResult } from './store.js';
export { DEFAULT_SEED, SYSTEMS } from './systems.js';
