import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogStore } from '../src/engine/store';

const L = [
  { '@timestamp': '2026-11-13 17:20:01.123456 UTC', level: 'INFO', message: 'order created', txn_id: 'abc123', ctx: { merchant_id: 'm1', latency: 120 } },
  { '@timestamp': '2026-11-13 17:20:02.5 UTC', level: 'ERROR', message: 'gateway timeout after 30s', txn_id: 'abc123', ctx: { merchant_id: 'm1', latency: 30000 } },
  { '@timestamp': '2026-11-13T17:21:00Z', level: 'WARN', message: 'retrying', txn_id: 'xyz999', ctx: { merchant_id: 'm2', latency: 800 } },
  { '@timestamp': '2026-11-13T17:25:00Z', level: 'INFO', message: 'GET /health', path: '/health' },
].map((o) => JSON.stringify(o));

function store() {
  const s = new LogStore({ maxRows: 1000, maxBytes: 1e9 });
  s.ingest('frm', '/x/frm.log', [L[0], L[1], '    at Foo.bar (x.hs:10)', 'plain text line no json', L[2], L[3]]);
  return s;
}
const all = { kind: 'all' as const };

test('detects fields', () => {
  assert.deepEqual(store().detectedFor('frm'), { ts: '@timestamp', level: 'level', msg: 'message' });
});

const cases: [string, number][] = [
  ['level:ERROR', 1], ['level:error', 1], ['txn_id:abc*', 2], ['msg:"gateway timeout"', 0],
  ['message:"gateway timeout"', 1], ['message:timeout', 1], ['ctx.latency > 500', 2],
  ['ctx.latency>=120 and ctx.merchant_id:m1', 2], ['not path:/health', 4], ['level:(ERROR or WARN)', 2],
  ['timeout', 1], ['"order created"', 1], ['ctx.merchant_id:*', 3], ['@timestamp >= 2026-11-13T17:21:00Z', 2],
  ['(level:ERROR or level:WARN) and not txn_id:xyz999', 1], ['Foo.bar', 1], ['', 5],
  ['level:INFO or level:WARN', 3], ['lev*', 0], ['retry*', 1], ['m1', 2], ['level:(not INFO)', 3],
  ['ctx.latency < 500', 1], ['_index:frm', 5], ['_file:frm.log', 5],
];
for (const [q, n] of cases) {
  test(`query ${q || '(empty)'} → ${n}`, () => {
    const r = store().query({ q, indexes: [], range: all });
    assert.equal(r.error, undefined);
    assert.equal(r.total, n);
  });
}

for (const bad of ['level:(ERROR', '"open', 'level:', '(a', 'a)', '> 5']) {
  test(`syntax error: ${bad}`, () => {
    assert.ok(store().query({ q: bad, indexes: [], range: all }).error);
  });
}

test('numeric comparison on the timestamp field is not treated as epoch seconds', () => {
  const s = new LogStore({ maxRows: 100, maxBytes: 1e9 });
  s.ingest('a', '/a.log', [JSON.stringify({ ts: 600, level: 'INFO', message: 'x' })]);
  // "ts" holds a small number, not a date: must compare numerically
  assert.equal(s.query({ q: 'ts > 500', indexes: [], range: all }).total, 1);
});

test('results newest first, histogram and absolute range', () => {
  const s = store();
  const r = s.query({ q: '', indexes: [], range: all });
  assert.equal(r.hits[0].flat.message, 'GET /health');
  assert.ok(r.histogram && r.histogram.counts.length > 1);
  const from = Date.parse('2026-11-13T17:20:30Z'), to = Date.parse('2026-11-13T17:30:00Z');
  assert.equal(s.query({ q: '', indexes: [], range: { kind: 'absolute', from, to } }).total, 2);
});
