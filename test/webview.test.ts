/** Unit tests for the webview's pure modules (webview/lib). The DOM layer is covered by a manual smoke run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, fmtBytes, fmtVal, levelClass, own, quoteVal } from '../webview/lib/format';
import { compileHl, highlight } from '../webview/lib/highlight';
import { acContext, acTokens, matchNames } from '../webview/lib/kql';
import { addOrUpdateFilter, Filter, filterText, indexAt, nextSort, topOf } from '../webview/lib/grid';

test('esc escapes HTML and attribute metacharacters', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), 'null');
});

test('own ignores inherited members', () => {
  const flat = JSON.parse('{"__proto__": "p", "a": 1}');
  assert.equal(own(flat, '__proto__'), 'p');
  assert.equal(own(flat, 'constructor'), undefined);
  assert.equal(own(flat, 'toString'), undefined);
  assert.equal(own(null, 'a'), undefined);
  assert.equal(own(flat, null), undefined);
});

test('format helpers', () => {
  assert.equal(levelClass('ERROR'), 'lv-error');
  assert.equal(levelClass(50), 'lv-error');
  assert.equal(levelClass('warning'), 'lv-warn');
  assert.equal(levelClass(null), '');
  assert.equal(quoteVal('abc-1.2'), 'abc-1.2');
  assert.equal(quoteVal('and'), '"and"');
  assert.equal(quoteVal('a "b" \\c'), '"a \\"b\\" \\\\c"');
  assert.equal(fmtBytes(2 * 1024 * 1024), '2 MB');
  assert.equal(fmtVal(''), '(empty)');
  assert.equal(fmtVal(null), 'null');
});

test('highlight wraps matches and escapes everything else', () => {
  const rules = compileHl([
    { field: null, value: 'time', mode: 'phrase' },
    { field: 'level', value: 'ERROR', mode: 'exact' },
    { field: 'msg', value: 'gate*', mode: 'wildcard' },
  ]);
  assert.equal(highlight(rules, '<b>timeout</b>', 'msg'), '&lt;b&gt;<mark class="hl">time</mark>out&lt;/b&gt;');
  assert.equal(highlight(rules, 'error', 'level'), '<mark class="hl">error</mark>');
  assert.equal(highlight(rules, 'error', 'other'), 'error', 'field-scoped rule stays in its field');
  assert.equal(highlight(rules, 'gateway', 'msg'), '<mark class="hl">gateway</mark>');
  assert.equal(highlight([], '<x>', null), '&lt;x&gt;');
  // overlapping matches merge into one mark
  const ov = compileHl([{ field: null, value: 'abc', mode: 'phrase' }, { field: null, value: 'bcd', mode: 'phrase' }]);
  assert.equal(highlight(ov, 'abcde', null), '<mark class="hl">abcd</mark>e');
  // regex metacharacters in terms are literal
  assert.equal(highlight(compileHl([{ field: null, value: 'a.b(', mode: 'phrase' }]), 'axb( a.b(', null), 'axb( <mark class="hl">a.b(</mark>');
});

test('acTokens mirrors the engine tokenizer', () => {
  assert.deepEqual(acTokens('level:(a or "b c") and x >= 5').map((t) => t.t),
    ['word', '(', 'word', 'word', 'str', ')', 'word', 'word', 'op', 'word']);
  const open = acTokens('msg:"unfinished');
  assert.equal(open[1].t, 'open');
  assert.equal(open[1].v, 'unfinished');
});

test('acContext: what is being typed at the cursor', () => {
  const known = ['level', 'latency', 'msg'];
  const at = (s: string) => acContext(s, s.length, known);
  assert.equal(at('').kind, 'start');
  assert.deepEqual(at('lev'), { kind: 'field', prefix: 'lev', from: 0, to: 3, afterTerm: false });
  assert.deepEqual(at('level:ER'), { kind: 'value', field: 'level', prefix: 'ER', from: 6, to: 8 });
  assert.equal(at('level:(ERROR or W').kind, 'value');
  assert.equal((at('level:(ERROR or W') as { inGroup?: boolean }).inGroup, true);
  assert.equal(at('level:(ERROR ').kind, 'conj');
  assert.deepEqual(at('latency > '), { kind: 'value', field: 'latency', prefix: '', from: 10, to: 10, cmp: true });
  assert.equal(at('latency ').kind, 'op');
  assert.equal(at('unknownfield ').kind, 'conj');
  assert.equal(at('a and ').kind, 'field');
  assert.equal(at('msg:"half').kind, 'value');
});

test('matchNames: prefix matches before substring matches', () => {
  assert.deepEqual(matchNames(['xlevel', 'level', 'lev2', 'other'], 'lev', 10), ['lev2', 'level', 'xlevel']);
  assert.deepEqual(matchNames(['a', 'b'], '', 1), ['a']);
});

test('nextSort cycles like Kibana', () => {
  assert.deepEqual(nextSort([], '@timestamp', false), [{ field: '@timestamp', dir: 'asc' }]);
  assert.deepEqual(nextSort([{ field: '@timestamp', dir: 'asc' }], '@timestamp', false), [], 'back to the default');
  assert.deepEqual(nextSort([], 'msg', false), [{ field: 'msg', dir: 'asc' }]);
  assert.deepEqual(nextSort([{ field: 'msg', dir: 'asc' }], 'msg', false), [{ field: 'msg', dir: 'desc' }]);
  assert.deepEqual(nextSort([{ field: 'msg', dir: 'desc' }], 'msg', false), []);
  // shift-click adds keys, then cycles and removes them
  const two = nextSort([{ field: 'msg', dir: 'asc' }], 'level', true);
  assert.deepEqual(two, [{ field: 'msg', dir: 'asc' }, { field: 'level', dir: 'asc' }]);
  assert.deepEqual(nextSort(two, 'level', true), [{ field: 'msg', dir: 'asc' }, { field: 'level', dir: 'desc' }]);
  assert.deepEqual(nextSort(nextSort(two, 'level', true), 'level', true), [{ field: 'msg', dir: 'asc' }]);
  // input is not mutated
  const cur = [{ field: 'msg', dir: 'asc' as const }];
  nextSort(cur, 'msg', false);
  assert.equal(cur[0].dir, 'asc');
});

test('virtual list geometry with expanded rows', () => {
  const ex = [{ i: 2, extra: 100 }, { i: 5, extra: 50 }];
  assert.equal(topOf(0, ex, 24), 0);
  assert.equal(topOf(2, ex, 24), 48);
  assert.equal(topOf(3, ex, 24), 72 + 100);
  assert.equal(topOf(6, ex, 24), 144 + 150);
  for (let i = 0; i < 10; i++) {
    assert.equal(indexAt(topOf(i, ex, 24), ex, 24), i, `row ${i} top`);
    assert.equal(indexAt(topOf(i, ex, 24) + 23, ex, 24), i, `row ${i} bottom`);
  }
  assert.equal(indexAt(48 + 24 + 99, ex, 24), 2, 'inside the expanded doc of row 2');
  assert.equal(indexAt(-5, [], 24), 0);
});

test('filter pills: labels and add-or-update', () => {
  const fs: Filter[] = [];
  addOrUpdateFilter(fs, 'level', 'ERROR', false);
  addOrUpdateFilter(fs, 'level', 'ERROR', true);
  assert.equal(fs.length, 1, 're-adding the same value updates it');
  assert.equal(fs[0].negate, true);
  addOrUpdateFilter(fs, 'level', null, false);
  addOrUpdateFilter(fs, 'user', undefined, false);
  assert.deepEqual(fs.map(filterText), ['level: ERROR', 'level: null', 'user: exists']);
  assert.equal(filterText({ field: 'a', op: 'between', gte: '1', negate: false, disabled: false }), 'a ≥ 1');
  assert.equal(filterText({ field: '', op: 'query', query: '', negate: false, disabled: false, label: 'Mine' }), 'Mine');
});
