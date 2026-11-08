/**
 * @nepo/sim public surface (ARCHITECTURE.md §1 public-surface policy).
 *
 * - `schema` and `engine` are flattened here: they are the shared vocabulary.
 * - Every domain module is exposed only as a same-named namespace and via its
 *   subpath export (`@nepo/sim/accounting`). Domain barrels may therefore use
 *   generic names (`payroll`, `postEntry`) without clashing.
 * - `DEFAULT_SYSTEMS` lands here in Milestone 1 once a domain slice is typed.
 *
 * Consumers (UI, tools, sim-tests) import from '@nepo/sim' or a subpath; never
 * from deep internal files.
 */
export * from './schema/index.js';
export * from './engine/index.js';
export * as accounting from './accounting/index.js';
export * as economy from './economy/index.js';
