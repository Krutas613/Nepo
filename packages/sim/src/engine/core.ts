/**
 * The engine's built-in `core` system (ARCHITECTURE.md sections 2, 6.3, 7.1; docs/design/engine.md
 * section 3). Its slice is `state.companies`. Always registered, always first in `SYSTEM_ORDER`.
 *
 * - `init`: one `Company` per `scenario.companies` entry, in array order (`co_000001`, ...),
 *   `foundedTick: 0`, `parentId: null`; emits `company.founded` for each.
 * - `apply`: handles `company.rename`. Target is `payload.companyId ?? issuer`. Rejects
 *   `not_owner` when the target is not the issuer, `unknown_company` if the target does not exist,
 *   `invalid_name` when the name is empty after trimming. On success stores the trimmed name and
 *   emits `company.renamed`.
 */
import type { Company, CompanyId, RenameCompanyCommand } from '../schema/index.js';
import type { System, TickContext } from './system.js';

export type CompaniesSlice = Record<CompanyId, Company>;

function rename(ctx: TickContext<CompaniesSlice>, command: RenameCompanyCommand): void {
  const target = command.payload.companyId ?? command.issuer;
  if (target !== command.issuer) {
    ctx.reject(command, 'not_owner', `${command.issuer} cannot rename ${target}`);
    return;
  }
  const company = ctx.slice[target];
  if (company === undefined) {
    ctx.reject(command, 'unknown_company', `no company ${target}`);
    return;
  }
  const name = command.payload.name.trim();
  if (name.length === 0) {
    ctx.reject(command, 'invalid_name', 'name must not be empty');
    return;
  }
  company.name = name;
  ctx.emit({ type: 'company.renamed', payload: { companyId: target, name } });
}

/**
 * Only `company.rename` is routed to core (`handles` below); the engine never delivers any other
 * type here. The narrowing guards against a routing bug rather than silently ignoring a command.
 */
function applyCommands(ctx: TickContext<CompaniesSlice>): void {
  for (const command of ctx.commands) {
    if (command.type === 'company.rename') {
      rename(ctx, command);
    } else {
      ctx.reject(command, 'no_handler', `core does not handle ${command.type}`);
    }
  }
}

export const coreSystem: System<CompaniesSlice> = {
  id: 'core',
  handles: ['company.rename'],
  init(ctx) {
    const companies: CompaniesSlice = {};
    for (const entry of ctx.scenario.companies) {
      const id = ctx.issueId('company');
      companies[id] = {
        id,
        name: entry.name,
        controller: entry.controller,
        parentId: null,
        foundedTick: 0,
      };
      ctx.emit({ type: 'company.founded', payload: { companyId: id, name: entry.name } });
    }
    return companies;
  },
  phases: {
    apply: applyCommands,
  },
};
