import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, own, parseLine } from '../src/engine/parse';
import { wildcardMatcher } from '../src/engine/query';
import { LogStore } from '../src/engine/store';
import { QueryRequest } from '../src/engine/types';

const all = (q: string): QueryRequest => ({ q, indexes: [], range: { kind: 'all' } });
const store = () => new LogStore({ maxRows: 100_000, maxBytes: 1e9 });

test('__proto__ keys are stored as fields and never touch Object.prototype', () => {
  const s = store();
  s.ingest('i', '/a.log', [
    '{"__proto__": {"polluted": "yes"}, "msg": "nested"}',
    '{"__proto__": "top", "msg": "string"}',
    '{"constructor": {"prototype": {"polluted": "yes"}}, "msg": "ctor"}',
  ]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);

  const flat = flatten(JSON.parse('{"__proto__": "top"}'));
  assert.equal(Object.getPrototypeOf(flat), Object.prototype);
  assert.equal(own(flat, '__proto__'), 'top');
  assert.deepEqual(Object.keys(flat), ['__proto__']);

  assert.equal(s.query(all('__proto__:top')).total, 1);
  assert.equal(s.query(all('__proto__.polluted:yes')).total, 1);
  assert.equal(s.query(all('constructor.prototype.polluted:yes')).total, 1);
});

test('inherited Object members are not fields', () => {
  const s = store();
  s.ingest('i', '/a.log', ['{"msg": "a"}', 'plain text line']);
  for (const f of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.equal(s.query(all(`${f}:*`)).total, 0, f);
    assert.equal(s.query(all(`not ${f}:*`)).total, 2, f);
    assert.equal(s.query({ ...all(''), filters: [{ field: f, op: 'exists', negate: false, disabled: false }] }).total, 0, f);
  }
  const sorted = s.query({ ...all(''), sort: [{ field: 'constructor', dir: 'asc' }] });
  assert.equal(sorted.total, 2);
  assert.deepEqual(s.suggest({ field: 'toString', prefix: '', indexes: [], range: { kind: 'all' } }).values, []);
});

test('pathological JSON never aborts the rest of the batch', () => {
  const s = store();
  const deep = '{"a":' + '['.repeat(200_000) + ']'.repeat(200_000) + '}';
  const deepObj = '{"a":' + '{"b":'.repeat(5_000) + '1' + '}'.repeat(5_000) + '}';
  const manyKeys = '{' + Array.from({ length: 20_000 }, (_, i) => `"k${i}":${i}`).join(',') + '}';
  s.ingest('i', '/a.log', [
    deep,
    deepObj,
    manyKeys,
    '{"msg": "\\ud800 lone surrogate", "\\u0000key": 1}',
    '{"msg": "not closed"',
    '{}',
    'x'.repeat(5_000_000),
    '{"msg": "after"}',
  ]);
  assert.equal(s.size, 8);
  assert.equal(s.query(all('msg:after')).total, 1);
  assert.equal(s.query(all('"lone surrogate"')).total, 1);
  // field-name autocomplete stays capped even when one line has 20k keys
  assert.ok(s.fieldNames().length <= 2_000 + 10);
});

test('parseLine rejects non-object JSON', () => {
  for (const l of ['[1,2]', '"x"', '1', 'null', 'prefix | [1]', '{', '}']) assert.equal(parseLine(l), null, l);
});

test('hostile queries return an error instead of throwing', () => {
  const s = store();
  s.ingest('i', '/a.log', ['{"msg": "a"}']);
  const cases = [
    '('.repeat(10_000) + 'a' + ')'.repeat(10_000),
    'not '.repeat(10_000) + 'a',
    'a:('.repeat(500),
    'x'.repeat(20_000),
    '"unclosed',
    'msg:"\\',
  ];
  for (const q of cases) {
    const r = s.query(all(q));
    assert.ok(r.error, `expected an error for ${q.slice(0, 30)}…`);
  }
  // wildcard runs are collapsed and still match
  assert.equal(s.query(all('msg:a**********')).total, 1);
});

test('wildcards run in linear time: no regex backtracking on long non-matching lines', () => {
  const s = store();
  const long = 'a'.repeat(3000);
  s.ingest('i', '/a.log', [JSON.stringify({ msg: long }), '{"msg": "axbxc"}']);
  const t0 = Date.now();
  assert.equal(s.query(all('a*a*a*a*a*a*a*a*a*a*a*a*b')).total, 0);
  assert.equal(s.query(all('msg:a*a*a*a*a*a*a*a*a*a*a*a*b')).total, 0);
  assert.equal(s.query(all('msg:(a*a*a*a*a*a*a*a*a*a*b or z*)')).total, 0);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(s.query(all('msg:a*b*c')).total, 1);
  assert.equal(s.query(all('a*x*c')).total, 1);
});

test('free-text wildcards match within one field value, not across fields', () => {
  const s = store();
  s.ingest('i', '/a.log', [
    JSON.stringify({ level: 'error', msg: 'disk full' }),
    JSON.stringify({ level: 'info', msg: 'request timeout' }),
  ]);
  assert.equal(s.query(all('err*full')).total, 0, 'pieces in different fields');
  assert.equal(s.query(all('info*timeout')).total, 0, 'pieces in different fields');
  assert.equal(s.query(all('dis*ful')).total, 1);
  assert.equal(s.query(all('req*time*')).total, 1);
  assert.equal(s.query(all('*out')).total, 1);
  // a later line can still match after an earlier one fails partway
  assert.equal(wildcardMatcher('a*b', false)('a\nxa\nab\n'), true);
  assert.equal(wildcardMatcher('a*b*c', false)('ab\nbc\nabc'), true);
  assert.equal(wildcardMatcher('a*b*c', false)('ab\nbc\nac'), false);
  // still linear on many long lines that each fail on the last piece
  const many = Array.from({ length: 200 }, () => 'a'.repeat(5000)).join('\n');
  const t0 = Date.now();
  assert.equal(wildcardMatcher('a*a*a*a*a*a*a*a*b', false)(many), false);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

test('wildcardMatcher agrees with the equivalent regex', () => {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rnd = (n: number, a: string) => Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join('');
  for (let i = 0; i < 3000; i++) {
    const pat = rnd(1 + Math.floor(Math.random() * 6), 'ab*');
    if (!pat.includes('*')) continue;
    const text = rnd(Math.floor(Math.random() * 10), 'ab\n');
    for (const anchored of [true, false]) {
      // a field value's `*` spans line breaks; free text stays within one line (one field value)
      const body = pat.split('*').map(esc).join(anchored ? '[\\s\\S]*' : '[^\\n]*');
      const want = new RegExp(anchored ? `^${body}$` : body).test(text);
      assert.equal(wildcardMatcher(pat, anchored)(text), want, `${pat} ${anchored} ${text}`);
    }
  }
  assert.equal(wildcardMatcher('ABC*', true)('abcdef'), true, 'pattern is lowercased');
  assert.equal(wildcardMatcher('a*a', true)('a'), false, 'prefix and suffix may not overlap');
});
