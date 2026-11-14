/**
 * KQL-style query language (subset):
 *   level:ERROR                 field equals (case-insensitive) or contains the word
 *   msg:"gateway timeout"       field contains phrase
 *   txn_id:abc*                 wildcard
 *   merchant_id:*               field exists
 *   level:(ERROR or WARN)       value group
 *   latency > 500, ts >= 2026-11-13T10:00
 *   timeout                     free text over the whole line
 *   "connection reset"          free-text phrase
 *   a and b, a or b, not a, (a or b) and c, implicit AND between terms
 */
import { Filter, HighlightTerm, Primitive, Row } from './types';
import { parseTimestamp } from './parse';

type Tok =
  | { t: 'word'; v: string }
  | { t: 'str'; v: string }
  | { t: 'op'; v: '>' | '<' | '>=' | '<=' }
  | { t: '(' }
  | { t: ')' };

export type Pred = (r: Row) => boolean;

export class QueryError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { out.push({ t: c }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; }
        v += src[j++];
      }
      if (j >= src.length) throw new QueryError('Unclosed quote');
      out.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    if (c === '>' || c === '<') {
      if (src[i + 1] === '=') { out.push({ t: 'op', v: (c + '=') as '>=' | '<=' }); i += 2; }
      else { out.push({ t: 'op', v: c }); i++; }
      continue;
    }
    let j = i, v = '';
    while (j < src.length && !/[\s()"'<>]/.test(src[j])) v += src[j++];
    // a word ending with ':' may be followed directly by a quoted string or '(' — keep as is
    out.push({ t: 'word', v });
    i = j;
  }
  return out;
}

const FIELD_RE = /^[A-Za-z_@][\w.@-]*$/;

function escapeRe(s: string) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }
function wildcardRe(v: string, anchored: boolean): RegExp {
  const body = v.split('*').map(escapeRe).join('.*');
  return new RegExp(anchored ? `^${body}$` : body, 'i');
}

export interface QueryContext { tsFieldOf: (index: string) => string | null }

export function getField(r: Row, f: string, ctx: QueryContext): Primitive | undefined {
  if (f === '_index') return r.index;
  if (f === '_file') return r.file;
  if (f === '@timestamp' && !(f in r.flat)) {
    const tf = ctx.tsFieldOf(r.index);
    return tf ? r.flat[tf] : undefined;
  }
  return r.flat[f];
}

function valueMatcher(raw: string, quoted: boolean): (v: Primitive | undefined) => boolean {
  if (!quoted && raw === '*') return (v) => v !== undefined && v !== null && v !== '';
  const lower = raw.toLowerCase();
  if (!quoted && raw.includes('*')) {
    const re = wildcardRe(raw, true);
    return (v) => v !== undefined && v !== null && re.test(String(v));
  }
  if (quoted) return (v) => v !== undefined && v !== null && String(v).toLowerCase().includes(lower);
  const num = Number(raw);
  const isNum = raw.trim() !== '' && !isNaN(num);
  const wordRe = new RegExp(`(^|[^\\w])${escapeRe(lower)}($|[^\\w])`);
  return (v) => {
    if (v === undefined || v === null) return raw.toLowerCase() === 'null' && v === null;
    if (typeof v === 'number') return isNum && v === num;
    const s = String(v).toLowerCase();
    return s === lower || wordRe.test(s);
  };
}

function compare(op: string, field: string, rawVal: string, ctx: QueryContext): Pred {
  const num = Number(rawVal);
  // A value like "500" would parse as epoch seconds, so only treat it as a time when it looks like a date.
  const tsVal = /^\d{4}-\d\d-\d\d/.test(rawVal) || /^\d{12,}$/.test(rawVal) ? parseTimestamp(rawVal) : null;
  const cmp = (a: number, b: number) =>
    op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
  return (r) => {
    if (tsVal !== null && (field === '@timestamp' || field === ctx.tsFieldOf(r.index))) return r.ts !== null && cmp(r.ts, tsVal);
    const v = getField(r, field, ctx);
    if (v === undefined || v === null) return false;
    if (!isNaN(num) && rawVal.trim() !== '') {
      const n = typeof v === 'number' ? v : Number(v);
      return !isNaN(n) && cmp(n, num);
    }
    const s = String(v);
    return cmp(s < rawVal ? -1 : s > rawVal ? 1 : 0, 0);
  };
}

/**
 * @param collect when given, receives the terms a matching row is expected to contain
 *   (for highlighting). Terms under an odd number of `not`s are left out.
 */
export function compileQuery(src: string, ctx: QueryContext, collect?: HighlightTerm[]): Pred {
  const toks = tokenize(src);
  let p = 0;
  let neg = 0;
  const hl = (field: string | null, value: string, mode: HighlightTerm['mode']) => {
    if (collect && neg % 2 === 0 && value !== '' && field !== '@timestamp') collect.push({ field, value, mode });
  };
  const peek = () => toks[p];
  const isKw = (tk: Tok | undefined, kw: string) => !!tk && tk.t === 'word' && tk.v.toLowerCase() === kw;

  function parseOr(): Pred {
    const parts = [parseAnd()];
    while (isKw(peek(), 'or')) { p++; parts.push(parseAnd()); }
    return parts.length === 1 ? parts[0] : (r) => parts.some((f) => f(r));
  }
  function parseAnd(): Pred {
    const parts = [parseNot()];
    for (;;) {
      const tk = peek();
      if (!tk || tk.t === ')' || isKw(tk, 'or')) break;
      if (isKw(tk, 'and')) { p++; }
      parts.push(parseNot());
    }
    return parts.length === 1 ? parts[0] : (r) => parts.every((f) => f(r));
  }
  function parseNot(): Pred {
    if (isKw(peek(), 'not')) { p++; neg++; const inner = parseNot(); neg--; return (r) => !inner(r); }
    return parsePrimary();
  }
  function parseValueGroup(field: string): Pred {
    // after "field:(" — values separated by or/and
    const ms: { m: (v: Primitive | undefined) => boolean; neg: boolean }[] = [];
    let mode: 'or' | 'and' = 'or';
    while (peek() && peek().t !== ')') {
      const tk = toks[p++];
      if (tk.t === 'word' && (tk.v.toLowerCase() === 'or' || tk.v.toLowerCase() === 'and')) { mode = tk.v.toLowerCase() as 'or' | 'and'; continue; }
      if (tk.t === 'word' && tk.v.toLowerCase() === 'not') {
        const nx = toks[p++];
        if (!nx || (nx.t !== 'word' && nx.t !== 'str')) throw new QueryError('Expected value after not');
        ms.push({ m: valueMatcher(nx.v, nx.t === 'str'), neg: true });
        continue;
      }
      if (tk.t !== 'word' && tk.t !== 'str') throw new QueryError(`Unexpected token in value group for ${field}`);
      ms.push({ m: valueMatcher(tk.v, tk.t === 'str'), neg: false });
      hlValue(field, tk.v, tk.t === 'str');
    }
    if (!peek()) throw new QueryError('Missing )');
    p++;
    return (r) => {
      const v = getField(r, field, ctx);
      const res = ms.map((x) => (x.neg ? !x.m(v) : x.m(v)));
      return mode === 'and' ? res.every(Boolean) : res.some(Boolean);
    };
  }
  function hlValue(field: string, val: string, quoted: boolean) {
    if (!quoted && val === '*') return;
    hl(field, val, quoted ? 'phrase' : val.includes('*') ? 'wildcard' : 'word');
  }
  function fieldPred(field: string, val: string, quoted: boolean): Pred {
    hlValue(field, val, quoted);
    const m = valueMatcher(val, quoted);
    return (r) => m(getField(r, field, ctx));
  }
  function parsePrimary(): Pred {
    const tk = toks[p++];
    if (!tk) throw new QueryError('Unexpected end of query');
    if (tk.t === '(') {
      const inner = parseOr();
      if (!peek() || peek().t !== ')') throw new QueryError('Missing )');
      p++;
      return inner;
    }
    if (tk.t === ')') throw new QueryError('Unexpected )');
    if (tk.t === 'op') throw new QueryError(`Unexpected ${tk.v}`);
    if (tk.t === 'str') {
      const lower = tk.v.toLowerCase();
      hl(null, tk.v, 'phrase');
      return (r) => r.lower.includes(lower);
    }
    // word
    const w = tk.v;
    // comparison: field > value
    const nx = peek();
    if (nx && nx.t === 'op' && FIELD_RE.test(w)) {
      p++;
      const vt = toks[p++];
      if (!vt || (vt.t !== 'word' && vt.t !== 'str')) throw new QueryError(`Expected value after ${w} ${nx.v}`);
      return compare(nx.v, w, vt.v, ctx);
    }
    const ci = w.indexOf(':');
    if (ci > 0) {
      const field = w.slice(0, ci);
      if (FIELD_RE.test(field)) {
        const rest = w.slice(ci + 1);
        if (rest === '') {
          const n2 = peek();
          if (n2 && n2.t === 'str') { p++; return fieldPred(field, n2.v, true); }
          if (n2 && n2.t === '(') { p++; return parseValueGroup(field); }
          if (n2 && n2.t === 'op') {
            p++;
            const vt = toks[p++];
            if (!vt || (vt.t !== 'word' && vt.t !== 'str')) throw new QueryError(`Expected value after ${field}:${n2.v}`);
            return compare(n2.v, field, vt.v, ctx);
          }
          throw new QueryError(`Missing value for ${field}:`);
        }
        return fieldPred(field, rest, false);
      }
    }
    // free text word
    if (w.includes('*')) {
      const re = wildcardRe(w, false);
      if (w.replace(/\*/g, '')) hl(null, w, 'wildcard');
      return (r) => re.test(r.lower);
    }
    const lower = w.toLowerCase();
    hl(null, w, 'phrase');
    return (r) => r.lower.includes(lower);
  }

  if (toks.length === 0) return () => true;
  const pred = parseOr();
  if (p < toks.length) throw new QueryError(`Unexpected token near "${JSON.stringify(toks[p])}"`);
  return pred;
}

/** Exact value match (strings case-insensitive), as used by filter pills. */
function equalsMatcher(value: Primitive | undefined): (v: Primitive | undefined) => boolean {
  if (value === null) return (v) => v === null;
  const want = String(value).toLowerCase();
  return (v) => v !== undefined && v !== null && String(v).toLowerCase() === want;
}

function filterPred(f: Filter, ctx: QueryContext): Pred {
  if (f.op === 'query') {
    try {
      return compileQuery(f.query || '', ctx);
    } catch (e) {
      throw new QueryError(`Filter "${f.label || f.query}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const field = f.field;
  if (!field || !FIELD_RE.test(field)) throw new QueryError(`Filter has an invalid field name: "${field ?? ''}"`);
  switch (f.op) {
    case 'is': {
      const m = equalsMatcher(f.value);
      return (r) => m(getField(r, field, ctx));
    }
    case 'is_one_of': {
      const ms = (f.values ?? []).map(equalsMatcher);
      if (!ms.length) throw new QueryError(`Filter on ${field} needs at least one value`);
      return (r) => { const v = getField(r, field, ctx); return ms.some((m) => m(v)); };
    }
    case 'between': {
      const gte = (f.gte ?? '').trim(), lte = (f.lte ?? '').trim();
      if (!gte && !lte) throw new QueryError(`Filter on ${field} needs a start or an end value`);
      const lo = gte ? compare('>=', field, gte, ctx) : null;
      const hi = lte ? compare('<=', field, lte, ctx) : null;
      return (r) => (!lo || lo(r)) && (!hi || hi(r));
    }
    case 'exists': {
      const m = valueMatcher('*', false);
      return (r) => m(getField(r, field, ctx));
    }
    default:
      throw new QueryError(`Unknown filter operator: ${String((f as Filter).op)}`);
  }
}

/** Terms to highlight for the enabled, non-negated filters. */
export function filterHighlights(filters: Filter[] | undefined, ctx: QueryContext): HighlightTerm[] {
  const out: HighlightTerm[] = [];
  for (const f of filters ?? []) {
    if (!f || f.disabled || f.negate) continue;
    if (f.op === 'is' && f.value !== null && f.value !== undefined) out.push({ field: f.field, value: String(f.value), mode: 'exact' });
    else if (f.op === 'is_one_of') for (const v of f.values ?? []) { if (v !== null) out.push({ field: f.field, value: String(v), mode: 'exact' }); }
    else if (f.op === 'query') { try { compileQuery(f.query || '', ctx, out); } catch { /* reported by compileFilters */ } }
  }
  return out.filter((t) => t.field !== '@timestamp');
}

/** AND of every enabled filter; negated filters exclude their matches. */
export function compileFilters(filters: Filter[] | undefined, ctx: QueryContext): Pred | null {
  const preds: Pred[] = [];
  for (const f of filters ?? []) {
    if (!f || f.disabled) continue;
    const p = filterPred(f, ctx);
    preds.push(f.negate ? (r) => !p(r) : p);
  }
  if (!preds.length) return null;
  return preds.length === 1 ? preds[0] : (r) => preds.every((p) => p(r));
}
