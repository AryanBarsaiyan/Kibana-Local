/**
 * The engine's shortcuts (time index, dictionary encoding, memoized matchers, incremental field
 * stats, poll backoff) must give exactly the answers of the plain computation they replace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DICT_MAX_DISTINCT, ValueDict } from '../src/engine/dict';
import { own } from '../src/engine/parse';
import { LogStore } from '../src/engine/store';
import { FileTailer, pollEvery, TailerEvents } from '../src/engine/tailer';
import { QueryRequest, QueryResult } from '../src/engine/types';

const T0 = 1_700_000_000_000;
const big = { maxRows: 1e6, maxBytes: 1e10 };

function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}


test('time-range queries over out-of-order files match a brute-force filter', () => {
  const r = rng(1);
  const s = new LogStore(big);
  const all: { ts: number; i: number }[] = [];
  // three files arriving interleaved, each with jittered (partly out-of-order) timestamps
  for (let batch = 0; batch < 30; batch++) {
    const file = `/f${batch % 3}.log`;
    const lines: string[] = [];
    for (let k = 0; k < 50; k++) {
      const i = all.length;
      const ts = T0 + batch * 50_000 + Math.floor(r() * 120_000);
      all.push({ ts, i });
      lines.push(JSON.stringify({ ts, i, level: i % 7 ? 'INFO' : 'ERROR' }));
    }
    s.ingest('x', file, lines);
  }
  for (let k = 0; k < 40; k++) {
    const from = T0 + Math.floor(r() * 1_600_000), to = from + Math.floor(r() * 400_000);
    const res = s.query({ q: '', indexes: [], range: { kind: 'absolute', from, to } });
    assert.equal(res.total, all.filter((x) => x.ts >= from && x.ts <= to).length, `range ${from}..${to}`);
  }
  // relative range, newest first, matches the same filter
  const now = T0 + 1_700_000;
  const rel = s.query({ q: 'level:ERROR', indexes: [], range: { kind: 'relative', ms: 300_000 } }, now);
  assert.equal(rel.total, all.filter((x) => x.ts >= now - 300_000 && x.i % 7 === 0).length);
  const ts = s.page(0, rel.total).map((h) => h.ts as number);
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a), 'newest first');
});

test('time index stays correct through eviction, dropFile and a timestamp-field switch', () => {
  const s = new LogStore({ maxRows: 300, maxBytes: 1e10 });
  const mk = (i: number) => JSON.stringify({ ts: T0 + i * 1000, alt: T0 + (1000 - i) * 1000, i });
  s.ingest('x', '/a.log', Array.from({ length: 400 }, (_, i) => mk(i)));
  const range = (from: number, to: number): QueryRequest => ({ q: '', indexes: [], range: { kind: 'absolute', from: T0 + from * 1000, to: T0 + to * 1000 } });
  // rows 0..99 were evicted (oldest)
  assert.equal(s.query(range(0, 149)).total, 50);
  // 10 newer rows evict rows 100..109
  s.ingest('x', '/b.log', Array.from({ length: 10 }, (_, i) => mk(1000 + i)));
  assert.equal(s.query(range(1000, 2000)).total, 10);
  assert.equal(s.query(range(0, 149)).total, 40);
  s.dropFile('x', '/b.log');
  assert.equal(s.query(range(1000, 2000)).total, 0);
  assert.equal(s.size, 290);
  // switching the timestamp field rewrites every row's ts (alt = 1000 - i); the index must follow
  s.setOverrides({ ts: 'alt' });
  assert.equal(s.query(range(0, 1000)).total, 290);
  assert.equal(s.query(range(601, 700)).total, 100, 'rows 300..399');
  assert.equal(s.query(range(891, 1000)).total, 0, 'rows 100..109 are gone');
});

test('suggest inside a time range walks newest first', () => {
  const s = new LogStore(big);
  s.ingest('x', '/a.log', Array.from({ length: 100 }, (_, i) => JSON.stringify({ ts: T0 + i * 1000, svc: i < 50 ? 'old' : 'new' })));
  const r = s.suggest({ field: 'svc', prefix: '', indexes: [], range: { kind: 'absolute', from: T0 + 60_000, to: T0 + 99_000 } });
  assert.deepEqual(r.values, [{ v: 'new', c: 40 }]);
  assert.equal(r.sampled, 40);
});

test('dictionary encoding: low-cardinality values are shared, high-cardinality fields are dropped', () => {
  const d = new ValueDict();
  const a = d.lookup('level', 'INFO');
  assert.ok(a);
  assert.equal(a.lower, 'info');
  assert.equal(d.lookup('level', 'INFO'), a, 'same entry for the same value');
  for (let i = 0; i <= DICT_MAX_DISTINCT; i++) d.lookup('id', `req-${i}`);
  assert.equal(d.lookup('id', 'req-1'), undefined, 'high-cardinality field is no longer encoded');
  assert.equal(d.size, 1, 'its values were released');
  assert.equal(d.lookup('msg', 'x'.repeat(65)), undefined, 'long values are never encoded');
});

test('dictionary encoding does not change what rows contain or match', () => {
  const s = new LogStore(big);
  // built as text: in an object literal '__proto__' would set the prototype instead of a field
  s.ingest('x', '/a.log', Array.from({ length: 3000 }, (_, i) =>
    `{"ts":${T0 + i},"level":"${['INFO', 'Warn', 'ERROR'][i % 3]}","id":"ID-${i}","__proto__":"P","n":${i}}`));
  const all = (q: string) => s.query({ q, indexes: [], range: { kind: 'all' } });
  assert.equal(all('level:warn').total, 1000);
  assert.equal(all('id:id-2999').total, 1);
  assert.equal(all('__proto__:p').total, 3000);
  assert.equal(all('"warn"').total, 1000, 'free text sees the lowercased dictionary value');
  const h = s.page(0, 1)[0];
  assert.equal(own(h.flat, 'level'), 'Warn', 'original case is kept for display');
  assert.equal(own(h.flat, '__proto__'), 'P');
  assert.equal(Object.getPrototypeOf(h.flat), Object.prototype);
});

test('memoized matchers give per-value answers (case, numbers, groups, filters)', () => {
  const s = new LogStore(big);
  const vals = ['ERROR', 'error', 'Error ', 'ERRORS', 'warn', 'İ', 'i̇', 5, '5', null];
  s.ingest('x', '/a.log', Array.from({ length: 200 }, (_, i) => JSON.stringify({ ts: T0 + i, v: vals[i % vals.length] })));
  const n = (q: string, filters: QueryRequest['filters'] = []) => s.query({ q, indexes: [], range: { kind: 'all' }, filters }).total;
  // run twice: the second pass is served from each matcher's cache
  for (let pass = 0; pass < 2; pass++) {
    assert.equal(n('v:error'), 60, 'ERROR, error, "Error " (word match)');
    assert.equal(n('v:(error or warn)'), 80);
    assert.equal(n('v:(error and not errors)'), 60);
    assert.equal(n('v:5'), 40, 'number 5 and string "5"');
    assert.equal(n('', [{ field: 'v', op: 'is', value: 'error', negate: false, disabled: false }]), 40, 'exact match is case-insensitive');
    assert.equal(n('', [{ field: 'v', op: 'is', value: 'i̇', negate: false, disabled: false }]), 40, 'İ lowercases to i̇ (length changes)');
    assert.equal(n('', [{ field: 'v', op: 'is_one_of', values: ['warn', 5], negate: false, disabled: false }]), 60);
  }
});

test('own() never resolves Object.prototype members', () => {
  const flat: Record<string, string | number | null> = { a: 1, b: null, c: '' };
  for (const k of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf', '__defineGetter__']) {
    assert.equal(own(flat, k), undefined, k);
  }
  assert.equal(own(flat, 'a'), 1);
  assert.equal(own(flat, 'b'), null);
  assert.equal(own(flat, 'c'), '');
  assert.equal(own(flat, 'missing'), undefined);
});

test('field stats after ticks equal a full query', () => {
  const r = rng(7);
  const mk = (i: number) => JSON.stringify({ ts: T0 + i * 1000, level: ['INFO', 'WARN', 'ERROR'][Math.floor(r() * 3)], svc: `s${Math.floor(r() * 4)}`, ...(i % 3 ? { extra: i % 5 } : {}) });
  const inc = new LogStore({ maxRows: 15_000, maxBytes: 1e10 });
  const lines: string[] = [];
  for (let i = 0; i < 12_000; i++) lines.push(mk(i));
  inc.ingest('x', '/a.log', lines);
  const req: QueryRequest = { q: 'not level:WARN', indexes: [], range: { kind: 'relative', ms: 11_000_000 } };
  let now = T0 + 12_000_000;
  inc.query(req, now);
  let last: QueryResult | null = null;
  for (let round = 0; round < 6; round++) {
    const add: string[] = [];
    for (let k = 0; k < 400; k++) { add.push(mk(lines.length)); lines.push(add[add.length - 1]); }
    inc.ingest('x', '/a.log', add); // also evicts past 15k rows
    now += 400_000;
    last = inc.tick(now) ?? last;
  }
  assert.ok(last);
  const full = new LogStore({ maxRows: 15_000, maxBytes: 1e10 });
  full.ingest('x', '/a.log', lines);
  const f = full.query(req, now);
  assert.equal(last.total, f.total);
  assert.equal(last.fieldSample, f.fieldSample);
  assert.deepEqual(last.fields, f.fields);
  const top = (res: QueryResult) => res.fields.find((x) => x.name === 'ts')?.top.map((t) => t.v);
  assert.deepEqual(top(f), full.page(0, 5).map((h) => String(own(h.flat, 'ts'))), 'unique values: the newest are listed');
});

test('a high-cardinality field reports its newest values and keeps counting repeated ones', () => {
  const s = new LogStore(big);
  const mk = (i: number) => JSON.stringify({ ts: T0 + i, id: `id-${i}`, hot: i % 100 === 0 ? 'HOT' : `c${i}` });
  s.ingest('x', '/a.log', Array.from({ length: 6000 }, (_, i) => mk(i)));
  const req: QueryRequest = { q: '', indexes: [], range: { kind: 'all' } };
  const top = (res: QueryResult, f: string) => res.fields.find((x) => x.name === f)?.top;
  const r0 = s.query(req);
  assert.deepEqual(top(r0, 'id')?.map((t) => t.v), ['id-5999', 'id-5998', 'id-5997', 'id-5996', 'id-5995']);
  assert.deepEqual(top(r0, 'hot')?.[0], { v: 'HOT', c: 60 });
  s.ingest('x', '/a.log', Array.from({ length: 50 }, (_, i) => mk(6000 + i)));
  const r1 = s.tick()!;
  assert.deepEqual(top(r1, 'id')?.map((t) => t.v), ['id-6049', 'id-6048', 'id-6047', 'id-6046', 'id-6045']);
  assert.deepEqual(top(r1, 'hot')?.[0], { v: 'HOT', c: 61 });
});

test('field stats: 5 and "5" are one value; top values by count, ties newest first', () => {
  const s = new LogStore(big);
  s.ingest('x', '/a.log', [5, '5', 5, 7, 'a', 'a', 'a', true].map((v, i) => JSON.stringify({ ts: T0 + i, v })));
  const f = s.query({ q: '', indexes: [], range: { kind: 'all' } }).fields.find((x) => x.name === 'v');
  assert.deepEqual(f?.top, [{ v: 'a', c: 3 }, { v: '5', c: 3 }, { v: 'true', c: 1 }, { v: '7', c: 1 }]);
});

test('poll backoff schedule', () => {
  assert.equal(pollEvery(0), 1);
  assert.equal(pollEvery(4), 1);
  assert.equal(pollEvery(5), 2);
  assert.equal(pollEvery(15), 4);
  assert.equal(pollEvery(1000), 8);
});

test('an idle file in a folder index is polled less often and catches up on growth', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logscope-'));
  const f = path.join(dir, 'a.log');
  fs.writeFileSync(f, '{"i":0}\n');
  const got: string[] = [];
  const ev: TailerEvents = { onLines: (_f, l) => { got.push(...l); }, onTruncate() {}, onRotate() {}, onError() {} };
  const t = new FileTailer(f, ev, 1 << 20, 1 << 20, true);
  /** polls that actually stat'ed the file and found it unchanged */
  const idle = () => (t as unknown as { idlePolls: number }).idlePolls;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  try {
    t.start();
    await tick();
    for (let i = 0; i < 40; i++) { t.poke(); await tick(); }
    assert.ok(idle() >= 5 && idle() < 25, `idle file was stat'ed on ${idle()} of 40 polls`);
    fs.appendFileSync(f, '{"i":1}\n');
    for (let i = 0; i < 10; i++) { t.poke(); await tick(); }
    assert.deepEqual(got, ['{"i":0}', '{"i":1}'], 'growth is still picked up within the backoff window');
    assert.ok(idle() < 10, 'growth resets the backoff');
  } finally {
    t.dispose();
  }
});
