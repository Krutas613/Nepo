/**
 * @nepo/sim public surface.
 *
 * Domain modules re-export here once they land. Consumers outside the sim
 * (UI, tools, sim-tests) import from '@nepo/sim' or a subpath such as
 * '@nepo/sim/engine'; never from deep internal files.
 */
export * from './schema/index.js';
export * from './engine/index.js';
export * from './accounting/index.js';
