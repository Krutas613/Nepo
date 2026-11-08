import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InvariantError, companyId, type CompanyId, type RegistryState } from '../schema/index.js';
import { canonicalJson } from './canonical.js';
import { findNonFinite } from './finite.js';
import { hashString, hashValue } from './hash.js';
import { formatEntityId, issueId } from './registry.js';
import { sortedKeys } from './sorted.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvariantError);
    return (e as InvariantError).code;
  }
  throw new Error('expected a throw');
}

describe('canonicalJson', () => {
  it('sorts keys by UTF-16 code units at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null }, B: true, _: 'x' })).toBe(
      '{"B":true,"_":"x","a":{"c":null,"d":[3,1,2]},"b":1}',
    );
    expect(canonicalJson({ é: 1, z: 2, '😀': 3 })).toBe('{"z":2,"é":1,"😀":3}');
  });

  it('formats scalars', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ x: -0 })).toBe('{"x":0}');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(0.1)).toBe('0.1');
    expect(canonicalJson(-5)).toBe('-5');
    expect(canonicalJson('a"b\n')).toBe('"a\\"b\\n"');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([[], [[1]], {}])).toBe('[[],[[1]],{}]');
    expect(canonicalJson(Object.create(null) as object)).toBe('{}');
  });

  it('rejects unsupported values', () => {
    expect(codeOf(() => canonicalJson(undefined))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson({ a: undefined }))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson([1, undefined]))).toBe('canon.unsupported');
    // eslint-disable-next-line no-sparse-arrays -- deliberately testing a hole
    expect(codeOf(() => canonicalJson([1, , 2]))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson(NaN))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson({ a: Infinity }))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson(-Infinity))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson(new Map()))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson(new Set([1])))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson({ d: new Uint8Array(1) }))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson(() => 1))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson(Symbol('s')))).toBe('canon.unsupported');
    expect(codeOf(() => canonicalJson(1n))).toBe('canon.unsupported');
    class Thing {
      x = 1;
    }
    expect(codeOf(() => canonicalJson(new Thing()))).toBe('canon.unsupported');
  });

  it('detects cycles but allows shared references', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(codeOf(() => canonicalJson(a))).toBe('canon.cycle');
    const shared = { v: 1 };
    expect(canonicalJson({ x: shared, y: [shared] })).toBe('{"x":{"v":1},"y":[{"v":1}]}');
  });

  it('round-trips through JSON.parse', () => {
    const value = { z: [1, 'two', { three: 3.5 }], a: null };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });

  it('serializes an own __proto__ key like any other key', () => {
    const value = Object.fromEntries([
      ['__proto__', 1],
      ['a', 2],
    ]) as Record<string, unknown>;
    expect(canonicalJson(value)).toBe('{"__proto__":1,"a":2}');
    expect(canonicalJson(JSON.parse('{"a":2,"__proto__":1}'))).toBe('{"__proto__":1,"a":2}');
  });

  it('property: output is independent of key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (dict) => {
        // `Object.fromEntries` defines own properties, so a generated `__proto__` key stays a key
        // (plain assignment would set the prototype and drop it).
        const reversed = Object.fromEntries(
          Object.keys(dict)
            .reverse()
            .map((key) => [key, dict[key]]),
        );
        const canon = canonicalJson(dict);
        return canon === canonicalJson(reversed) && canonicalJson(JSON.parse(canon)) === canon;
      }),
    );
  });
});

describe('hashString / hashValue (ADR-008, frozen)', () => {
  it('known-answer values', () => {
    expect(hashString('')).toBe('811c9dc5cbf29ce4');
    expect(hashString('nepo')).toBe('d4d95c81e6900f50');
    // Non-ASCII: both bytes of each UTF-16 unit are fed.
    expect(hashString('é€')).toBe('3a92d6405b55c8c1');
  });

  it('is 16 lowercase hex chars and hashValue hashes the canonical form', () => {
    expect(hashValue({ b: 1, a: 2 })).toMatch(/^[0-9a-f]{16}$/);
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });
});

describe('findNonFinite', () => {
  it('returns JSON paths of NaN, +-Infinity and -0 in sorted-key order', () => {
    expect(
      findNonFinite({
        b: [1, -0, Infinity],
        a: NaN,
        'c-d': { e: -Infinity, f: 0, g: 'NaN' },
        ok: { n: 1.5, s: null },
      }),
    ).toEqual(['$.a', '$.b[1]', '$.b[2]', '$["c-d"].e']);
    expect(findNonFinite(NaN)).toEqual(['$']);
  });

  it('returns [] for clean data', () => {
    expect(findNonFinite({ a: [0, 1, -1, 0.5], b: { c: 'x', d: null, e: true } })).toEqual([]);
  });
});

describe('sortedKeys and registry', () => {
  it('sortedKeys orders by UTF-16 code units', () => {
    const r: Record<CompanyId, number> = {};
    r[companyId('co_000010')] = 1;
    r[companyId('co_000002')] = 2;
    r[companyId('co_000001')] = 3;
    expect(sortedKeys(r)).toEqual(['co_000001', 'co_000002', 'co_000010']);
    expect(sortedKeys({ b: 1, B: 2, a: 3 })).toEqual(['B', 'a', 'b']);
  });

  it('issues per-kind sequential IDs and never reuses them', () => {
    const registry: RegistryState = { counters: {} };
    expect(issueId(registry, 'company')).toBe('co_000001');
    expect(issueId(registry, 'company')).toBe('co_000002');
    expect(issueId(registry, 'journalEntry')).toBe('je_000001');
    expect(registry.counters).toEqual({ company: 2, journalEntry: 1 });
    registry.counters.store = 999_999;
    expect(issueId(registry, 'store')).toBe('st_1000000');
    expect(formatEntityId('facility', 42)).toBe('fa_000042');
  });
});
