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
import { own, parseTimestamp } from './parse';

type Tok =
  | { t: 'word'; v: string }
  | { t: 'str'; v: string }
  | { t: 'op'; v: '>' | '<' | '>=' | '<=' }
  | { t: '(' }
  | { t: ')' };

export type Pred = (r: Row) => boolean;

export class QueryError extends Error {}

/** Deeper nesting than this is rejected instead of overflowing the parser's stack. */
export const MAX_QUERY_DEPTH = 64;
/** Longer queries are rejected; nothing legitimate comes close. */
export const MAX_QUERY_LENGTH = 10_000;

function tokenize(src: string): Tok[] {
  if (src.length > MAX_QUERY_LENGTH) throw new QueryError(`Query is too long (max ${MAX_QUERY_LENGTH.toLocaleString('en')} characters)`);
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

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/**
 * Matcher for a `*` wildcard pattern (case-insensitive: callers pass lowercased text). The pieces
 * between stars are found in order with indexOf, leftmost first, which is always enough for `*`
 * and costs one pass per piece. A regex like /a.*a.*a.*b/ backtracks with an exponent equal to the
 * number of stars on a long line that does not match, and a test that runs inside one regex call
 * cannot be cancelled.
 *
 * Unanchored (free text over `row.lower`, where field values are separated by '\n'): every piece
 * must sit on the same line, so `err*full` does not match `error` in one field and `disk full`
 * in another. Anchored (one field value): `*` also spans line breaks inside the value.
 */
export function wildcardMatcher(pattern: string, anchored: boolean): (s: string) => boolean {
  const parts = pattern.toLowerCase().split('*');
  if (!anchored) {
    const pieces = parts.filter(Boolean);
    return (s) => {
      let line = 0;
      for (;;) {
        let at = line, stop = -1, ok = true;
        for (const p of pieces) {
          const i = s.indexOf(p, at);
          if (i < 0) return false;
          if (stop < 0) {
            const e = s.indexOf('\n', i);
            stop = e < 0 ? s.length : e;
          } else if (i + p.length > stop) {
            // no match can finish on the first piece's line, nor on any line before the one this
            // piece was found on (it does not occur there): retry from that line
            line = Math.max(stop + 1, s.lastIndexOf('\n', i) + 1);
            ok = false;
            break;
          }
          at = i + p.length;
        }
        if (ok) return true;
      }
    };
  }
  // anchored: the first piece is a prefix, the last a suffix, the rest sit in between in order
  const first = parts[0], last = parts.length > 1 ? parts[parts.length - 1] : '';
  const mid = parts.slice(1, -1).filter(Boolean);
  if (parts.length === 1) return (s) => s === first;
  return (s) => {
    if (s.length < first.length + last.length || !s.startsWith(first) || !s.endsWith(last)) return false;
    const end = s.length - last.length;
    let at = first.length;
    for (const p of mid) {
      const i = s.indexOf(p, at);
      if (i < 0 || i + p.length > end) return false;
      at = i + p.length;
    }
    return true;
  };
}

export interface QueryContext { tsFieldOf: (index: string) => string | null }

export function getField(r: Row, f: string, ctx: QueryContext): Primitive | undefined {
  if (f === '_index') return r.index;
  if (f === '_file') return r.file;
  const v = own(r.flat, f);
  if (f === '@timestamp' && v === undefined) {
    const tf = ctx.tsFieldOf(r.index);
    return tf ? own(r.flat, tf) : undefined;
  }
  return v;
}

type ValueMatch = (v: Primitive | undefined) => boolean;

/** strings up to this length are memoized; longer ones are rarely repeated */
const MEMO_MAX_LEN = 64;
const MEMO_MAX_SIZE = 4096;

/**
 * Remember a matcher's answer per distinct short string. Low-cardinality fields (level, service,
 * method, …) then cost one map lookup per row: each distinct value is lowercased and tested once
 * per query instead of once per row. High-cardinality values just miss (the cache stops growing).
 */
function memo(m: ValueMatch): ValueMatch {
  const cache = new Map<string, boolean>();
  return (v) => {
    if (typeof v !== 'string' || v.length > MEMO_MAX_LEN) return m(v);
    let r = cache.get(v);
    if (r === undefined) {
      r = m(v);
      if (cache.size < MEMO_MAX_SIZE) cache.set(v, r);
    }
    return r;
  };
}

const exists: ValueMatch = (v) => v !== undefined && v !== null && v !== '';

function valueMatcher(raw: string, quoted: boolean): ValueMatch {
  return !quoted && raw === '*' ? exists : memo(rawMatcher(raw, quoted));
}

/** like {@link valueMatcher}, unmemoized (for use inside a memoized group) */
function rawMatcher(raw: string, quoted: boolean): ValueMatch {
  if (!quoted && raw === '*') return exists;
  const lower = raw.toLowerCase();
  if (!quoted && raw.includes('*')) {
    const m = wildcardMatcher(raw, true);
    return (v) => v !== undefined && v !== null && m(String(v).toLowerCase());
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
  let depth = 0;
  const enter = () => { if (++depth > MAX_QUERY_DEPTH) throw new QueryError(`Query is nested too deeply (max ${MAX_QUERY_DEPTH} levels)`); };
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
    if (isKw(peek(), 'not')) { p++; neg++; enter(); const inner = parseNot(); depth--; neg--; return (r) => !inner(r); }
    return parsePrimary();
  }
  function parseValueGroup(field: string): Pred {
    // after "field:(" — values separated by or/and
    const ms: { m: ValueMatch; neg: boolean }[] = [];
    let mode: 'or' | 'and' = 'or';
    while (peek() && peek().t !== ')') {
      const tk = toks[p++];
      if (tk.t === 'word' && (tk.v.toLowerCase() === 'or' || tk.v.toLowerCase() === 'and')) { mode = tk.v.toLowerCase() as 'or' | 'and'; continue; }
      if (tk.t === 'word' && tk.v.toLowerCase() === 'not') {
        const nx = toks[p++];
        if (!nx || (nx.t !== 'word' && nx.t !== 'str')) throw new QueryError('Expected value after not');
        ms.push({ m: rawMatcher(nx.v, nx.t === 'str'), neg: true });
        continue;
      }
      if (tk.t !== 'word' && tk.t !== 'str') throw new QueryError(`Unexpected token in value group for ${field}`);
      ms.push({ m: rawMatcher(tk.v, tk.t === 'str'), neg: false });
      hlValue(field, tk.v, tk.t === 'str');
    }
    if (!peek()) throw new QueryError('Missing )');
    p++;
    const all = mode === 'and';
    // the whole group is memoized once, so its members are not memoized separately
    const m = memo((v) => {
      for (const x of ms) if ((x.m(v) !== x.neg) !== all) return !all;
      return all;
    });
    return (r) => m(getField(r, field, ctx));
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
      enter();
      const inner = parseOr();
      if (!peek() || peek().t !== ')') throw new QueryError('Missing )');
      p++;
      depth--;
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
      const m = wildcardMatcher(w, false);
      if (w.replace(/\*/g, '')) hl(null, w, 'wildcard');
      return (r) => m(r.lower);
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
function equalsMatcher(value: Primitive | undefined): ValueMatch {
  if (value === null) return (v) => v === null;
  const want = String(value).toLowerCase();
  return (v) => {
    if (v === undefined || v === null) return false;
    const s = String(v);
    // Lowercasing preserves length except for U+0130 (İ → i̇), so most mismatches skip the allocation.
    if (s.length !== want.length && !s.includes('İ')) return false;
    return s.toLowerCase() === want;
  };
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
      const m = memo(equalsMatcher(f.value));
      return (r) => m(getField(r, field, ctx));
    }
    case 'is_one_of': {
      const ms = (f.values ?? []).map(equalsMatcher);
      if (!ms.length) throw new QueryError(`Filter on ${field} needs at least one value`);
      const m = memo((v) => ms.some((x) => x(v)));
      return (r) => m(getField(r, field, ctx));
    }
    case 'between': {
      const gte = (f.gte ?? '').trim(), lte = (f.lte ?? '').trim();
      if (!gte && !lte) throw new QueryError(`Filter on ${field} needs a start or an end value`);
      const lo = gte ? compare('>=', field, gte, ctx) : null;
      const hi = lte ? compare('<=', field, lte, ctx) : null;
      return (r) => (!lo || lo(r)) && (!hi || hi(r));
    }
    case 'exists':
      return (r) => exists(getField(r, field, ctx));
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
