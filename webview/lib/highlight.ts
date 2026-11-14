/** Search-term highlighting (pure; unit-tested). */
import { esc } from './format';

/** as sent by the engine (src/engine/types.ts HighlightTerm) */
export interface Term { field: string | null; value: string; mode: 'word' | 'phrase' | 'wildcard' | 'exact' }
type Range = [number, number];
/** `find` appends the [start, end) ranges it matches in a value. `anchored` rules must match a whole value. */
export interface Rule { field: string | null; anchored: boolean; find: (s: string, out: Range[]) => void }

export const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** at most this many marks per value */
const MAX_MARKS = 500;

function regexFinder(re: RegExp): Rule['find'] {
  return (s, out) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) && out.length < MAX_MARKS) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push([m.index, m.index + m[0].length]);
    }
  };
}

/** whole-value `*` match, case-insensitive; same algorithm as the engine's wildcardMatcher */
function globWhole(pattern: string): Rule['find'] {
  const parts = pattern.toLowerCase().split('*');
  const first = parts[0], last = parts[parts.length - 1];
  const mid = parts.slice(1, -1).filter(Boolean);
  return (s, out) => {
    const v = s.toLowerCase();
    if (parts.length === 1) { if (v === first && s.length) out.push([0, s.length]); return; }
    if (v.length < first.length + last.length || !v.startsWith(first) || !v.endsWith(last)) return;
    const end = v.length - last.length;
    let at = first.length;
    for (const p of mid) {
      const i = v.indexOf(p, at);
      if (i < 0 || i + p.length > end) return;
      at = i + p.length;
    }
    if (s.length) out.push([0, s.length]);
  };
}

/**
 * Free-text `*` wildcard: like the regex /a\S*b/gi (stars stay inside one whitespace-free run,
 * greedy), but each run is searched piece by piece, so the cost is linear instead of exponential
 * in the number of stars.
 */
function globInRuns(pattern: string): Rule['find'] {
  const parts = pattern.split('*');
  const lead = parts[0] === '', trail = parts[parts.length - 1] === '';
  const pieces = parts.filter(Boolean).map((p) => new RegExp(reEsc(p), 'gi'));
  if (!pieces.length) return () => {};
  const lastRe = pieces[pieces.length - 1];
  const find = (re: RegExp, run: string, from: number) => { re.lastIndex = from; return re.exec(run); };
  return (s, out) => {
    const runs = /\S+/g;
    let r: RegExpExecArray | null;
    while ((r = runs.exec(s)) && out.length < MAX_MARKS) {
      const run = r[0], base = r.index;
      let at = 0;
      while (at < run.length && out.length < MAX_MARKS) {
        let start = -1, pos = at, lastAt = -1;
        for (const re of pieces) {
          const m = find(re, run, pos);
          if (!m) { start = -1; break; }
          if (start < 0) start = m.index;
          lastAt = m.index;
          pos = m.index + m[0].length;
        }
        if (start < 0) break;
        if (lead) start = at;
        let end = pos;
        if (trail) end = run.length;
        else {
          // greedy: the match runs to the last occurrence of the last piece in this run
          for (let m = find(lastRe, run, lastAt + 1); m; m = find(lastRe, run, m.index + 1)) end = m.index + m[0].length;
        }
        if (end <= start) break;
        out.push([base + start, base + end]);
        at = end;
      }
    }
  };
}

/** engine terms → match rules */
export function compileHl(terms: Term[] | null | undefined): Rule[] {
  const out: Rule[] = [];
  for (const t of terms || []) {
    const field = t.field;
    if (t.mode === 'wildcard') {
      out.push(field ? { field, anchored: true, find: globWhole(t.value) } : { field, anchored: false, find: globInRuns(t.value) });
      continue;
    }
    let src: string, anchored = false;
    if (t.mode === 'word') src = `(?<![\\w])${reEsc(t.value)}(?![\\w])`;
    else if (t.mode === 'phrase') src = reEsc(t.value);
    else { src = `^${reEsc(t.value)}$`; anchored = true; }
    try { out.push({ field, anchored, find: regexFinder(new RegExp(src, 'gi')) }); } catch { /* skip */ }
  }
  return out;
}

/**
 * Escape `text` and wrap search-term matches in <mark>. Rules for other fields are skipped;
 * with field === null (raw JSON) every unanchored rule applies.
 */
export function highlight(rules: Rule[], text: unknown, field: string | null): string {
  const str = String(text);
  if (!rules.length || !str) return esc(str);
  const ranges: Range[] = [];
  for (const r of rules) {
    if (field === null ? r.anchored : r.field !== null && r.field !== field) continue;
    if (ranges.length >= MAX_MARKS) break;
    r.find(str, ranges);
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
