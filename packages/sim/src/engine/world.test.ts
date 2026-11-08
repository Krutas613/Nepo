import { describe, expect, it } from 'vitest';
import {
  EMPTY_ACCOUNTING_STATE,
  EMPTY_SCENARIO,
  EMPTY_TYPED_SLICES,
  VERTICAL_SLICE_SCENARIO,
  WorldStateSchema,
  InvariantError,
  SMOKE_SCENARIO,
  companyId,
  type AccountingState,
  type Command,
  type CommandInput,
  type CommandRejectedEvent,
  type Event,
  type SystemId,
  type TypedDomainSliceId,
} from '../schema/index.js';
import { hashState } from './hash.js';
import {
  createServiceKey,
  PHASE_ORDER,
  SYSTEM_PHASES,
  type AnySystem,
  type Phase,
  type System,
} from './system.js';
import { chaosSystem } from './testkit.js';
import { createWorld, isWorldPoisoned, step, submit, type World } from './world.js';

const CO1 = companyId('co_000001');
const CO2 = companyId('co_000002');

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvariantError);
    return (e as InvariantError).code;
  }
  throw new Error('expected a throw');
}

function rename(issuer: string, name: string, target?: string): CommandInput {
  return target === undefined
    ? { type: 'company.rename', issuer: companyId(issuer), payload: { name } }
    : {
        type: 'company.rename',
        issuer: companyId(issuer),
        payload: { name, companyId: companyId(target) },
      };
}

function mustSubmit(world: World, input: CommandInput): number {
  const result = submit(world, input);
  if (!result.ok) throw new Error(result.error.issues.join('; '));
  return result.value;
}

function rejections(events: readonly Event[]): CommandRejectedEvent['payload'][] {
  return events
    .filter((e): e is CommandRejectedEvent => e.type === 'command.rejected')
    .map((e) => e.payload);
}

const TYPED_DOMAIN_IDS: readonly TypedDomainSliceId[] = [
  'accounting',
  'economy',
  'manufacturing',
  'retail',
  'finance',
];

function isTypedDomainId(id: SystemId): id is TypedDomainSliceId {
  return (TYPED_DOMAIN_IDS as readonly string[]).includes(id);
}

/**
 * A system for wiring tests. Under a typed slice id its slice is a valid empty slice (a copy of
 * `EMPTY_TYPED_SLICES[id]`); under an untyped id (`logistics`, `ai`, `hr`) it is arbitrary JSON.
 */
function probe(
  id: SystemId,
  phases: AnySystem['phases'],
  extra: Partial<AnySystem> = {},
): AnySystem {
  const init = isTypedDomainId(id)
    ? () => JSON.parse(JSON.stringify(EMPTY_TYPED_SLICES[id])) as unknown
    : () => ({ probe: id });
  return { id, handles: [], init, phases, ...extra };
}

describe('createWorld', () => {
  it('builds core fields and companies from the scenario, emitting company.founded', () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    expect(world.state).toMatchObject({
      seed: 1,
      tick: 0,
      epochYear: 2000,
      commandSeq: 0,
      pendingCommands: [],
    });
    expect(world.state.registry.counters).toEqual({ company: 2 });
    expect(world.state.companies[CO1]).toEqual({
      id: CO1,
      name: 'Player Holdings',
      controller: 'player',
      parentId: null,
      foundedTick: 0,
    });
    expect(world.state.companies[CO2]?.controller).toBe('ai');
    expect(world.state.accounting).toEqual(EMPTY_ACCOUNTING_STATE);
    // A mutable copy, never schema's deep-frozen constant.
    expect(world.state.accounting).not.toBe(EMPTY_ACCOUNTING_STATE);
    expect(Object.isFrozen(world.state.accounting)).toBe(false);
    expect(Object.isFrozen(world.state.accounting.entities)).toBe(false);
    expect(world.lastEvents.map((e) => [e.type, e.seq, e.tick, e.source])).toEqual([
      ['company.founded', 0, 0, 'core'],
      ['company.founded', 1, 0, 'core'],
    ]);
    expect(world.systems.map((s) => s.id)).toEqual(['core']);
  });

  it('installs a mutable copy of EMPTY_TYPED_SLICES[id] for every unregistered typed slice', () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    for (const id of TYPED_DOMAIN_IDS) {
      expect(world.state[id]).toEqual(EMPTY_TYPED_SLICES[id]);
      expect(world.state[id]).not.toBe(EMPTY_TYPED_SLICES[id]);
      expect(Object.isFrozen(world.state[id])).toBe(false);
    }
    expect(WorldStateSchema.safeParse(world.state).success).toBe(true);
    // Two worlds never share a slice object.
    const other = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    for (const id of TYPED_DOMAIN_IDS) expect(other.state[id]).not.toBe(world.state[id]);
  });

  it("a registered system's init value replaces the empty slice; others stay empty", () => {
    const marker = { ...EMPTY_TYPED_SLICES.economy };
    const economy: AnySystem = { id: 'economy', handles: [], init: () => marker, phases: {} };
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [economy] });
    expect(world.state.economy).toBe(marker);
    expect(world.state.retail).toEqual(EMPTY_TYPED_SLICES.retail);
  });

  it('VERTICAL_SLICE_SCENARIO creates its companies; content stays on the scenario', () => {
    const world = createWorld({ seed: 1, scenario: VERTICAL_SLICE_SCENARIO, systems: [] });
    const companies = Object.values(world.state.companies);
    expect(companies.map((c) => [c.name, c.controller])).toEqual(
      VERTICAL_SLICE_SCENARIO.companies.map((c) => [c.name, c.controller]),
    );
    // `Company` has no homeCity field (schema/company.ts): it is scenario data, read by domain
    // systems through ctx.scenario, as is the content pack.
    for (const c of companies)
      expect(Object.keys(c).sort()).toEqual([
        'controller',
        'foundedTick',
        'id',
        'name',
        'parentId',
      ]);
    expect(world.scenario.companies[0]?.homeCity).toBe(
      VERTICAL_SLICE_SCENARIO.companies[0]?.homeCity,
    );
    expect(world.scenario.content).toEqual(VERTICAL_SLICE_SCENARIO.content);
    expect(WorldStateSchema.safeParse(world.state).success).toBe(true);
  });

  it('rejects invalid seeds, scenarios and system sets', () => {
    expect(codeOf(() => createWorld({ seed: -1, scenario: EMPTY_SCENARIO, systems: [] }))).toBe(
      'world.invalid_seed',
    );
    expect(
      codeOf(() => createWorld({ seed: 1, scenario: { ...EMPTY_SCENARIO, id: '' }, systems: [] })),
    ).toBe('scenario.invalid');
    const sys = probe('economy', {});
    expect(
      codeOf(() => createWorld({ seed: 1, scenario: EMPTY_SCENARIO, systems: [sys, sys] })),
    ).toBe('systems.duplicate_id');
    expect(
      codeOf(() =>
        createWorld({ seed: 1, scenario: EMPTY_SCENARIO, systems: [probe('core', {})] }),
      ),
    ).toBe('systems.reserved_id');
    const ingest = probe('economy', { ingest: () => undefined } as unknown as AnySystem['phases']);
    expect(
      codeOf(() => createWorld({ seed: 1, scenario: EMPTY_SCENARIO, systems: [ingest] })),
    ).toBe('systems.invalid_phase');
    const dup = probe('economy', {}, { handles: ['company.rename'] });
    expect(codeOf(() => createWorld({ seed: 1, scenario: EMPTY_SCENARIO, systems: [dup] }))).toBe(
      'commands.duplicate_handler',
    );
    const noKey = probe('economy', {}, { createService: () => ({}) });
    expect(codeOf(() => createWorld({ seed: 1, scenario: EMPTY_SCENARIO, systems: [noKey] }))).toBe(
      'services.missing_key',
    );
  });

  it('close is reserved for accounting (ADR-009)', () => {
    for (const id of ['economy', 'manufacturing', 'finance', 'ai', 'hr'] as const) {
      const closer = probe(id, { close: () => undefined });
      try {
        createWorld({ seed: 1, scenario: EMPTY_SCENARIO, systems: [closer] });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(InvariantError);
        expect((e as InvariantError).code).toBe('systems.close_reserved');
        expect((e as InvariantError).details).toMatchObject({ system: id, phase: 'close' });
      }
    }
    // Accounting may register it, and other systems may register every other phase.
    let closes = 0;
    const accounting = probe('accounting', {
      close: () => {
        closes += 1;
      },
    });
    const others = probe('economy', {
      apply: () => undefined,
      finance: () => undefined,
      decide: () => undefined,
    });
    const world = createWorld({ seed: 1, scenario: EMPTY_SCENARIO, systems: [others, accounting] });
    step(world);
    expect(closes).toBe(1);
  });

  it('runs init in SYSTEM_ORDER with earlier services available', () => {
    const order: string[] = [];
    const KEY = createServiceKey<{ hello(): string }>('test.accounting');
    const first: AnySystem = {
      id: 'accounting',
      handles: [],
      init: () => {
        order.push('accounting');
        return { entities: {}, journal: [] };
      },
      phases: {},
      serviceKey: KEY,
      createService: () => ({ hello: () => 'hi' }),
    };
    const second: AnySystem = {
      id: 'logistics',
      handles: [],
      init: (ctx) => {
        order.push('logistics');
        return {
          greeting: ctx.services.get(KEY).hello(),
          companies: Object.keys(ctx.state.companies).length,
        };
      },
      phases: {},
    };
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [second, first] });
    expect(order).toEqual(['accounting', 'logistics']);
    expect(world.state.logistics).toEqual({ greeting: 'hi', companies: 2 });
    expect(world.systems.map((s) => s.id)).toEqual(['core', 'accounting', 'logistics']);
  });
});

describe('step: phases', () => {
  it('runs phases 1..8 in PHASE_ORDER, systems in SYSTEM_ORDER, every tick', () => {
    const calls: [number, Phase, SystemId][] = [];
    const recorder = (id: SystemId): AnySystem => {
      const phases: AnySystem['phases'] = {};
      for (const phase of SYSTEM_PHASES) {
        if (phase === 'close' && id !== 'accounting') continue; // ADR-009
        phases[phase] = (ctx) => {
          expect(ctx.phase).toBe(phase);
          calls.push([ctx.tick, phase, id]);
        };
      }
      return probe(id, phases);
    };
    // Deliberately registered out of order.
    const world = createWorld({
      seed: 1,
      scenario: EMPTY_SCENARIO,
      systems: [recorder('hr'), recorder('economy'), recorder('accounting')],
    });
    step(world);
    step(world);
    const expected: [number, Phase, SystemId][] = [];
    for (const tick of [0, 1]) {
      for (const phase of SYSTEM_PHASES) {
        for (const id of ['accounting', 'economy', 'hr'] as const) {
          if (phase !== 'close' || id === 'accounting') expected.push([tick, phase, id]);
        }
      }
    }
    expect(calls).toEqual(expected);
    expect(PHASE_ORDER.slice(1, 9)).toEqual(SYSTEM_PHASES);
    expect(PHASE_ORDER[0]).toBe('ingest');
    expect(PHASE_ORDER[9]).toBe('finalize');
  });

  it('returns the executed tick and date and advances state.tick', () => {
    const world = createWorld({ seed: 1, scenario: EMPTY_SCENARIO, systems: [] });
    for (let i = 0; i < 29; i++) step(world);
    const result = step(world);
    expect(result.tick).toBe(29);
    expect(result.date).toMatchObject({ day: 30, month: 1, isMonthEnd: true });
    expect(world.state.tick).toBe(30);
    expect(world.lastEvents).toBe(result.events);
  });

  it('empty world steps 1800 ticks quickly (budget: < 2 s)', { timeout: 2000 }, () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    for (let i = 0; i < 1800; i++) step(world);
    expect(world.state.tick).toBe(1800);
  });
});

describe('commands', () => {
  it('ingest processes strictly by seq across issuers; rejection paths', () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    const seqs = [
      mustSubmit(world, rename('co_000002', 'B1')),
      mustSubmit(world, rename('co_000001', 'A1')),
      mustSubmit(world, rename('co_000002', 'B2')),
      mustSubmit(world, rename('co_000099', 'Ghost')), // unknown_issuer
      mustSubmit(world, rename('co_000001', 'Theft', 'co_000002')), // not_owner
      mustSubmit(world, rename('co_000001', '   ')), // invalid_name
      mustSubmit(world, rename('co_000001', '  A2  ', 'co_000001')), // explicit self target, trimmed
    ];
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(world.state.pendingCommands.map((c) => c.tick)).toEqual([0, 0, 0, 0, 0, 0, 0]);

    // Inject a command type nobody handles (cannot be produced through submit's shape check).
    world.state.commandSeq += 1;
    world.state.pendingCommands.push({
      type: 'store.open',
      seq: world.state.commandSeq,
      tick: 0,
      issuer: CO1,
      payload: {},
    } as unknown as Command);

    const { events } = step(world);
    expect(events.map((e) => [e.seq, e.type, e.source])).toEqual([
      [0, 'command.rejected', 'core'], // ingest: unknown_issuer (seq 4)
      [1, 'command.rejected', 'core'], // ingest: no_handler (seq 8)
      [2, 'company.renamed', 'core'], // seq 1
      [3, 'company.renamed', 'core'], // seq 2
      [4, 'company.renamed', 'core'], // seq 3
      [5, 'command.rejected', 'core'], // seq 5 not_owner
      [6, 'command.rejected', 'core'], // seq 6 invalid_name
      [7, 'company.renamed', 'core'], // seq 7
    ]);
    expect(rejections(events).map((r) => [r.commandSeq, r.code])).toEqual([
      [4, 'unknown_issuer'],
      [8, 'no_handler'],
      [5, 'not_owner'],
      [6, 'invalid_name'],
    ]);
    expect(world.state.companies[CO1]?.name).toBe('A2');
    expect(world.state.companies[CO2]?.name).toBe('B2');
    expect(world.state.pendingCommands).toEqual([]);
    expect(events.every((e) => e.tick === 0)).toBe(true);
  });

  it('rejects every M1 command type with no_handler when its system is not registered', () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    const types = [
      'facility.build',
      'facility.set_recipe',
      'facility.set_production',
      'store.build',
      'store.set_price',
      'store.set_restock_policy',
      'loan.request',
      'loan.repay',
    ] as const;
    // Injected directly: routing must not depend on the payload, so a stub payload suffices.
    for (const type of types) {
      world.state.commandSeq += 1;
      world.state.pendingCommands.push({
        type,
        seq: world.state.commandSeq,
        tick: 0,
        issuer: CO1,
        payload: {},
      } as unknown as Command);
    }
    const { events } = step(world);
    expect(rejections(events)).toEqual(
      types.map((type, i) => ({
        commandSeq: i + 1,
        commandType: type,
        issuer: CO1,
        code: 'no_handler',
        reason: `no system handles ${type}`,
      })),
    );
    expect(events.every((e) => e.source === 'core')).toBe(true);
  });

  it('routes an M1 command type to the system whose handles lists it', () => {
    const seen: string[] = [];
    const finance = probe(
      'finance',
      {
        apply(ctx) {
          for (const c of ctx.commands) seen.push(c.type);
        },
      },
      { handles: ['loan.request', 'loan.repay'] },
    );
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [finance] });
    for (const type of ['loan.repay', 'store.build', 'loan.request'] as const) {
      world.state.commandSeq += 1;
      world.state.pendingCommands.push({
        type,
        seq: world.state.commandSeq,
        tick: 0,
        issuer: CO1,
        payload: {},
      } as unknown as Command);
    }
    const { events } = step(world);
    expect(seen).toEqual(['loan.repay', 'loan.request']);
    expect(rejections(events).map((r) => [r.commandType, r.code])).toEqual([
      ['store.build', 'no_handler'],
    ]);
  });

  it('submit returns invalid_shape for bad input and queues nothing', () => {
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [] });
    const bad = submit(world, {
      type: 'company.rename',
      issuer: CO1,
      payload: {},
    } as unknown as CommandInput);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('invalid_shape');
      expect(bad.error.issues.length).toBeGreaterThan(0);
    }
    expect(submit(world, { type: 'nope' } as unknown as CommandInput).ok).toBe(false);
    expect(world.state.commandSeq).toBe(0);
    expect(world.state.pendingCommands).toEqual([]);
  });

  it('ctx.submit in decide queues for the next tick', () => {
    const ai: AnySystem = probe('ai', {
      decide(ctx) {
        if (ctx.tick === 0) {
          const r = ctx.submit({
            type: 'company.rename',
            issuer: CO2,
            payload: { name: 'Rival 2' },
          });
          expect(r).toEqual({ ok: true, value: 1 });
        }
      },
    });
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [ai] });
    step(world);
    expect(world.state.pendingCommands).toMatchObject([{ seq: 1, tick: 1, issuer: CO2 }]);
    expect(world.state.companies[CO2]?.name).toBe('Rival Industries');
    const { events } = step(world);
    expect(events.map((e) => e.type)).toEqual(['company.renamed']);
    expect(world.state.companies[CO2]?.name).toBe('Rival 2');
  });

  it('submit outside the decide phase throws InvariantError and poisons the world', () => {
    let world: World | undefined;
    const viaCtx = probe('economy', {
      apply(ctx) {
        ctx.submit(rename('co_000001', 'X'));
      },
    });
    world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [viaCtx] });
    const w1 = world;
    expect(codeOf(() => step(w1))).toBe('commands.submit_outside_decide');
    expect(isWorldPoisoned(w1)).toBe(true);
    expect(codeOf(() => step(w1))).toBe('world.poisoned');

    const external = probe('retail', {
      market() {
        if (world !== undefined) submit(world, rename('co_000001', 'Y'));
      },
    });
    world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [external] });
    const w2 = world;
    expect(codeOf(() => step(w2))).toBe('commands.submit_outside_decide');
  });
});

describe('debug checks', () => {
  it('checkSliceOwnership catches a foreign write, not an own-slice or service write', () => {
    const vandal = probe('economy', {
      macro(ctx) {
        if (ctx.tick === 1) {
          (ctx.state.companies as Record<string, { name: string }>)['co_000001']!.name = 'pwned';
        }
      },
    });
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [vandal] });
    step(world, { checkSliceOwnership: true });
    try {
      step(world, { checkSliceOwnership: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantError);
      expect((e as InvariantError).code).toBe('slice.foreign_write');
      expect((e as InvariantError).details).toMatchObject({
        system: 'economy',
        phase: 'macro',
        slice: 'companies',
        tick: 1,
      });
    }

    // The same write without the flag goes unnoticed (the check is a debug aid).
    const world2 = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [vandal] });
    step(world2);
    step(world2);
    expect(world2.state.companies[CO1]?.name).toBe('pwned');
  });

  it('allows own-slice writes, ctx-mediated engine fields, and writes through the owner service', () => {
    const KEY = createServiceKey<{ bump(): void }>('test.counter');
    const owner: System<AccountingState & { n?: number }> = {
      id: 'accounting',
      handles: [],
      init: () => ({ entities: {}, journal: [] }),
      phases: {},
      serviceKey: KEY,
      createService: (handle) => ({
        bump() {
          handle.slice().journal.length = 0;
          handle.emit({
            type: 'company.renamed',
            payload: { companyId: CO1, name: 'via service' },
          });
        },
      }),
    };
    const user = {
      id: 'logistics',
      handles: [],
      init: () => ({ count: 0 }),
      phases: {
        macro(ctx) {
          ctx.slice.count += 1;
          ctx.rng.nextU32();
          ctx.rngFor('sub').nextU32();
          ctx.issueId('facility');
          ctx.services.get(KEY).bump();
        },
      },
    } satisfies System<{ count: number }>;
    const world = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [user, owner] });
    const { events } = step(world, { checkSliceOwnership: true, checkFinite: true });
    expect(events).toMatchObject([{ type: 'company.renamed', source: 'accounting', seq: 0 }]);
    expect(Object.keys(world.state.rng).sort()).toEqual(['logistics', 'logistics/sub']);
    expect(world.state.registry.counters.facility).toBe(1);
  });

  it('service write passes; a direct foreign write after only reading via the service throws', () => {
    interface Shelf {
      stock: number;
    }
    interface ShelfApi {
      stock(): number;
      take(n: number): void;
    }
    const KEY = createServiceKey<ShelfApi>('test.shelf');
    // Owner with an untyped plain-JSON slice under a real, not-yet-typed SystemId.
    const owner: System<Shelf> = {
      id: 'hr',
      handles: [],
      init: () => ({ stock: 100 }),
      phases: {},
      serviceKey: KEY,
      createService: (handle): ShelfApi => ({
        // Reads go through handle.state(), so they do not declare a mutation (ARCHITECTURE 6.2).
        stock: () => (handle.state().hr as unknown as Shelf).stock,
        take(n) {
          handle.slice().stock -= n;
        },
      }),
    };
    const caller = (mode: 'service' | 'direct'): AnySystem =>
      probe('logistics', {
        production(ctx) {
          const shelf = ctx.services.get(KEY);
          if (mode === 'service') {
            shelf.take(1);
          } else {
            const seen = shelf.stock();
            (ctx.state.hr as unknown as Shelf).stock = seen - 1;
          }
        },
      });

    const viaService = createWorld({
      seed: 1,
      scenario: SMOKE_SCENARIO,
      systems: [owner, caller('service')],
    });
    step(viaService, { checkSliceOwnership: true });
    step(viaService, { checkSliceOwnership: true });
    expect(viaService.state.hr).toEqual({ stock: 98 });

    const direct = createWorld({
      seed: 1,
      scenario: SMOKE_SCENARIO,
      systems: [owner, caller('direct')],
    });
    try {
      step(direct, { checkSliceOwnership: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvariantError);
      expect((e as InvariantError).code).toBe('slice.foreign_write');
      expect((e as InvariantError).details).toMatchObject({
        system: 'logistics',
        phase: 'production',
        slice: 'hr',
        tick: 0,
      });
    }
  });

  it('the command queue is excluded from the ownership check only in decide', () => {
    const forge = (phase: 'apply' | 'decide'): AnySystem =>
      probe('ai', {
        [phase]: (ctx: { state: unknown; tick: number }) => {
          const state = ctx.state as { commandSeq: number; pendingCommands: Command[] };
          state.commandSeq += 1;
          state.pendingCommands.push({
            type: 'company.rename',
            seq: state.commandSeq,
            tick: ctx.tick + 1,
            issuer: CO1,
            payload: { name: 'Forged' },
          });
        },
      });
    const outside = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [forge('apply')] });
    try {
      step(outside, { checkSliceOwnership: true });
      expect.unreachable();
    } catch (e) {
      expect((e as InvariantError).code).toBe('slice.foreign_write');
      expect((e as InvariantError).details).toMatchObject({ system: 'ai', phase: 'apply' });
      expect(['commandSeq', 'pendingCommands']).toContain((e as InvariantError).details['slice']);
    }
    // In decide the fields are ctx-mediated (submit) and not checked: a known, accepted gap.
    const inside = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [forge('decide')] });
    step(inside, { checkSliceOwnership: true });
    expect(inside.state.pendingCommands).toHaveLength(1);
    // ctx.submit in decide passes the check.
    const submitter = probe('ai', {
      decide(ctx) {
        ctx.submit(rename('co_000002', 'Legit'));
      },
    });
    const legit = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [submitter] });
    step(legit, { checkSliceOwnership: true });
    step(legit, { checkSliceOwnership: true });
    expect(legit.state.companies[CO2]?.name).toBe('Legit');
  });

  it('checkFinite reports non-finite paths', () => {
    const bad = probe('logistics', {
      finance(ctx) {
        (ctx.slice as Record<string, unknown>)['ratio'] = 0 / 0;
      },
    });
    const world = createWorld({ seed: 1, scenario: EMPTY_SCENARIO, systems: [bad] });
    try {
      step(world, { checkFinite: true });
      expect.unreachable();
    } catch (e) {
      expect((e as InvariantError).code).toBe('state.non_finite');
      expect((e as InvariantError).details['paths']).toEqual(['$.logistics.ratio']);
    }
  });

  it('services emitting outside a step throw', () => {
    const KEY = createServiceKey<{ shout(): void }>('test.shout');
    const sys = probe(
      'economy',
      {},
      {
        serviceKey: KEY,
        createService: (handle) => ({
          shout: () => {
            handle.emit({ type: 'company.renamed', payload: { companyId: CO1, name: 'x' } });
          },
        }),
      },
    );
    let svc: { shout(): void } | undefined;
    const grab = probe('ai', {
      decide(ctx) {
        svc = ctx.services.get(KEY);
        expect(() => ctx.services.get(createServiceKey('missing'))).toThrow(InvariantError);
      },
    });
    const world2 = createWorld({ seed: 1, scenario: SMOKE_SCENARIO, systems: [sys, grab] });
    step(world2);
    expect(codeOf(() => svc?.shout())).toBe('events.emit_outside_tick');
  });
});

describe('determinism', () => {
  function hashRun(seed: number, ticks: number, systems: readonly AnySystem[]): string[] {
    const world = createWorld({ seed, scenario: SMOKE_SCENARIO, systems });
    const hashes = [hashState(world.state)];
    for (let i = 0; i < ticks; i++) {
      step(world);
      hashes.push(hashState(world.state));
    }
    return hashes;
  }

  it('2 x 200 ticks, SMOKE_SCENARIO, no systems: identical hash every tick', () => {
    const a = hashRun(12345, 200, []);
    const b = hashRun(12345, 200, []);
    expect(a).toHaveLength(201);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(201); // the tick changes every step
  });

  it('2 x 200 ticks with an RNG-driven, command-submitting system: identical hash every tick', () => {
    const a = hashRun(99, 200, [chaosSystem]);
    const b = hashRun(99, 200, [chaosSystem]);
    expect(a).toEqual(b);
    expect(hashRun(100, 200, [chaosSystem as AnySystem])[200]).not.toBe(a[200]);
  });

  it('the chaos system actually exercises renames and rejections', () => {
    const world = createWorld({ seed: 99, scenario: SMOKE_SCENARIO, systems: [chaosSystem] });
    const types = new Set<string>();
    for (let i = 0; i < 200; i++)
      for (const e of step(world, { checkSliceOwnership: i < 20, checkFinite: true }).events)
        types.add(e.type);
    expect([...types].sort()).toEqual(['command.rejected', 'company.renamed']);
  });
});
