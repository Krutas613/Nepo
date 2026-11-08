/**
 * @nepo/sim public surface (ARCHITECTURE.md §1 public-surface policy).
 *
 * - `schema` and `engine` are flattened here: they are the shared vocabulary.
 * - Every domain module is exposed only as a same-named namespace and via its
 *   subpath export (`@nepo/sim/accounting`, ...). Domain barrels may therefore
 *   use generic names (`payroll`, `postEntry`) without clashing.
 * - `DEFAULT_SYSTEMS` is the Milestone 1 composition: pass it to `createWorld`
 *   / `restore`. Systems are sorted by the engine into SYSTEM_ORDER regardless
 *   of array order.
 *
 * Consumers (UI, tools, sim-tests) import from '@nepo/sim' or a subpath; never
 * from deep internal files.
 */
import type { AnySystem } from './engine/index.js';
import { accountingSystem } from './accounting/index.js';
import { economySystem } from './economy/index.js';
import { financeSystem } from './finance/index.js';
import { manufacturingSystem } from './manufacturing/index.js';
import { retailSystem } from './retail/index.js';

export * from './schema/index.js';
export * from './engine/index.js';
export * as accounting from './accounting/index.js';
export * as economy from './economy/index.js';
export * as manufacturing from './manufacturing/index.js';
export * as retail from './retail/index.js';
export * as finance from './finance/index.js';

/** The systems that make up a Milestone 1 game world (docs/design/player-flow.md). */
export const DEFAULT_SYSTEMS: readonly AnySystem[] = [
  accountingSystem,
  economySystem,
  manufacturingSystem,
  retailSystem,
  financeSystem,
];
