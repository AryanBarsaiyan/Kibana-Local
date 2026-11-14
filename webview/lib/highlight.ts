/** Search-term highlighting (pure; unit-tested). */
import { esc } from './format';

/** as sent by the engine (src/engine/types.ts HighlightTerm) */
export interface Term { field: string | null; value: string; mode: 'word' | 'phrase' | 'wildcard' | 'exact' }
export interface Rule { field: string | null; re: RegExp; anchored: boolean }

export const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** engine terms → regexes. `anchored` rules must match a whole value. */
export function compileHl(terms: Term[] | null | undefined): Rule[] {
  const out: Rule[] = [];
  for (const t of terms || []) {
    let src: string, anchored = false;
    if (t.mode === 'word') src = `(?<![\\w])${reEsc(t.value)}(?![\\w])`;
    else if (t.mode === 'phrase') src = reEsc(t.value);
    else if (t.mode === 'exact') { src = `^${reEsc(t.value)}$`; anchored = true; }
    else {
      const body = t.value.split('*').map(reEsc).join(t.field ? '.*' : '\\S*');
      anchored = !!t.field;
      src = anchored ? `^${body}$` : body;
    }
    try { out.push({ field: t.field, re: new RegExp(src, 'gi'), anchored }); } catch { /* skip */ }
  }
  return out;
}

/** at most this many marks per value */
const MAX_MARKS = 500;

/**
 * Escape `text` and wrap search-term matches in <mark>. Rules for other fields are skipped;
 * with field === null (raw JSON) every unanchored rule applies.
 */
export function highlight(rules: Rule[], text: unknown, field: string | null): string {
  const str = String(text);
  if (!rules.length || !str) return esc(str);
  const ranges: [number, number][] = [];
  for (const r of rules) {
    if (field === null ? r.anchored : r.field !== null && r.field !== field) continue;
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(str)) && ranges.length < MAX_MARKS) {
      if (!m[0].length) { r.re.lastIndex++; continue; }
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (!ranges.length) return esc(str);
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '', at = 0;
  for (let i = 0; i < ranges.length; i++) {
    let [a, b] = ranges[i];
    while (i + 1 < ranges.length && ranges[i + 1][0] <= b) b = Math.max(b, ranges[++i][1]);
    if (a < at) a = at;
    if (b <= a) continue;
    out += esc(str.slice(at, a)) + '<mark class="hl">' + esc(str.slice(a, b)) + '</mark>';
    at = b;
  }
  return out + esc(str.slice(at));
}
