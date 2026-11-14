import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogStore } from '../src/engine/store';
import { Filter, HighlightTerm } from '../src/engine/types';

const T0 = Date.parse('2026-11-13T10:00:00Z');
function store() {
  const s = new LogStore({ maxRows: 10_000, maxBytes: 1e9 });
  const lines = [];
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({
      ts: T0 + i * 60_000, level: i % 10 === 0 ? 'ERROR' : i % 3 === 0 ? 'WARN' : 'INFO', message: `request ${i}`,
      svc: ['payments', 'pay-gateway', 'auth', 'search'][i % 4], code: i % 2 ? 200 : 500,
    }));
  }
  s.ingest('app', '/app.log', lines);
  s.ingest('other', '/other.log', [JSON.stringify({ ts: T0, level: 'FATAL', message: 'other', svc: 'billing' })]);
  return s;
}
const all = { kind: 'all' as const };

// ---------- value suggestions ----------

test('suggest: values by frequency', () => {
  const r = store().suggest({ field: 'level', prefix: '', indexes: ['app'], range: all });
  assert.deepEqual(r.values.map((v) => v.v), ['INFO', 'WARN', 'ERROR']);
  assert.equal(r.values[0].c, 60);
  assert.equal(r.time, false);
});

test('suggest: prefix matches rank before substring matches, case-insensitive', () => {
  const r = store().suggest({ field: 'svc', prefix: 'PAY', indexes: [], range: all });
  assert.deepEqual(r.values.map((v) => v.v).sort(), ['pay-gateway', 'payments']);
  const r2 = store().suggest({ field: 'svc', prefix: 'a', indexes: [], range: all });
  assert.equal(r2.values[0].v, 'auth', 'starts with "a" ranks first');
  assert.ok(r2.values.some((v) => v.v === 'payments'), 'contains "a" still listed');
});

test('suggest: respects index selection and time range', () => {
  const s = store();
  assert.ok(s.suggest({ field: 'level', prefix: '', indexes: [], range: all }).values.some((v) => v.v === 'FATAL'));
  assert.ok(!s.suggest({ field: 'level', prefix: '', indexes: ['app'], range: all }).values.some((v) => v.v === 'FATAL'));
  const r = s.suggest({ field: 'message', prefix: '', indexes: ['app'], range: { kind: 'absolute', from: T0, to: T0 + 2 * 60_000 } });
  assert.deepEqual(r.values.map((v) => v.v).sort(), ['request 0', 'request 1', 'request 2']);
});

test('suggest: numbers, virtual fields, unknown field', () => {
  const s = store();
  assert.deepEqual(s.suggest({ field: 'code', prefix: '', indexes: [], range: all }).values.map((v) => v.v).sort(), ['200', '500']);
  assert.deepEqual(s.suggest({ field: '_index', prefix: '', indexes: [], range: all }).values.map((v) => v.v), ['app', 'other']);
  assert.deepEqual(s.suggest({ field: 'nope', prefix: '', indexes: [], range: all }).values, []);
});

test('suggest: time fields give minutes in query format, newest first', () => {
  const r = store().suggest({ field: '@timestamp', prefix: '', indexes: ['app'], range: all });
  assert.equal(r.time, true);
  assert.equal(r.values.length, 10);
  assert.match(r.values[0].v, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  assert.ok(r.values[0].v > r.values[1].v);
  // the suggested format is accepted back by the query language
  const s = store();
  assert.equal(s.query({ q: `@timestamp >= ${r.values[0].v}`, indexes: ['app'], range: all }).total, 1);
});

// ---------- highlight terms ----------

const hl = (q: string, filters: Filter[] = []): HighlightTerm[] => store().query({ q, indexes: [], range: all, filters }).highlight;

test('highlight: field terms, free text, phrases, wildcards', () => {
  assert.deepEqual(hl('level:ERROR'), [{ field: 'level', value: 'ERROR', mode: 'word' }]);
  assert.deepEqual(hl('timeout'), [{ field: null, value: 'timeout', mode: 'phrase' }]);
  assert.deepEqual(hl('message:"request 1"'), [{ field: 'message', value: 'request 1', mode: 'phrase' }]);
  assert.deepEqual(hl('svc:pay*'), [{ field: 'svc', value: 'pay*', mode: 'wildcard' }]);
  assert.deepEqual(hl('req*'), [{ field: null, value: 'req*', mode: 'wildcard' }]);
});

test('highlight: value groups, negation, exists, comparisons', () => {
  assert.deepEqual(hl('level:(ERROR or not INFO or WARN)').map((t) => t.value), ['ERROR', 'WARN']);
  assert.deepEqual(hl('level:ERROR and not svc:auth'), [{ field: 'level', value: 'ERROR', mode: 'word' }]);
  assert.deepEqual(hl('not (svc:auth or svc:search) and request'), [{ field: null, value: 'request', mode: 'phrase' }]);
  assert.deepEqual(hl('not not svc:auth'), [{ field: 'svc', value: 'auth', mode: 'word' }]);
  assert.deepEqual(hl('svc:* and code > 200'), []);
  assert.deepEqual(hl('level:ERROR or level:error'), [{ field: 'level', value: 'ERROR', mode: 'word' }], 'deduplicated');
});

test('highlight: enabled, non-negated filters', () => {
  const f = (x: Partial<Filter>): Filter => ({ field: 'svc', op: 'is', negate: false, disabled: false, ...x });
  assert.deepEqual(hl('', [f({ value: 'auth' })]), [{ field: 'svc', value: 'auth', mode: 'exact' }]);
  assert.deepEqual(hl('', [f({ value: 'auth', negate: true }), f({ value: 'search', disabled: true })]), []);
  assert.deepEqual(hl('', [f({ op: 'is_one_of', values: ['auth', 'search'] })]).map((t) => t.value), ['auth', 'search']);
  assert.deepEqual(hl('', [f({ field: '', op: 'query', query: 'level:WARN' })]), [{ field: 'level', value: 'WARN', mode: 'word' }]);
});

test('highlight survives incremental ticks and is empty on errors', () => {
  const s = store();
  s.query({ q: 'level:ERROR', indexes: [], range: all });
  s.ingest('app', '/app.log', [JSON.stringify({ ts: T0 + 1e9, level: 'ERROR', message: 'late' })]);
  assert.deepEqual(s.tick()!.highlight.map((t) => t.value), ['ERROR']);
  assert.deepEqual(s.query({ q: 'level:(', indexes: [], range: all }).highlight, []);
});

test('field names are known regardless of hits, per index selection', () => {
  const s = store();
  const r = s.query({ q: 'nothing-matches-this', indexes: ['app'], range: all });
  assert.equal(r.total, 0);
  assert.deepEqual(r.fieldNames, ['code', 'level', 'message', 'svc', 'ts']);
  assert.ok(s.query({ q: '', indexes: [], range: all }).fieldNames?.includes('svc'));
  s.dropIndex('app');
  assert.deepEqual(s.query({ q: '', indexes: ['app'], range: all }).fieldNames, []);
});

test('ticks send field names and detected fields only when they changed', () => {
  const s = store();
  const q = s.query({ q: '', indexes: [], range: all });
  assert.ok(q.fieldNames && q.detected);
  const row = (extra: object) => JSON.stringify({ ts: T0 + 1e9, level: 'INFO', message: 'm', ...extra });
  s.ingest('app', '/app.log', [row({ svc: 'x' })]);
  const t1 = s.tick()!;
  assert.equal(t1.reset, false);
  assert.equal(t1.fieldNames, undefined);
  assert.equal(t1.detected, undefined);
  s.ingest('app', '/app.log', [row({ brandNew: 1 })]);
  assert.ok(s.tick()!.fieldNames?.includes('brandNew'));
  s.ingest('app', '/app.log', [row({ svc: 'y' })]);
  assert.equal(s.tick()!.fieldNames, undefined);
  s.ingest('fresh', '/fresh.log', [row({})]);
  assert.ok(s.tick()!.detected?.fresh);
});
