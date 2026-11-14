import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogStore } from '../src/engine/store';
import { QueryRequest } from '../src/engine/types';

const line = (i: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: 1_700_000_000_000 + i * 1000, level: i % 5 ? 'INFO' : 'ERROR', msg: `req ${i}`, n: i, ...extra });

const ids = (s: LogStore, total: number) => s.page(0, total).map((h) => h.id);

test('per-index field detection', () => {
  const s = new LogStore({ maxRows: 1000, maxBytes: 1e9 });
  s.ingest('a', '/a.log', [JSON.stringify({ '@timestamp': '2026-11-13T10:00:00Z', severity: 'WARN', message: 'x' })]);
  s.ingest('b', '/b.log', [JSON.stringify({ time: 1763028000, lvl: 'ERROR', text: 'y' })]);
  assert.deepEqual(s.detectedFor('a'), { ts: '@timestamp', level: 'severity', msg: 'message' });
  assert.deepEqual(s.detectedFor('b'), { ts: 'time', level: 'lvl', msg: 'text' });
  const r = s.query({ q: '', indexes: [], range: { kind: 'all' } });
  assert.ok(r.hits.every((h) => h.ts !== null), 'both indexes get timestamps');
  // @timestamp alias resolves to each index's own ts field
  assert.equal(s.query({ q: '@timestamp >= 2025-01-01', indexes: [], range: { kind: 'all' } }).total, 2);
});

test('incremental tick gives the same result as a full query', () => {
  const req: QueryRequest = { q: 'level:ERROR or n > 90', indexes: [], range: { kind: 'all' } };
  const inc = new LogStore({ maxRows: 1000, maxBytes: 1e9 });
  const full = new LogStore({ maxRows: 1000, maxBytes: 1e9 });
  const lines = Array.from({ length: 100 }, (_, i) => line(i));
  inc.ingest('x', '/x.log', lines.slice(0, 40));
  inc.query(req);
  inc.ingest('x', '/x.log', lines.slice(40, 70));
  const t1 = inc.tick()!;
  assert.equal(t1.reset, false);
  assert.ok(t1.prepended > 0, 'new rows land on top');
  inc.ingest('x', '/x.log', lines.slice(70));
  const t2 = inc.tick()!;
  full.ingest('x', '/x.log', lines);
  const f = full.query(req);
  assert.equal(t2.total, f.total);
  assert.deepEqual(ids(inc, t2.total), ids(full, f.total));
  assert.equal(inc.tick(), null, 'nothing pending → no result');
});

test('out-of-order arrivals merge correctly and report shifted positions', () => {
  const s = new LogStore({ maxRows: 1000, maxBytes: 1e9 });
  s.ingest('x', '/x.log', [line(10), line(20)]);
  s.query({ q: '', indexes: [], range: { kind: 'all' } });
  s.ingest('x', '/x.log', [line(15)]);
  const r = s.tick()!;
  assert.equal(r.prepended, -1);
  assert.deepEqual(s.page(0, 3).map((h) => h.flat.n), [20, 15, 10]);
});

test('row cap evicts oldest via ring buffer and keeps session consistent', () => {
  const s = new LogStore({ maxRows: 50, maxBytes: 1e9 });
  s.ingest('x', '/x.log', Array.from({ length: 50 }, (_, i) => line(i)));
  s.query({ q: '', indexes: [], range: { kind: 'all' } });
  s.ingest('x', '/x.log', Array.from({ length: 30 }, (_, i) => line(50 + i)));
  const r = s.tick()!;
  assert.equal(s.size, 50);
  assert.equal(r.total, 50);
  assert.equal(Math.min(...s.page(0, 50).map((h) => h.flat.n as number)), 30);
});

test('memory budget evicts oldest rows', () => {
  const s = new LogStore({ maxRows: 1e9, maxBytes: 200_000 });
  s.ingest('x', '/x.log', Array.from({ length: 5000 }, (_, i) => line(i, { pad: 'x'.repeat(100) })));
  assert.ok(s.memoryBytes <= 200_000);
  assert.ok(s.size > 100 && s.size < 5000);
});

test('stack-trace continuation lines attach and become searchable incrementally', () => {
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  s.ingest('x', '/x.log', [line(1)]);
  s.query({ q: 'NullPointer', indexes: [], range: { kind: 'all' } });
  s.ingest('x', '/x.log', ['    at java.lang.NullPointer(Foo.java:1)']);
  const r = s.tick()!;
  assert.equal(r.total, 1);
  assert.equal(s.size, 1);
});

test('continuation lines across batches: joined text, searchable, memory accounted', () => {
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  s.ingest('x', '/x.log', ['2026-11-13 10:00:00.000 ERROR job failed', 'java.lang.IllegalStateException: Boom', '\tat A.a(A.java:1)']);
  const before = s.memoryBytes;
  s.ingest('x', '/x.log', ['\tat B.b(B.java:2)', '\tat C.c(C.java:3)']);
  assert.equal(s.size, 1);
  const hit = s.query({ q: '', indexes: [], range: { kind: 'all' } }).hits[0];
  assert.equal(hit.raw, ['2026-11-13 10:00:00.000 ERROR job failed', 'java.lang.IllegalStateException: Boom', '\tat A.a(A.java:1)', '\tat B.b(B.java:2)', '\tat C.c(C.java:3)'].join('\n'));
  assert.equal(hit.flat._continuation, ['java.lang.IllegalStateException: Boom', '\tat A.a(A.java:1)', '\tat B.b(B.java:2)', '\tat C.c(C.java:3)'].join('\n'));
  // the second batch adds "\tat B…\n\tat C…" (+1 newline) to raw, lower and _continuation
  const added = '\tat B.b(B.java:2)\n\tat C.c(C.java:3)'.length + 1;
  assert.equal(s.memoryBytes - before, 3 * added);
  assert.equal(s.query({ q: 'illegalstateexception', indexes: [], range: { kind: 'all' } }).total, 1);
  assert.equal(s.query({ q: 'C.java', indexes: [], range: { kind: 'all' } }).total, 1);
});

test('a stack trace stops growing at the size cap', () => {
  const s = new LogStore({ maxRows: 100_000, maxBytes: 1e9 });
  const frame = '\tat ' + 'x'.repeat(995);
  s.ingest('x', '/x.log', ['2026-11-13 10:00:00.000 ERROR boom', ...Array.from({ length: 300 }, () => frame)]);
  const hits = s.query({ q: '', indexes: [], range: { kind: 'all' } }).hits;
  assert.ok(s.size > 1, 'frames past the cap become rows of their own');
  const head = hits.find((h) => h.raw.startsWith('2026'))!;
  assert.ok(head.raw.length >= 200_000 && head.raw.length < 201_100);
});

test('unindented JVM exception header joins the preceding log line with its stack trace', () => {
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  s.ingest('x', '/x.log', [
    '2026-11-13 10:00:00.000 ERROR [worker-1] c.e.batch.Job - job failed',
    'java.lang.IllegalStateException: cursor closed',
    '\tat com.example.batch.Job.run(Job.java:142)',
    'Caused by: java.sql.SQLException: connection lost',
    '\t... 2 more',
    '2026-11-13 10:00:01.000 ERROR [main] c.e.App - fatal',
    'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space',
    '2026-11-13 10:00:02.000 WARN [main] c.e.App - nested',
    'com.acme.Outer$InnerError',
    '2026-11-13 10:00:03.000 INFO [main] c.e.App - next',
  ]);
  assert.equal(s.size, 4);
  const r = s.query({ q: 'IllegalStateException', indexes: [], range: { kind: 'all' } });
  assert.equal(r.total, 1);
  assert.equal(r.hits[0].ts, Date.parse('2026-11-13T10:00:00.000'));
  assert.equal(r.hits[0].raw.split('\n').length, 5);
  assert.equal(s.query({ q: 'OutOfMemoryError', indexes: [], range: { kind: 'all' } }).hits[0].ts, Date.parse('2026-11-13T10:00:01.000'));
  assert.equal(s.query({ q: 'InnerError', indexes: [], range: { kind: 'all' } }).hits[0].ts, Date.parse('2026-11-13T10:00:02.000'));
});

test('lines that merely look like errors still start new entries', () => {
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  s.ingest('x', '/x.log', [
    '2026-11-13 10:00:00.000 INFO start',
    'Error: disk full',
    'TypeError: x is not a function',
    'java.lang.String is a class name, not an exception',
    'MyException: no package prefix',
  ]);
  assert.equal(s.size, 5);
});

const ALL = { q: '', indexes: [] as string[], range: { kind: 'all' } as const };
const T0 = 1_700_000_000_000;
const tsLines = (n: number, start: number, step = 1000) => Array.from({ length: n }, (_, i) => JSON.stringify({ ts: start + i * step, msg: `m${i}` }));

test('row limit is per index: each index keeps its own newest rows, regardless of load order or age', () => {
  const s = new LogStore({ maxRows: 1e9, maxBytes: 1e9 });
  s.ingest('a', '/a.log', tsLines(100, T0 + 100_000)); // newer, loaded first
  s.ingest('b', '/b.log', tsLines(100, T0)); // older, loaded last
  s.setLimits({ maxRows: 50, maxBytes: 1e9 });
  assert.equal(s.query(ALL).total, 100);
  assert.deepEqual(s.indexRows(), { a: 50, b: 50 });
  for (const [idx, start] of [['a', T0 + 100_000], ['b', T0]] as const) {
    const r = s.query({ ...ALL, indexes: [idx] });
    const kept = s.page(0, r.total).map((h) => h.ts!);
    assert.equal(Math.min(...kept), start + 50_000, `${idx} keeps its newest 50`);
    assert.equal(Math.max(...kept), start + 99_000);
  }
});

test('per-index limit applies across the files of a folder index by timestamp', () => {
  const s = new LogStore({ maxRows: 30, maxBytes: 1e9 });
  s.ingest('svc', '/svc/new.log', tsLines(20, T0 + 100_000));
  s.ingest('svc', '/svc/old.log', tsLines(20, T0));
  s.ingest('other', '/o.log', tsLines(5, T0));
  assert.deepEqual(s.indexRows(), { svc: 30, other: 5 });
  // old.log's 10 oldest rows went first
  assert.equal(s.query({ ...ALL, indexes: ['svc'], range: { kind: 'absolute', from: T0, to: T0 + 9_000 } }).total, 0);
  assert.equal(s.query({ ...ALL, indexes: ['svc'], range: { kind: 'absolute', from: T0 + 10_000, to: T0 + 19_000 } }).total, 10);
});

test('memory budget is shared: oldest rows by timestamp go first, from any index', () => {
  const s = new LogStore({ maxRows: 1e9, maxBytes: 1e12 });
  s.ingest('a', '/a.log', tsLines(100, T0 + 100_000));
  s.ingest('b', '/b.log', tsLines(100, T0));
  const perRow = s.memoryBytes / 200;
  s.setLimits({ maxRows: 1e9, maxBytes: Math.floor(perRow * 120) });
  const rows = s.indexRows();
  assert.equal(rows.a, 100); // newer index untouched
  assert.ok(rows.b < 25, `older index trimmed first (b=${rows.b})`);
});

test('incremental tick after per-index eviction matches a full query', () => {
  const s = new LogStore({ maxRows: 30, maxBytes: 1e9 });
  s.ingest('a', '/a.log', tsLines(40, T0));
  s.query(ALL);
  s.ingest('b', '/b.log', tsLines(40, T0 - 100_000));
  s.ingest('a', '/a.log', tsLines(5, T0 + 50_000));
  const inc = s.tick()!;
  const incIds = s.page(0, inc.total).map((h) => h.id);
  const full = s.query(ALL);
  assert.equal(inc.total, 60);
  assert.deepEqual(s.indexRows(), { a: 30, b: 30 });
  assert.deepEqual(incIds, s.page(0, full.total).map((h) => h.id));
});

test('row counts stay correct after dropFile / dropIndex', () => {
  const s = new LogStore({ maxRows: 1e9, maxBytes: 1e9 });
  s.ingest('a', '/a1.log', tsLines(10, T0));
  s.ingest('a', '/a2.log', tsLines(7, T0));
  s.ingest('b', '/b.log', tsLines(4, T0));
  s.dropFile('a', '/a1.log');
  assert.deepEqual(s.indexRows(), { a: 7, b: 4 });
  s.dropIndex('a');
  assert.deepEqual(s.indexRows(), { b: 4 });
});

test('rows without timestamps are aged by arrival', () => {
  const s = new LogStore({ maxRows: 3, maxBytes: 1e9 });
  s.ingest('x', '/x.log', ['plain one', 'plain two', 'plain three', 'plain four']);
  const r = s.query({ q: '', indexes: [], range: { kind: 'all' } });
  assert.equal(r.total, 3);
  assert.equal(s.query({ q: '"plain one"', indexes: [], range: { kind: 'all' } }).total, 0);
});

test('dropFile / dropIndex force a full re-query', () => {
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  s.ingest('x', '/a.log', [line(1), line(2)]);
  s.ingest('x', '/b.log', [line(3)]);
  s.query({ q: '', indexes: [], range: { kind: 'all' } });
  s.dropFile('x', '/a.log');
  const r = s.tick()!;
  assert.equal(r.reset, true);
  assert.equal(r.total, 1);
  s.dropIndex('x');
  assert.equal(s.tick()!.total, 0);
  assert.equal(s.memoryBytes, 0);
});

test('relative range slides without new data', () => {
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  const now = 1_800_000_000_000;
  s.ingest('x', '/x.log', [JSON.stringify({ ts: now - 50_000, msg: 'old' }), JSON.stringify({ ts: now - 5_000, msg: 'new' })]);
  assert.equal(s.query({ q: '', indexes: [], range: { kind: 'relative', ms: 60_000 } }, now).total, 2);
  assert.equal(s.tick(now + 20_000)!.total, 1);
});

test('performance: 200k rows', () => {
  const s = new LogStore({ maxRows: 200_000, maxBytes: 4e9 });
  const lines = Array.from({ length: 200_000 }, (_, i) => line(i, { txn_id: 't' + i, latency: i % 1000 }));
  let t = Date.now();
  s.ingest('p', '/p.log', lines);
  const ingestMs = Date.now() - t;
  t = Date.now();
  const r = s.query({ q: 'level:ERROR and latency > 500', indexes: [], range: { kind: 'all' } });
  const queryMs = Date.now() - t;
  s.ingest('p', '/p.log', Array.from({ length: 500 }, (_, i) => line(200_000 + i, { latency: 999 })));
  t = Date.now();
  const inc = s.tick()!;
  const tickMs = Date.now() - t;
  console.log(`    ingest 200k: ${ingestMs} ms · full query: ${queryMs} ms (${r.total} hits) · incremental tick (+500): ${tickMs} ms`);
  assert.ok(inc.total > r.total);
  assert.ok(tickMs < queryMs + 50);
});
