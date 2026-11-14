/** Query-bar parsing for autocomplete (pure; unit-tested). Mirrors the engine tokenizer in src/engine/query.ts. */

export const KW = ['and', 'or', 'not'];
export const OPS: [string, string][] = [[':', 'equals / contains'], ['>', 'greater than'], ['<', 'less than'], ['>=', 'at least'], ['<=', 'at most']];
export const FIELD_OK = /^[A-Za-z_@][\w.@-]*$/;

export type Tok =
  | { t: '(' | ')'; s: number; e: number; v?: undefined }
  | { t: 'word' | 'str' | 'open' | 'op'; v: string; s: number; e: number };

/** Same token rules as the engine's query tokenizer, with positions; an unclosed quote becomes an "open" token. */
export function acTokens(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { out.push({ t: c, s: i, e: i + 1 }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; }
        v += src[j++];
      }
      if (j >= src.length) { out.push({ t: 'open', v, s: i, e: src.length }); break; }
      out.push({ t: 'str', v, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '>' || c === '<') {
      const two = src[i + 1] === '=';
      out.push({ t: 'op', v: two ? c + '=' : c, s: i, e: i + (two ? 2 : 1) });
      i += two ? 2 : 1;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s()"'<>]/.test(src[j])) j++;
    out.push({ t: 'word', v: src.slice(i, j), s: i, e: j });
    i = j;
  }
  return out;
}

export const isKwTok = (t: Tok | undefined) => !!t && t.t === 'word' && KW.includes(t.v.toLowerCase());

/** `field:` or `field:value` → field */
export function fieldOf(t: Tok | undefined): string | null {
  if (!t || t.t !== 'word') return null;
  const ci = t.v.indexOf(':');
  if (ci <= 0) return null;
  const f = t.v.slice(0, ci);
  return FIELD_OK.test(f) ? f : null;
}

export type AcContext =
  | { kind: 'none' }
  | { kind: 'start'; from: number; to: number }
  | { kind: 'field'; prefix: string; from: number; to: number; afterTerm?: boolean }
  | { kind: 'value'; field: string; prefix: string; from: number; to: number; inGroup?: boolean; cmp?: boolean }
  | { kind: 'op'; field: string; fieldEnd: number; from: number; to: number }
  | { kind: 'conj'; from: number; to: number; inGroup?: boolean };

/**
 * What is being typed at the cursor. `from`/`to` is the text a suggestion replaces.
 * @param known field names, used to offer operators after a bare known field
 */
export function acContext(text: string, pos: number, known: readonly string[]): AcContext {
  const toks = acTokens(text.slice(0, pos));
  const stack: (string | null)[] = [];
  toks.forEach((t, k) => {
    if (t.t === '(') {
      const pv = toks[k - 1];
      stack.push(pv && pv.t === 'word' && pv.v.endsWith(':') && pv.e === t.s ? fieldOf(pv) : null);
    } else if (t.t === ')') stack.pop();
  });
  const group = stack.length ? stack[stack.length - 1] : null;
  const n = toks.length, last = toks[n - 1], prev = toks[n - 2], prev2 = toks[n - 3];
  const cmpField = (opTok: Tok | undefined, fTok: Tok | undefined) =>
    opTok && opTok.t === 'op' && fTok && fTok.t === 'word' && FIELD_OK.test(fTok.v) ? fTok.v : null;
  if (!last) return { kind: 'start', from: 0, to: pos };
  if (last.t === 'open') {
    const f = prev && prev.t === 'word' && prev.v.endsWith(':') && prev.e === last.s ? fieldOf(prev) : group || cmpField(prev, prev2);
    return f ? { kind: 'value', field: f, prefix: last.v, from: last.s, to: pos, inGroup: !!group && !fieldOf(prev) } : { kind: 'none' };
  }
  if (last.t === 'word' && last.e === pos) {
    const f = fieldOf(last);
    if (f) return { kind: 'value', field: f, prefix: last.v.slice(f.length + 1), from: last.s + f.length + 1, to: pos };
    if (group && !isKwTok(last)) return { kind: 'value', field: group, prefix: last.v, from: last.s, to: pos, inGroup: true };
    const cf = cmpField(prev, prev2);
    if (cf) return { kind: 'value', field: cf, prefix: last.v, from: last.s, to: pos, cmp: true };
    return { kind: 'field', prefix: last.v, from: last.s, to: pos, afterTerm: !!prev && !isKwTok(prev) && prev.t !== '(' && prev.t !== 'op' };
  }
  if (last.t === 'op') {
    const cf = cmpField(last, prev);
    return cf ? { kind: 'value', field: cf, prefix: '', from: pos, to: pos, cmp: true } : { kind: 'none' };
  }
  const lf = fieldOf(last);
  if (last.t === 'word' && lf && last.v.endsWith(':')) return { kind: 'value', field: lf, prefix: '', from: pos, to: pos };
  if (last.t === '(') return group ? { kind: 'value', field: group, prefix: '', from: pos, to: pos, inGroup: true } : { kind: 'field', prefix: '', from: pos, to: pos };
  if (isKwTok(last)) return { kind: 'field', prefix: '', from: pos, to: pos };
  if (group) return { kind: 'conj', from: pos, to: pos, inGroup: true };
  if (last.t === 'word' && !last.v.includes(':') && known.includes(last.v) && !cmpField(prev, prev2)) {
    return { kind: 'op', field: last.v, fieldEnd: last.e, from: pos, to: pos };
  }
  return { kind: 'conj', from: pos, to: pos };
}

/** field names: prefix matches first, then substring matches */
export function matchNames(list: readonly string[], prefix: string, max: number): string[] {
  const p = prefix.toLowerCase();
  const a: string[] = [], b: string[] = [];
  for (const x of list) {
    const i = x.toLowerCase().indexOf(p);
    if (i === 0) a.push(x); else if (i > 0) b.push(x);
  }
  return a.sort().concat(b.sort()).slice(0, max);
}
