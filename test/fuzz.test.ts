/**
 * Fuzz test for the KQL compiler. Deterministic (seeded) so failures reproduce: on failure the
 * message includes the offending query.
 * Invariant: compileQuery either returns a predicate or throws QueryError — never anything else —
 * and a compiled predicate never throws on any row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten } from '../src/engine/parse';
import { compileFilters, compileQuery, QueryContext, QueryError } from '../src/engine/query';
import { cleanFilters } from '../src/sanitize';
import { HighlightTerm, Row } from '../src/engine/types';

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  'level', 'msg', 'latency', '@timestamp', '_index', '_file', 'a.b.c', '__proto__', 'constructor', 'toString',
  ':', '(', ')', '"', "'", '\\', '*', '**', '>', '<', '>=', '<=', '=', 'and', 'or', 'not', 'AND', 'OR', 'NOT',
  'ERROR', 'warn', '500', '-1', '1e309', 'NaN', 'null', 'true', '2026-11-13T10:00', '2026-13-45', '123456789012345',
  ' ', ' ', ' ', '\t', '\n', 'é', '日本', '\u0000', '\ud800', '$', '^', '[', ']', '{', '}', '|', '+', '?', '.', ',',
];

function randomQuery(r: () => number): string {
  const n = Math.floor(r() * 14);
  let q = '';
  for (let i = 0; i < n; i++) {
    if (r() < 0.1) q += String.fromCharCode(Math.floor(r() * 0x2fff));
    else q += PIECES[Math.floor(r() * PIECES.length)];
  }
  return q;
}

const ctx: QueryContext = { tsFieldOf: () => 'ts' };
const rows: Row[] = [
  '{"msg": "gateway timeout", "level": "ERROR", "latency": 900, "ts": "2026-11-13T10:00:00Z", "a": {"b": {"c": "x"}}}',
  '{"msg": null, "level": "warn", "latency": "12", "__proto__": "p"}',
  '{}',
].map((raw, i) => {
  const flat = flatten(JSON.parse(raw));
  const lower = Object.values(flat).map((v) => String(v).toLowerCase()).join('\n');
  return { id: i + 1, index: 'i', file: 'f.log', fileKey: 'i\u0000/f.log', ts: i === 0 ? Date.parse('2026-11-13T10:00:00Z') : null, flat, raw, lower, isJson: true, bytes: 0, arrival: 0 };
});

function check(q: string) {
  let pred: (r: Row) => boolean;
  const hl: HighlightTerm[] = [];
  try {
    pred = compileQuery(q, ctx, hl);
  } catch (e) {
    assert.ok(e instanceof QueryError, `non-QueryError ${e instanceof Error ? e.name + ': ' + e.message : String(e)} for ${JSON.stringify(q)}`);
    return;
  }
  for (const row of rows) {
    const v = pred(row);
    assert.equal(typeof v, 'boolean', `predicate returned ${typeof v} for ${JSON.stringify(q)}`);
  }
  for (const t of hl) assert.equal(typeof t.value, 'string');
}

test('fuzz: random token soup only ever yields a predicate or a QueryError', () => {
  const r = rng(0xc0ffee);
  const t0 = Date.now();
  for (let i = 0; i < 20_000; i++) check(randomQuery(r));
  assert.ok(Date.now() - t0 < 20_000, 'fuzz run took too long (possible pathological regex)');
});

test('fuzz: mutations of valid queries', () => {
  const seeds = [
    'level:ERROR and txn_id:abc*', 'msg:"gateway timeout"', 'latency > 500', 'level:(ERROR or WARN)',
    'not path:/health', '(a or b) and c', 'ts >= 2026-11-13T10:00', 'merchant_id:*', '"connection reset"',
  ];
  const r = rng(42);
  for (let i = 0; i < 20_000; i++) {
    const s = seeds[Math.floor(r() * seeds.length)].split('');
    const edits = 1 + Math.floor(r() * 4);
    for (let k = 0; k < edits; k++) {
      const at = Math.floor(r() * (s.length + 1));
      const op = r();
      if (op < 0.33) s.splice(at, 1);
      else if (op < 0.66) s.splice(at, 0, PIECES[Math.floor(r() * PIECES.length)]);
      else if (s.length) s[at % s.length] = PIECES[Math.floor(r() * PIECES.length)];
    }
    check(s.join(''));
  }
});

test('fuzz: random filters survive sanitising and compile or fail with QueryError', () => {
  const r = rng(7);
  const vals: unknown[] = [null, 1, -0, Infinity, NaN, '', 'x', true, {}, [], undefined, '__proto__', { toString: 1 }];
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  for (let i = 0; i < 5_000; i++) {
    const raw = Array.from({ length: Math.floor(r() * 4) }, () => ({
      field: pick(['level', '', 'a b', '__proto__', 'constructor', 7, null, randomQuery(r)]),
      op: pick(['is', 'is_one_of', 'between', 'exists', 'query', 'bogus', undefined]),
      value: pick(vals), values: pick([[], [1, 'a', null, {}], 'x', undefined]),
      gte: pick(vals), lte: pick(vals), query: randomQuery(r), negate: pick(vals), disabled: r() < 0.2,
    }));
    const filters = cleanFilters(raw);
    let pred;
    try {
      pred = compileFilters(filters, ctx);
    } catch (e) {
      assert.ok(e instanceof QueryError, `non-QueryError for ${JSON.stringify(filters)}`);
      continue;
    }
    if (pred) for (const row of rows) assert.equal(typeof pred(row), 'boolean');
  }
});
