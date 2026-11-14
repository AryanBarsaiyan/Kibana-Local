import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { clampInt, cleanColumns, cleanFilters, cleanIndexes, cleanRange, cleanSort, cleanSources, cleanText, LIMITS } from '../src/sanitize';

test('cleanFilters drops malformed filters and coerces fields', () => {
  assert.deepEqual(cleanFilters(null), []);
  assert.deepEqual(cleanFilters('x'), []);
  assert.deepEqual(cleanFilters({ length: 1, 0: { op: 'is' } }), []);
  const out = cleanFilters([
    null, 1, 'is', [], { op: 'bogus', field: 'a' }, { op: '__proto__' }, { op: 'constructor' },
    { op: 'is', field: 'level', value: { evil: 1 }, negate: 'yes', disabled: 0, label: '  L  ' },
    { op: 'is', field: 'n', value: NaN },
    { op: 'is_one_of', field: 'x', values: [1, 'a', null, {}, [], Infinity, true] },
    { op: 'between', field: 't', gte: 5, lte: undefined },
    { op: 'query', query: { toString: 1 } },
    { op: 'query', query: 'level:ERROR', field: { toString: 1 } },
    { op: 'exists', field: 7 },
  ]);
  assert.deepEqual(out, [
    { field: 'level', op: 'is', value: '', negate: true, disabled: false, label: 'L' },
    { field: 'n', op: 'is', value: 'NaN', negate: false, disabled: false },
    { field: 'x', op: 'is_one_of', values: [1, 'a', null, true], negate: false, disabled: false },
    { field: 't', op: 'between', gte: '5', lte: '', negate: false, disabled: false },
    { field: '', op: 'query', query: '', negate: false, disabled: false },
    { field: '', op: 'query', query: 'level:ERROR', negate: false, disabled: false },
    { field: '7', op: 'exists', negate: false, disabled: false },
  ]);
});

test('cleanFilters caps sizes', () => {
  const many = Array.from({ length: 500 }, () => ({ op: 'exists', field: 'a' }));
  assert.equal(cleanFilters(many).length, LIMITS.filters);
  const [f] = cleanFilters([{ op: 'is_one_of', field: 'a', values: Array.from({ length: 1000 }, (_, i) => i) }]);
  assert.equal(f.values!.length, LIMITS.filterValues);
  const [g] = cleanFilters([{ op: 'query', query: 'x'.repeat(50_000), field: 'f'.repeat(5000) }]);
  assert.equal(g.query!.length, LIMITS.text);
  assert.equal(g.field.length, LIMITS.name);
});

test('cleanSort', () => {
  assert.deepEqual(cleanSort([{ field: 'a', dir: 'asc' }, { field: '', dir: 'asc' }, { field: 'b', dir: 'up' }, null, { field: 3, dir: 'desc' }]),
    [{ field: 'a', dir: 'asc' }]);
  assert.equal(cleanSort(Array.from({ length: 50 }, () => ({ field: 'a', dir: 'desc' }))).length, LIMITS.sortKeys);
});

test('cleanIndexes keeps known string names once', () => {
  assert.deepEqual(cleanIndexes(['a', 'b', 'a', 1, null, '', { name: 'a' }, 'zzz'], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(cleanIndexes('a'), []);
  assert.deepEqual(cleanIndexes(['x']), ['x']);
});

test('cleanRange', () => {
  assert.deepEqual(cleanRange(undefined), { kind: 'all' });
  assert.deepEqual(cleanRange({ kind: 'relative', ms: 60000 }), { kind: 'relative', ms: 60000 });
  for (const ms of ['60000', NaN, Infinity, -5, 0, null]) assert.deepEqual(cleanRange({ kind: 'relative', ms }), { kind: 'all' }, String(ms));
  assert.deepEqual(cleanRange({ kind: 'absolute', from: 10, to: 5 }), { kind: 'absolute', from: 5, to: 10 });
  assert.deepEqual(cleanRange({ kind: 'absolute', from: '1', to: 5 }), { kind: 'all' });
  assert.deepEqual(cleanRange({ kind: 'weird' }), { kind: 'all' });
  assert.deepEqual(cleanRange([1, 2]), { kind: 'all' });
});

test('cleanColumns, cleanText, clampInt', () => {
  assert.equal(cleanColumns('a'), null);
  assert.equal(cleanColumns([]), null);
  assert.equal(cleanColumns([1, null]), null);
  assert.deepEqual(cleanColumns(['a', 'a', 'b', 3]), ['a', 'b']);
  assert.equal(cleanText(5), '');
  assert.equal(cleanText('x'.repeat(LIMITS.text + 5)).length, LIMITS.text);
  assert.equal(clampInt('12', 0, 10), 10);
  assert.equal(clampInt(-3.7, 0, 10), 0);
  assert.equal(clampInt(4.9, 0, 10), 4);
  assert.equal(clampInt('abc', 0, 10, 7), 7);
  assert.equal(clampInt('', 0, 10, 7), 7);
  assert.equal(clampInt(NaN, 0, 10, 7), 7);
  assert.equal(clampInt({}, 0, 10, 7), 7);
});

test('cleanSources keeps only well-formed saved indexes', () => {
  const abs = path.resolve('logs', 'a.log');
  const dir = path.resolve('logs');
  assert.deepEqual(cleanSources(null), []);
  assert.deepEqual(cleanSources({ name: 'a', path: abs, kind: 'file' }), []);
  assert.deepEqual(cleanSources([
    null, 'x', [], { name: 'a', path: abs, kind: 'file', extra: 1 },
    { name: 'a', path: dir, kind: 'folder' }, // repeated name
    { name: '', path: abs, kind: 'file' }, { name: 'b', path: 'relative.log', kind: 'file' },
    { name: 'c', path: abs, kind: 'pipe' }, { name: 'd', path: { toString: 1 }, kind: 'file' },
    { name: 'e', path: abs + '\0x', kind: 'file' }, { name: 'f'.repeat(LIMITS.name + 1), path: abs, kind: 'file' },
    { name: 'h', path: 'x'.repeat(LIMITS.path + 1), kind: 'file' },
    { name: 'g', path: dir, kind: 'folder' },
  ]), [{ name: 'a', path: abs, kind: 'file' }, { name: 'g', path: dir, kind: 'folder' }]);
});
