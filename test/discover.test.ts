import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogStore } from '../src/engine/store';
import { Filter, QueryRequest, SortSpec } from '../src/engine/types';

const T0 = 1_700_000_000_000;
const line = (i: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: T0 + i * 1000, level: ['INFO', 'WARN', 'ERROR'][i % 3], msg: `req ${i}`, n: i, ...extra });

function store(n = 30) {
  const s = new LogStore({ maxRows: 10_000, maxBytes: 1e9 });
  s.ingest('a', '/logs/a.log', Array.from({ length: n }, (_, i) => line(i, { svc: i % 2 ? 'api' : 'web' })));
  return s;
}
const req = (filters: Filter[] = [], sort: SortSpec[] = [], q = ''): QueryRequest => ({ q, indexes: [], range: { kind: 'all' }, filters, sort });
const f = (x: Partial<Filter>): Filter => ({ field: '', op: 'is', negate: false, disabled: false, ...x });
const ns = (s: LogStore, total: number) => s.page(0, total).map((h) => h.flat.n);

// ---------- filters ----------

const filterCases: [string, Filter[], number][] = [
  ['is', [f({ field: 'level', value: 'ERROR' })], 10],
  ['is, case-insensitive', [f({ field: 'level', value: 'error' })], 10],
  ['is is exact, not a word match', [f({ field: 'msg', value: 'req' })], 0],
  ['is a number', [f({ field: 'n', value: 7 })], 1],
  ['is a number given as text', [f({ field: 'n', value: '7' })], 1],
  ['is not', [f({ field: 'level', value: 'ERROR', negate: true })], 20],
  ['disabled filters are ignored', [f({ field: 'level', value: 'ERROR', disabled: true })], 30],
  ['is one of', [f({ field: 'level', op: 'is_one_of', values: ['ERROR', 'WARN'] })], 20],
  ['between numbers (inclusive)', [f({ field: 'n', op: 'between', gte: '10', lte: '14' })], 5],
  ['between with only a start', [f({ field: 'n', op: 'between', gte: '25' })], 5],
  ['between dates on @timestamp', [f({ field: '@timestamp', op: 'between', gte: new Date(T0 + 5000).toISOString(), lte: new Date(T0 + 9000).toISOString() })], 5],
  ['exists', [f({ field: 'svc', op: 'exists' })], 30],
  ['does not exist', [f({ field: 'nope', op: 'exists', negate: true })], 30],
  ['KQL query filter', [f({ op: 'query', query: 'level:ERROR or n < 3' })], 12],
  ['filters AND together', [f({ field: 'level', value: 'ERROR' }), f({ field: 'svc', value: 'api' })], 5],
];
for (const [name, filters, n] of filterCases) {
  test(`filter: ${name} → ${n}`, () => {
    const r = store().query(req(filters));
    assert.equal(r.error, undefined);
    assert.equal(r.total, n);
  });
}

test('filters combine with the query', () => {
  assert.equal(store().query(req([f({ field: 'svc', value: 'web' })], [], 'level:ERROR')).total, 5);
});

test('invalid filters report an error', () => {
  assert.match(store().query(req([f({ op: 'query', query: 'level:(' })])).error ?? '', /Filter/);
  assert.ok(store().query(req([f({ field: 'bad field', value: 'x' })])).error);
  assert.ok(store().query(req([f({ field: 'n', op: 'between' })])).error);
});

// ---------- sorting ----------

test('sort by a numeric field ascending and descending', () => {
  const s = store();
  assert.deepEqual(ns(s, s.query(req([], [{ field: 'n', dir: 'asc' }])).total).slice(0, 3), [0, 1, 2]);
  assert.deepEqual(ns(s, s.query(req([], [{ field: 'n', dir: 'desc' }])).total).slice(0, 3), [29, 28, 27]);
});

test('sort by time ascending', () => {
  const s = store();
  const r = s.query(req([], [{ field: '@timestamp', dir: 'asc' }]));
  assert.deepEqual(ns(s, r.total).slice(0, 2), [0, 1]);
});

test('numeric strings sort numerically, missing values last in both directions', () => {
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  s.ingest('a', '/a.log', [line(1, { code: '500' }), line(2, { code: '1000' }), line(3), line(4, { code: '20' })]);
  const asc = s.query(req([], [{ field: 'code', dir: 'asc' }]));
  assert.deepEqual(s.page(0, asc.total).map((h) => h.flat.code), ['20', '500', '1000', undefined]);
  const desc = s.query(req([], [{ field: 'code', dir: 'desc' }]));
  assert.deepEqual(s.page(0, desc.total).map((h) => h.flat.code), ['1000', '500', '20', undefined]);
});

test('multi-key sort; ties fall back to newest first', () => {
  const s = store(9);
  const r = s.query(req([], [{ field: 'level', dir: 'asc' }]));
  // ERROR < INFO < WARN, each group newest first
  assert.deepEqual(ns(s, r.total), [8, 5, 2, 6, 3, 0, 7, 4, 1]);
  const r2 = s.query(req([], [{ field: 'level', dir: 'asc' }, { field: 'n', dir: 'asc' }]));
  assert.deepEqual(ns(s, r2.total), [2, 5, 8, 0, 3, 6, 1, 4, 7]);
});

test('virtual _level sorts by each index\'s own level field', () => {
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  s.ingest('a', '/a.log', [JSON.stringify({ ts: T0, level: 'WARN', msg: 'a' })]);
  s.ingest('b', '/b.log', [JSON.stringify({ ts: T0 + 1, severity: 'ERROR', message: 'b' })]);
  const r = s.query(req([], [{ field: '_level', dir: 'asc' }]));
  assert.deepEqual(s.page(0, r.total).map((h) => h.index), ['b', 'a']);
});

test('incremental tick with a custom sort matches a full query', () => {
  const sort: SortSpec[] = [{ field: 'n', dir: 'asc' }];
  const lines = Array.from({ length: 60 }, (_, i) => line(i));
  const inc = new LogStore({ maxRows: 1000, maxBytes: 1e9 });
  inc.ingest('x', '/x.log', lines.slice(0, 30));
  inc.query(req([f({ field: 'level', value: 'INFO', negate: true })], sort));
  inc.ingest('x', '/x.log', lines.slice(30));
  const t = inc.tick()!;
  const full = new LogStore({ maxRows: 1000, maxBytes: 1e9 });
  full.ingest('x', '/x.log', lines);
  const r = full.query(req([f({ field: 'level', value: 'INFO', negate: true })], sort));
  assert.equal(t.total, r.total);
  assert.deepEqual(ns(inc, t.total), ns(full, r.total));
});

test('relative range slides correctly under a custom sort', () => {
  const now = Date.now();
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  s.ingest('x', '/x.log', [-50, -20, -5].map((sec, i) => JSON.stringify({ ts: now + sec * 1000, n: i })));
  const r = s.query({ q: '', indexes: [], range: { kind: 'relative', ms: 60_000 }, sort: [{ field: 'n', dir: 'asc' }] }, now);
  assert.equal(r.total, 3);
  const t = s.tick(now + 30_000)!;
  assert.equal(t.total, 2);
  assert.deepEqual(s.page(0, 2).map((h) => h.flat.n), [1, 2]);
});

// ---------- surrounding documents ----------

const idOf = (s: LogStore, n: number) => {
  const r = s.query(req());
  return s.page(0, r.total).find((h) => h.flat.n === n)!.id;
};

test('context returns nearest newer and older neighbours, newest first', () => {
  const s = store();
  const c = s.context({ id: idOf(s, 15), newer: 3, older: 2, indexes: [], sameFile: false });
  assert.equal(c.anchor?.flat.n, 15);
  assert.deepEqual(c.newer.map((h) => h.flat.n), [18, 17, 16]);
  assert.deepEqual(c.older.map((h) => h.flat.n), [14, 13]);
  assert.equal(c.moreNewer, true);
  assert.equal(c.moreOlder, true);
});

test('context ends: no more beyond the newest/oldest entries', () => {
  const s = store();
  const c = s.context({ id: idOf(s, 1), newer: 0, older: 5, indexes: [], sameFile: false });
  assert.deepEqual(c.older.map((h) => h.flat.n), [0]);
  assert.equal(c.moreOlder, false);
});

test('context applies filters but ignores the query', () => {
  const s = store();
  s.query(req([], [], 'n:15'));
  const c = s.context({ id: idOf(s, 15), newer: 2, older: 2, indexes: [], filters: [f({ field: 'svc', value: 'api' })], sameFile: false });
  assert.deepEqual(c.newer.map((h) => h.flat.n), [19, 17]);
  assert.deepEqual(c.older.map((h) => h.flat.n), [13, 11]);
});

test('context: only this file, and index selection', () => {
  const s = store(10);
  s.ingest('a', '/logs/b.log', [line(4.5, { n: 'b' })]);
  s.ingest('other', '/o.log', [line(5.5, { n: 'o' })]);
  const id = idOf(s, 5);
  const sel = s.context({ id, newer: 1, older: 1, indexes: ['a'], sameFile: false });
  assert.deepEqual([sel.newer[0].flat.n, sel.older[0].flat.n], [6, 'b']);
  const all = s.context({ id, newer: 1, older: 1, indexes: [], sameFile: false });
  assert.equal(all.newer[0].flat.n, 'o');
  const file = s.context({ id, newer: 1, older: 1, indexes: [], sameFile: true });
  assert.deepEqual([file.newer[0].flat.n, file.older[0].flat.n], [6, 4]);
});

test('context matches a full sort, with untimed and out-of-order rows', () => {
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const s = new LogStore({ maxRows: 10_000, maxBytes: 1e9 });
  for (let b = 0; b < 20; b++) {
    const file = b % 2 ? '/logs/x.log' : '/logs/y.log';
    const lines: string[] = [];
    for (let k = 0; k < 10; k++) {
      const n = b * 10 + k;
      const svc = rnd(2) ? 'api' : 'web';
      // a few untimed rows, repeated timestamps and out-of-order arrival
      lines.push(rnd(5) === 0 ? JSON.stringify({ n, svc }) : line(rnd(60), { n, svc }));
    }
    s.ingest(b % 3 ? 'a' : 'b', file, lines);
  }
  const all = s.page(0, s.query(req()).total);
  const filters = [f({ field: 'svc', value: 'api' })];
  for (const anchor of all) {
    const cases: { indexes: string[]; sameFile: boolean; filters?: Filter[] }[] = [{ indexes: [], sameFile: false }, { indexes: ['a'], sameFile: false, filters }, { indexes: [], sameFile: true }];
    for (const opts of cases) {
      const c = s.context({ id: anchor.id, newer: 4, older: 3, ...opts });
      const p = all.indexOf(anchor);
      const keep = (h: typeof anchor) => (opts.sameFile ? h.file === anchor.file && h.index === anchor.index : !opts.indexes.length || opts.indexes.includes(h.index))
        && (!opts.filters || h.flat.svc === 'api');
      const newer = all.slice(0, p).filter(keep), older = all.slice(p + 1).filter(keep);
      assert.deepEqual(c.newer.map((h) => h.id), newer.slice(Math.max(0, newer.length - 4)).map((h) => h.id));
      assert.deepEqual(c.older.map((h) => h.id), older.slice(0, 3).map((h) => h.id));
      assert.equal(c.moreNewer, newer.length > 4);
      assert.equal(c.moreOlder, older.length > 3);
    }
  }
});

test('context for a document that is no longer loaded', () => {
  const c = store().context({ id: 999_999, newer: 5, older: 5, indexes: [], sameFile: false });
  assert.equal(c.anchor, null);
  assert.ok(c.error);
});
