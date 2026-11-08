import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InvariantError } from '../schema/index.js';
import { canonicalJson } from './canonical.js';
import { canonicalHash, canonicalHashReport } from './canonical-hash.js';
import { findNonFinite, hasNonFinite } from './finite.js';
import { hashString, hashValue } from './hash.js';

/** The ADR-008 definition, evaluated the slow way. */
function reference(value: unknown): string {
  return hashString(canonicalJson(value));
}

function thrown(fn: () => unknown): InvariantError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvariantError);
    return e as InvariantError;
  }
  throw new Error('expected a throw');
}

// Strings over every UTF-16 code unit (lone surrogates, C0 controls, quotes, backslashes) plus
// well-formed astral text.
const anyString = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: fc.constantFrom('"', '\\', '\b', '\f', '\n', '\r', '\t', '\u0000', '\u001f') }),
  fc.string({ unit: fc.integer({ min: 0xd800, max: 0xdfff }).map((c) => String.fromCharCode(c)) }),
);

// Keys: arbitrary strings, integer-like strings (enumerate numerically, not in code-unit order)
// and `__proto__`.
const anyKey = fc.oneof(
  anyString,
  fc.nat({ max: 100_000 }).map(String),
  fc.constantFrom('__proto__', '', '1e3', '01', 'B', 'a', '_'),
);

const anyNumber = fc.oneof(
  fc.integer(),
  fc.integer({ min: -0x7fffffff, max: 0x7fffffff }),
  fc.maxSafeInteger(),
  fc.constantFrom(
    0,
    -0,
    0x7fffffff,
    0x80000000,
    -0x80000000,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    2 ** 53,
    2 ** 53 + 2,
    1e21,
    -1e21,
    123456789012345680000,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    5e-324,
    0.1,
    1e-7,
    -1.5,
  ),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);

const { json: anyJson } = fc.letrec<{ json: unknown }>((tie) => ({
  json: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    anyNumber,
    anyString,
    fc.array(tie('json'), { maxLength: 6 }),
    // `Object.fromEntries` keeps an own `__proto__` key, and insertion order is random.
    fc
      .array(fc.tuple(anyKey, tie('json')), { maxLength: 6 })
      .map((entries) => Object.fromEntries(entries) as unknown),
  ),
}));

describe('canonicalHash (streaming) == hashString(canonicalJson(v))', () => {
  it('known-answer values (ADR-008, frozen)', () => {
    expect(canonicalHash('')).toBe(hashString('""'));
    expect(canonicalHash('nepo')).toBe(hashString('"nepo"'));
    // Fixed values, computed with the M0 `hashString(canonicalJson(v))`; must never change.
    expect(canonicalHash({ b: 1, a: [true, null, -0, 'é€'], c: { '1000': 2.5, '999': -7 } })).toBe(
      reference({ b: 1, a: [true, null, -0, 'é€'], c: { '1000': 2.5, '999': -7 } }),
    );
    expect(canonicalHash({ b: 1, a: [true, null, -0, 'é€'], c: { '1000': 2.5, '999': -7 } })).toBe(
      '982d107b64eec36a',
    );
    expect(canonicalHash([1e21, 2 ** 53, -(2 ** 31), 0.1, '\u0000"\\\ud800😀'])).toBe(
      'ef659f54d4e6afc1',
    );
    expect(reference([1e21, 2 ** 53, -(2 ** 31), 0.1, '\u0000"\\\ud800😀'])).toBe(
      'ef659f54d4e6afc1',
    );
  });

  it('matches the reference on scalar edge cases', () => {
    const cases: unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      1,
      -1,
      9,
      10,
      0x7fffffff,
      0x80000000,
      -0x80000000,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      2 ** 53,
      1e21,
      1e-7,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      '',
      '\u007f\u0080ÿĀ￿',
      '😀',
      '\ude00\ud83d',
      '\ud83d',
      'a\ud83d',
      '  ',
      [],
      {},
      [[], {}],
      Object.create(null) as object,
    ];
    for (const value of cases) expect(canonicalHash(value)).toBe(reference(value));
  });

  it('property: equals hashString(canonicalJson(v)) for arbitrary JSON values', () => {
    fc.assert(
      fc.property(anyJson, (value) => canonicalHash(value) === reference(value)),
      { numRuns: 2000 },
    );
  });

  it('property: equals the reference for fast-check jsonValue (unicode strings)', () => {
    fc.assert(
      fc.property(fc.jsonValue({ stringUnit: 'binary' }), (value) => {
        return canonicalHash(value) === reference(value);
      }),
      { numRuns: 500 },
    );
  });

  it('hashValue uses the streaming hasher', () => {
    const value = { z: [1, 'two', { three: 3.5 }], a: null };
    expect(hashValue(value)).toBe(reference(value));
    expect(hashValue(value, { collectNonFinite: true })).toEqual({
      hash: reference(value),
      nonFinite: [],
    });
  });

  it('throws exactly what canonicalJson throws', () => {
    const cyclic: Record<string, unknown> = { a: [1] };
    (cyclic['a'] as unknown[]).push({ back: cyclic });
    class Thing {
      x = 1;
    }
    const bad: unknown[] = [
      undefined,
      { a: undefined },
      [1, undefined],
      // eslint-disable-next-line no-sparse-arrays -- deliberately testing a hole
      [1, , 2],
      { deep: { list: [0, NaN] } },
      { a: Infinity },
      -Infinity,
      new Map(),
      { s: new Set([1]) },
      { d: new Uint8Array(1) },
      () => 1,
      { f: Symbol('s') },
      1n,
      new Thing(),
      cyclic,
      { 'odd key': { 2: [() => 0] } },
    ];
    for (const value of bad) {
      const expected = thrown(() => canonicalJson(value));
      const actual = thrown(() => canonicalHash(value));
      expect(actual.code).toBe(expected.code);
      expect(actual.message).toBe(expected.message);
      expect(actual.details).toEqual(expected.details);
    }
  });

  it('allows shared (non-cyclic) references, like canonicalJson', () => {
    const shared = { v: 1 };
    const value = { x: shared, y: [shared, shared] };
    expect(canonicalHash(value)).toBe(reference(value));
  });
});

describe('canonicalHashReport (collectNonFinite)', () => {
  it('reports NaN / Infinity / -0 in findNonFinite format and nulls the hash on NaN/Infinity', () => {
    const value = {
      b: [1, -0, Infinity],
      a: NaN,
      'c-d': { e: -Infinity, f: 0, g: 'NaN' },
      ok: { n: 1.5, s: null },
    };
    expect(canonicalHashReport(value)).toEqual({ hash: null, nonFinite: findNonFinite(value) });
    expect(canonicalHashReport(NaN)).toEqual({ hash: null, nonFinite: ['$'] });
  });

  it('a -0 is reported but hashes as 0', () => {
    expect(canonicalHashReport({ x: [-0] })).toEqual({
      hash: reference({ x: [0] }),
      nonFinite: ['$.x[0]'],
    });
  });

  it('still throws on non-numeric unsupported values', () => {
    expect(thrown(() => canonicalHashReport({ a: NaN, b: new Map() })).code).toBe(
      'canon.unsupported',
    );
  });

  it('property: matches hash + findNonFinite with injected non-finite numbers', () => {
    const { json } = fc.letrec<{ json: unknown }>((tie) => ({
      json: fc.oneof(
        { depthSize: 'small' },
        fc.constantFrom(NaN, Infinity, -Infinity, -0, 0, 1, 'x', null),
        fc.array(tie('json'), { maxLength: 5 }),
        fc
          .array(fc.tuple(anyKey, tie('json')), { maxLength: 5 })
          .map((entries) => Object.fromEntries(entries) as unknown),
      ),
    }));
    fc.assert(
      fc.property(json, (value) => {
        const report = canonicalHashReport(value);
        const paths = findNonFinite(value);
        if (JSON.stringify(report.nonFinite) !== JSON.stringify(paths)) return false;
        if (hasNonFinite(value) !== paths.length > 0) return false;
        let canon: string | null;
        try {
          canon = canonicalJson(value);
        } catch {
          canon = null;
        }
        return report.hash === (canon === null ? null : hashString(canon));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('findNonFinite options and hasNonFinite', () => {
  const value = { b: [1, -0, Infinity], a: NaN, c: { d: -Infinity } };

  it('limit stops early, keeping sorted order', () => {
    expect(findNonFinite(value)).toEqual(['$.a', '$.b[1]', '$.b[2]', '$.c.d']);
    expect(findNonFinite(value, { limit: 1 })).toEqual(['$.a']);
    expect(findNonFinite(value, { limit: 3 })).toEqual(['$.a', '$.b[1]', '$.b[2]']);
  });

  it('hasNonFinite', () => {
    expect(hasNonFinite(value)).toBe(true);
    expect(hasNonFinite({ a: [0, 1, 'x', null, { b: 2 }] })).toBe(false);
    expect(hasNonFinite(-0)).toBe(true);
    expect(hasNonFinite('NaN')).toBe(false);
  });

  it('tolerates cycles and visits shared objects once', () => {
    const shared = { n: NaN };
    const cyclic: Record<string, unknown> = { x: shared, y: shared };
    cyclic['self'] = cyclic;
    expect(findNonFinite(cyclic)).toEqual(['$.x.n']);
    expect(hasNonFinite(cyclic)).toBe(true);
  });
});
