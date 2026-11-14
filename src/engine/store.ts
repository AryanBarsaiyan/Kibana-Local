import * as path from 'path';
import { ValueDict } from './dict';
import { detectFields, flatten, own, parseLine, parseTimestamp, setField } from './parse';
import { compileFilters, compileQuery, filterHighlights, getField, Pred, QueryContext, QueryError } from './query';
import { EvictionOrder, RowBuffer, TimeIndex } from './ring';
import {
  ContextRequest, ContextResult, DetectedFields, FieldStat, Filter, HighlightTerm, Hit, PAGE_SIZE, Primitive, QueryRequest,
  QueryResult, Row, SortSpec, StoreLimits, SuggestRequest, SuggestResult,
} from './types';

const LEADING_TS = /^\[?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d| UTC)?)\]?/;
/** a stack trace stops growing past this many chars; further lines become rows of their own */
const MAX_CONTINUED_CHARS = 200_000;
const CONTINUATION = /^(\s|at\s|Caused by|\.\.\.|CallStack)/;
/**
 * Unindented first line of a JVM stack trace, e.g. `java.lang.IllegalStateException: cursor closed`,
 * `com.acme.Outer$InnerError`, or `Exception in thread "main" java.lang.NullPointerException`.
 * Requires a package-qualified class name so plain messages like `Error: disk full` still start a new entry.
 */
const EXCEPTION_HEADER = /^(?:Exception in thread "|(?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)(?::|\s*$))/;
const DETECT_SAMPLES = 300;
/** field names remembered per index for autocomplete */
const MAX_FIELD_NAMES = 2000;
/** rows scanned between checks of the cancellation callback */
const CANCEL_CHECK_EVERY = 4096;

/** Thrown by query()/tick() when the caller's cancellation callback reports a newer request. */
export class Cancelled extends Error {
  constructor() { super('cancelled'); }
}
const STATS_SAMPLE = 10000;
/** rows scanned (newest first) for value suggestions */
const SUGGEST_SAMPLE = 50000;
const SUGGEST_LIMIT = 10;

const pad2 = (n: number) => String(n).padStart(2, '0');
/** local time to the minute, in the form the query language accepts: 2026-11-13T10:05 */
function localMinute(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Rough retained-heap estimate, calibrated against process.memoryUsage() in test/memory.test.ts.
 * V8 stores ASCII strings at 1 byte/char plus a header.
 *   ROW_BYTES   row object, boxed ts/arrival, row-buffer, time-index and eviction-queue slots
 *   FIELD_BYTES one property of the flattened object
 *   STR_BYTES   string header (not paid by dictionary-encoded values, which are shared)
 */
const ROW_BYTES = 200, FIELD_BYTES = 16, STR_BYTES = 16;

/**
 * Prepare a parsed row: low-cardinality string values are swapped for their shared dictionary
 * instance, and the free-text target is built (field values only, like Kibana, not JSON
 * keys/punctuation; lowercased once here so free-text search never lowercases). Returns the lowercased
 * text and the estimated bytes of `flat` + `lower`.
 */
function encodeRow(flat: Record<string, Primitive>, dict: ValueDict): { lower: string; bytes: number } {
  const parts: string[] = [];
  let b = 0;
  for (const k in flat) {
    const v = flat[k];
    b += FIELD_BYTES;
    if (typeof v === 'string') {
      const e = dict.lookup(k, v);
      if (e) { setField(flat, k, e.s); parts.push(e.lower); }
      else { b += STR_BYTES + v.length; parts.push(v.toLowerCase()); }
    } else if (v !== null && v !== undefined) {
      b += 8;
      parts.push(String(v));
    }
  }
  parts.push('');
  // join() yields a flat string; `s += ...` would build a rope that costs several times more until first searched
  const lower = parts.join('\n');
  return { lower, bytes: b + STR_BYTES + lower.length };
}

/** newest first: by timestamp, then arrival */
function cmp(a: Row, b: Row): number {
  const ta = a.ts ?? -Infinity, tb = b.ts ?? -Infinity;
  if (ta !== tb) return tb > ta ? 1 : -1;
  return b.id - a.id;
}

type Cmp = (a: Row, b: Row) => number;

type SortKey = number | string | undefined;

/** Normalised sort value: missing → undefined, numbers and numeric strings → number, anything else → string. */
function sortKey(v: Primitive | undefined): SortKey {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!isNaN(n)) return n;
  }
  return String(v);
}

/** Missing values last in either direction; numbers numerically; otherwise by string. */
function compareKeys(a: SortKey, b: SortKey, sign: number): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  let c: number;
  if (typeof a === 'number' && typeof b === 'number') c = a - b;
  else {
    const sa = String(a), sb = String(b);
    c = sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  return c * sign;
}

const isDefaultSort = (sort: SortSpec[]) => !sort.length || (sort.length === 1 && sort[0].field === '@timestamp' && sort[0].dir === 'desc');

function merge(a: Row[], b: Row[], cmp: Cmp): Row[] {
  const out = new Array<Row>(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) out[k++] = cmp(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

interface IndexState {
  samples: Record<string, Primitive>[];
  locked: boolean;
  detected: DetectedFields;
}

interface Session {
  req: QueryRequest;
  pred: Pred;
  matched: Row[];
  cmp: Cmp;
  /** newest first by time: rows that age out of a sliding range sit at the end */
  timeDesc: boolean;
  highlight: HighlightTerm[];
}

interface Bounds { idxSet: Set<string> | null; from: number; to: number; timed: boolean }

export class LogStore {
  private buf = new RowBuffer();
  private timeIdx = new TimeIndex(this.buf);
  private order = new EvictionOrder();
  private dict = new ValueDict();
  private rowsPerIndex = new Map<string, number>();
  private nextId = 1;
  private lastByFile = new Map<string, Row>();
  /** continuation lines buffered during the current ingest() batch, per row (see applyContinued) */
  private continued = new Map<Row, { lines: string[]; chars: number }>();
  private indexes = new Map<string, IndexState>();
  /** field names seen per index (capped), for autocomplete */
  private names = new Map<string, Set<string>>();
  /** bumped whenever a field name is added or removed (invalidates the sorted-names cache) */
  private namesVersion = 0;
  private namesCache: { key: string; version: number; list: string[] } | null = null;
  private bytes = 0;

  private session: Session | null = null;
  private pendingNew: Row[] = [];
  private touched = new Set<Row>();
  private evicted = false;
  private dirty = false;

  constructor(private limits: StoreLimits, private overrides: Partial<DetectedFields> = {}) {}

  get size() { return this.buf.length; }
  get memoryBytes() { return this.bytes; }

  detectedFor(index: string): DetectedFields {
    return this.indexes.get(index)?.detected ?? { ts: null, level: null, msg: null };
  }

  detectedMap(): Record<string, DetectedFields> {
    const out: Record<string, DetectedFields> = {};
    for (const [k, v] of this.indexes) out[k] = v.detected;
    return out;
  }

  setOverrides(o: Partial<DetectedFields>) {
    this.overrides = o;
    for (const [name, st] of this.indexes) {
      st.detected = detectFields(st.samples, o);
      this.recomputeTs(name);
    }
    this.dirty = true;
  }

  setLimits(l: StoreLimits) {
    this.limits = l;
    this.enforce();
  }

  private state(index: string): IndexState {
    let st = this.indexes.get(index);
    if (!st) {
      st = { samples: [], locked: false, detected: { ts: null, level: null, msg: null } };
      this.indexes.set(index, st);
    }
    return st;
  }

  private recomputeTs(index: string) {
    const f = this.detectedFor(index).ts;
    this.buf.forEach((r) => {
      if (r.index === index && r.isJson) r.ts = f ? parseTimestamp(own(r.flat, f)) : null;
    });
    this.timeIdx.invalidate();
  }

  ingest(index: string, filePath: string, lines: string[]) {
    const file = path.basename(filePath);
    const fileKey = index + '\u0000' + filePath;
    const st = this.state(index);
    const arrival = Date.now();
    for (const line of lines) {
      try {
        this.ingestLine(index, file, fileKey, st, arrival, line);
      } catch {
        // One malformed line (e.g. a value too deep to stringify) must not drop the rest of the batch.
        this.addPlain(index, file, fileKey, arrival, line);
      }
    }
    this.applyContinued();
    this.enforce();
  }

  private ingestLine(index: string, file: string, fileKey: string, st: IndexState, arrival: number, line: string) {
    const obj = parseLine(line);
    if (obj) {
      const flat = flatten(obj);
      this.noteNames(index, flat);
      if (!st.locked) {
        st.samples.push(flat);
        const n = st.samples.length;
        if (n < 25 || n % 25 === 0) {
          const before = st.detected.ts;
          st.detected = detectFields(st.samples, this.overrides);
          if (before !== st.detected.ts) { this.recomputeTs(index); this.dirty = true; }
        }
        if (n >= DETECT_SAMPLES) st.locked = true;
      }
      const tsf = st.detected.ts;
      const { lower, bytes } = encodeRow(flat, this.dict);
      const row: Row = {
        id: this.nextId++, index, file, fileKey,
        ts: tsf ? parseTimestamp(own(flat, tsf)) : null,
        flat, raw: line, lower, isJson: true, bytes: ROW_BYTES + STR_BYTES + line.length + bytes, arrival,
      };
      this.add(row);
      return;
    }
    // Non-JSON: continuation lines (stack traces) attach to the previous entry of the same file.
    const prev = this.lastByFile.get(fileKey);
    if (prev && (CONTINUATION.test(line) || EXCEPTION_HEADER.test(line))) {
      let p = this.continued.get(prev);
      if (!p) { p = { lines: [], chars: prev.raw.length }; this.continued.set(prev, p); }
      if (p.chars < MAX_CONTINUED_CHARS) {
        p.lines.push(line);
        p.chars += line.length + 1;
        return;
      }
    }
    this.addPlain(index, file, fileKey, arrival, line);
  }

  /**
   * Attach the continuation lines buffered by this batch, joining once per row: appending line by
   * line with `+=` would leave raw/lower/_continuation as ropes costing several times their length.
   */
  private applyContinued() {
    for (const [row, { lines }] of this.continued) {
      const add = lines.join('\n');
      const c = own(row.flat, '_continuation');
      const had = typeof c === 'string' && c !== '';
      row.raw = [row.raw, add].join('\n');
      // `lower` ends with '\n' (see encodeRow / addPlain)
      row.lower = [row.lower, add.toLowerCase(), ''].join('');
      row.flat['_continuation'] = had ? [c, add].join('\n') : add;
      // raw, lower and _continuation each grow by add + one newline; a new field also costs its slot
      const extra = 3 * (add.length + 1) + (had ? 0 : FIELD_BYTES + STR_BYTES);
      row.bytes += extra;
      this.bytes += extra;
      this.touched.add(row);
    }
    this.continued.clear();
  }

  /** a non-JSON line: the whole line is the message */
  private addPlain(index: string, file: string, fileKey: string, arrival: number, line: string) {
    const m = LEADING_TS.exec(line);
    const flat: Record<string, Primitive> = { message: line };
    this.noteNames(index, flat);
    // lowercase after appending, so `lower` is one flat string rather than a two-piece rope
    const lower = (line + '\n').toLowerCase();
    this.add({
      id: this.nextId++, index, file, fileKey,
      ts: m ? parseTimestamp(m[1]) : null,
      // `message` shares the raw string
      flat, raw: line, lower, isJson: false, bytes: ROW_BYTES + STR_BYTES + line.length + FIELD_BYTES + STR_BYTES + lower.length, arrival,
    });
  }

  private noteNames(index: string, flat: Record<string, Primitive>) {
    let set = this.names.get(index);
    if (!set) { set = new Set(); this.names.set(index, set); }
    for (const k in flat) {
      if (set.size >= MAX_FIELD_NAMES) return;
      if (!set.has(k)) { set.add(k); this.namesVersion++; }
    }
  }

  /** field names across the given indexes (all when empty), sorted; cached until a name is added */
  fieldNames(indexes: string[] = []): string[] {
    const key = indexes.join('\u0000');
    const c = this.namesCache;
    if (c && c.key === key && c.version === this.namesVersion) return c.list;
    const out = new Set<string>();
    for (const [name, set] of this.names) if (!indexes.length || indexes.includes(name)) for (const k of set) out.add(k);
    const list = [...out].sort();
    this.namesCache = { key, version: this.namesVersion, list };
    return list;
  }

  private add(row: Row) {
    this.buf.push(row);
    this.timeIdx.add(row);
    this.order.add(row);
    this.countRow(row.index, 1);
    this.bytes += row.bytes;
    this.lastByFile.set(row.fileKey, row);
    if (this.session) this.pendingNew.push(row);
  }

  /**
   * maxRows is per index: each index keeps its newest rows by timestamp.
   * maxBytes is shared: over budget, the oldest rows by timestamp go first, from any index.
   */
  private enforce() {
    const { maxRows, maxBytes } = this.limits;
    const onEvict = (r: Row) => {
      this.buf.remove(r);
      this.timeIdx.removed(r);
      this.bytes -= r.bytes;
      this.countRow(r.index, -1);
      this.evicted = true;
      if (this.lastByFile.get(r.fileKey) === r) this.lastByFile.delete(r.fileKey);
    };
    for (const [index, n] of this.rowsPerIndex) {
      if (n > maxRows) this.order.evict(() => (this.rowsPerIndex.get(index) ?? 0) > maxRows, onEvict, index + '\u0000');
    }
    this.order.evict(() => this.buf.length > 1 && this.bytes > maxBytes, onEvict);
  }

  private countRow(index: string, delta: number) {
    const n = (this.rowsPerIndex.get(index) ?? 0) + delta;
    if (n > 0) this.rowsPerIndex.set(index, n);
    else this.rowsPerIndex.delete(index);
  }

  /** retained rows per index */
  indexRows(): Record<string, number> {
    return Object.fromEntries(this.rowsPerIndex);
  }

  dropFile(index: string, filePath: string) {
    const key = index + '\u0000' + filePath;
    for (const r of this.buf.retain((r) => r.fileKey !== key)) { this.bytes -= r.bytes; this.countRow(r.index, -1); }
    this.order.dropWhere((k) => k === key);
    this.lastByFile.delete(key);
    this.timeIdx.invalidate();
    this.dirty = true;
  }

  dropIndex(index: string) {
    for (const r of this.buf.retain((r) => r.index !== index)) this.bytes -= r.bytes;
    this.rowsPerIndex.delete(index);
    this.order.dropWhere((k) => k.startsWith(index + '\u0000'));
    for (const k of [...this.lastByFile.keys()]) if (k.startsWith(index + '\u0000')) this.lastByFile.delete(k);
    this.indexes.delete(index);
    this.names.delete(index);
    this.namesVersion++;
    this.timeIdx.invalidate();
    this.dirty = true;
  }

  private bounds(req: QueryRequest, now: number): Bounds {
    const idxSet = req.indexes.length ? new Set(req.indexes) : null;
    let from = -Infinity, to = Infinity;
    if (req.range.kind === 'relative') from = now - req.range.ms;
    else if (req.range.kind === 'absolute') { from = req.range.from; to = req.range.to; }
    return { idxSet, from, to, timed: req.range.kind !== 'all' };
  }

  private accepts(r: Row, b: Bounds, pred: Pred): boolean {
    if (b.idxSet && !b.idxSet.has(r.index)) return false;
    if (b.timed && (r.ts === null || r.ts < b.from || r.ts > b.to)) return false;
    return pred(r);
  }

  private qctx(): QueryContext {
    return { tsFieldOf: (i) => this.detectedFor(i).ts };
  }

  /** query AND every enabled filter */
  private compile(q: string, filters: Filter[] | undefined, highlight?: HighlightTerm[]): Pred {
    const ctx = this.qctx();
    const qp = compileQuery(q || '', ctx, highlight);
    if (highlight) highlight.push(...filterHighlights(filters, ctx));
    const fp = compileFilters(filters, ctx);
    return fp ? (r) => fp(r) && qp(r) : qp;
  }

  /** value a sort key reads from a row; virtual `_level` / `_message` resolve per index */
  private sortGetter(field: string): (r: Row) => Primitive | undefined {
    const ctx = this.qctx();
    if (field === '@timestamp') return (r) => r.ts;
    if (field === '_level') return (r) => { const f = this.detectedFor(r.index).level; return f ? own(r.flat, f) : undefined; };
    if (field === '_message') return (r) => { const f = this.detectedFor(r.index).msg; return f ? own(r.flat, f) : undefined; };
    return (r) => (field === this.detectedFor(r.index).ts ? r.ts : getField(r, field, ctx));
  }

  private sortKeys(sort: SortSpec[]) {
    return sort.map((k) => ({ get: this.sortGetter(k.field), sign: k.dir === 'asc' ? 1 : -1 }));
  }

  /** row comparator for a sort spec; used for incremental merges (few rows) */
  private makeCmp(sort: SortSpec[]): Cmp {
    if (isDefaultSort(sort)) return cmp;
    const keys = this.sortKeys(sort);
    return (a, b) => {
      for (const k of keys) {
        const c = compareKeys(sortKey(k.get(a)), sortKey(k.get(b)), k.sign);
        if (c) return c;
      }
      return cmp(a, b);
    };
  }

  /** full sort: same order as makeCmp, but each row's keys are read once (decorate-sort-undecorate) */
  private sortRows(rows: Row[], sort: SortSpec[]): Row[] {
    if (isDefaultSort(sort)) return rows.sort(cmp);
    const keys = this.sortKeys(sort);
    const nk = keys.length;
    const dec = rows.map((r) => {
      const k = new Array<SortKey>(nk);
      for (let i = 0; i < nk; i++) k[i] = sortKey(keys[i].get(r));
      return { r, k };
    });
    dec.sort((a, b) => {
      for (let i = 0; i < nk; i++) {
        const c = compareKeys(a.k[i], b.k[i], keys[i].sign);
        if (c) return c;
      }
      return cmp(a.r, b.r);
    });
    for (let i = 0; i < dec.length; i++) rows[i] = dec[i].r;
    return rows;
  }

  /**
   * Full query: scans every retained row and starts a new session.
   * @param cancelled polled during the scan and sort; when it returns true the query stops with
   *   {@link Cancelled} and the previous session is left untouched.
   */
  query(req: QueryRequest, now = Date.now(), cancelled?: () => boolean): QueryResult {
    const t0 = Date.now();
    let pred: Pred;
    const highlight: HighlightTerm[] = [];
    try {
      pred = this.compile(req.q, req.filters, highlight);
    } catch (e) {
      this.session = null;
      this.pendingNew = [];
      this.touched.clear();
      return this.emptyResult(e instanceof QueryError ? e.message : String(e));
    }
    const b = this.bounds(req, now);
    const matched: Row[] = [];
    let seen = 0;
    const visit = (r: Row) => {
      if (cancelled && ++seen % CANCEL_CHECK_EVERY === 0 && cancelled()) throw new Cancelled();
      if (this.accepts(r, b, pred)) matched.push(r);
    };
    // a time range only visits its own window of the time index
    if (b.timed) this.timeIdx.forRange(b.from, b.to, visit);
    else this.buf.forEach(visit);
    if (cancelled?.()) throw new Cancelled();
    const sort = (req.sort ?? []).filter((k) => k && typeof k.field === 'string' && k.field && k.field !== '_source');
    this.sortRows(matched, sort);
    if (cancelled?.()) throw new Cancelled();
    this.session = { req, pred, matched, cmp: this.makeCmp(sort), timeDesc: isDefaultSort(sort), highlight: dedupeTerms(highlight) };
    this.pendingNew = [];
    this.touched.clear();
    this.evicted = false;
    this.dirty = false;
    return this.build(matched, req, now, t0, true, 0);
  }

  /** Whether tick() would do anything. */
  hasPending(): boolean {
    return !!this.session && (this.dirty || this.evicted || this.pendingNew.length > 0 || this.touched.size > 0 || this.session.req.range.kind === 'relative');
  }

  /**
   * Incremental update: only rows that arrived since the last query/tick are tested.
   * Falls back to a full query when detection changed or files were dropped.
   */
  tick(now = Date.now(), cancelled?: () => boolean): QueryResult | null {
    const s = this.session;
    if (!s) { this.pendingNew = []; this.touched.clear(); this.evicted = false; return null; }
    if (this.dirty) return this.query(s.req, now, cancelled);
    if (!this.hasPending()) return null;
    const t0 = Date.now();
    const b = this.bounds(s.req, now);
    let m = s.matched;
    let shifted = false;

    if (this.evicted) {
      m = m.filter((r) => !r.dead);
      this.evicted = false;
    }
    const candidates = new Set<Row>();
    for (const r of this.pendingNew) if (!r.dead) candidates.add(r);
    if (this.touched.size) {
      const ids = new Set<number>();
      for (const r of this.touched) if (!r.dead) { ids.add(r.id); candidates.add(r); }
      const before = m.length;
      m = m.filter((r) => !ids.has(r.id));
      if (m.length !== before) shifted = true;
    }
    this.pendingNew = [];
    this.touched.clear();

    if (b.timed) {
      if (s.timeDesc) {
        if (m === s.matched) m = m.slice();
        while (m.length && (m[m.length - 1].ts as number) < b.from) m.pop();
      } else {
        // custom sort: rows that slid out of the range can be anywhere
        const before = m.length;
        m = m.filter((r) => (r.ts as number) >= b.from);
        if (m.length !== before) shifted = true;
      }
    }

    const fresh = [...candidates].filter((r) => this.accepts(r, b, s.pred)).sort(s.cmp);
    let prepended = 0;
    if (fresh.length) {
      if (!m.length || s.cmp(fresh[fresh.length - 1], m[0]) <= 0) {
        m = fresh.concat(m);
        prepended = fresh.length;
      } else {
        m = merge(m, fresh, s.cmp);
        shifted = true;
      }
    }
    s.matched = m;
    return this.build(m, s.req, now, t0, false, shifted ? -1 : prepended);
  }

  page(offset: number, count: number): Hit[] {
    if (!this.session) return [];
    return this.session.matched.slice(offset, offset + count).map(toHit);
  }

  /**
   * Value suggestions for autocomplete: distinct values of `field` among the newest rows of the
   * selected indexes inside the time range. Values starting with the prefix rank before values
   * that merely contain it; then by frequency. Time fields suggest minutes, newest first.
   */
  suggest(req: SuggestRequest, now = Date.now()): SuggestResult {
    const b = this.bounds({ q: '', indexes: req.indexes, range: req.range }, now);
    const ctx = this.qctx();
    const field = req.field;
    const prefix = (req.prefix ?? '').toLowerCase();
    const counts = new Map<string, number>();
    let sampled = 0, time = false;
    const visit = (r: Row) => {
      if (b.idxSet && !b.idxSet.has(r.index)) return true;
      if (b.timed && (r.ts === null || r.ts < b.from || r.ts > b.to)) return true;
      sampled++;
      let v: Primitive | undefined;
      if (field === '@timestamp' || field === this.detectedFor(r.index).ts) {
        time = true;
        v = r.ts === null ? undefined : localMinute(r.ts);
      } else v = getField(r, field, ctx);
      if (v !== undefined && v !== null && v !== '') {
        const s = String(v);
        if (s.length <= 200 && (!prefix || s.toLowerCase().includes(prefix)) && (counts.size < 5000 || counts.has(s))) {
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
      }
      return sampled < SUGGEST_SAMPLE;
    };
    if (b.timed) this.timeIdx.forRangeNewest(b.from, b.to, visit);
    else this.buf.forEachNewest(visit);
    const rank = (s: string) => (prefix && !s.toLowerCase().startsWith(prefix) ? 1 : 0);
    const values = [...counts.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || (time ? (a[0] < b[0] ? 1 : -1) : b[1] - a[1] || (a[0] < b[0] ? -1 : 1)))
      .slice(0, SUGGEST_LIMIT)
      .map(([v, c]) => ({ v, c }));
    return { values, sampled, time };
  }

  /**
   * Surrounding documents (Kibana "View surrounding documents"): the anchor plus its nearest
   * neighbours in time, from the selected indexes, with the filters applied but not the query.
   */
  context(req: ContextRequest): ContextResult {
    let anchor: Row | null = null;
    this.buf.forEach((r) => { if (r.id === req.id) anchor = r; });
    const a = anchor as Row | null;
    if (!a) return { anchor: null, newer: [], older: [], moreNewer: false, moreOlder: false, error: 'That document is no longer loaded (it was dropped by a limit or its file was reloaded).' };
    let fp: Pred | null;
    try {
      fp = compileFilters(req.filters, this.qctx());
    } catch (e) {
      return { anchor: toHit(a), newer: [], older: [], moreNewer: false, moreOlder: false, error: e instanceof Error ? e.message : String(e) };
    }
    const idxSet = req.indexes.length ? new Set(req.indexes) : null;
    const newer: Row[] = [], older: Row[] = [];
    this.buf.forEach((r) => {
      if (r === a) return;
      if (req.sameFile ? r.fileKey !== a.fileKey : idxSet && !idxSet.has(r.index)) return;
      if (fp && !fp(r)) return;
      (cmp(r, a) < 0 ? newer : older).push(r);
    });
    newer.sort(cmp);
    older.sort(cmp);
    const nN = Math.max(0, Math.floor(req.newer)), nO = Math.max(0, Math.floor(req.older));
    return {
      anchor: toHit(a),
      newer: newer.slice(Math.max(0, newer.length - nN)).map(toHit),
      older: older.slice(0, nO).map(toHit),
      moreNewer: newer.length > nN,
      moreOlder: older.length > nO,
    };
  }

  private emptyResult(error?: string): QueryResult {
    return {
      total: 0, scanned: this.buf.length, hits: [], histogram: null, fields: [], fieldSample: 0, tookMs: 0,
      reset: true, prepended: 0, detected: this.detectedMap(), memoryBytes: this.bytes, indexRows: this.indexRows(), highlight: [], fieldNames: this.fieldNames(), error,
    };
  }

  private build(matched: Row[], req: QueryRequest, now: number, t0: number, reset: boolean, prepended: number): QueryResult {
    const b = this.bounds(req, now);
    const stats = this.fieldStats(matched);
    return {
      total: matched.length,
      scanned: this.buf.length,
      hits: matched.slice(0, PAGE_SIZE).map(toHit),
      histogram: histogram(matched, b.timed ? b.from : null, b.timed ? Math.min(b.to, now) : null, !!this.session?.timeDesc),
      fields: stats.fields,
      fieldSample: stats.sample,
      tookMs: Date.now() - t0,
      reset, prepended,
      detected: this.detectedMap(),
      memoryBytes: this.bytes,
      indexRows: this.indexRows(),
      highlight: this.session?.highlight ?? [],
      fieldNames: this.fieldNames(req.indexes),
    };
  }

  /**
   * Field list with top values over the first STATS_SAMPLE matches (the newest, in default order),
   * counts scaled up to the whole result. One pass over the sample rows.
   */
  private fieldStats(matched: Row[]): { fields: FieldStat[]; sample: number } {
    const n = Math.min(matched.length, STATS_SAMPLE);
    const acc = new StatsAcc();
    for (let i = 0; i < n; i++) acc.add(matched[i].flat);
    return { fields: acc.result(matched.length, n), sample: n };
  }
}

/** distinct values counted per field: the first ones seen (newest rows); later new values are not counted */
const STATS_MAX_VALUES = 2000;
/** longer string values are not counted as top values */
const STATS_MAX_LEN = 120;
const STATS_TOP = 5;
const STATS_MAX_FIELDS = 400;

interface FieldAcc {
  count: number;
  /** keyed by the value itself, so numbers are not stringified per row */
  vals: Map<Primitive, number>;
  /** vals has non-string keys (5 and "5" must merge when reported) */
  mixed: boolean;
}

/** Field presence counts and top-value counts. */
class StatsAcc {
  private f = new Map<string, FieldAcc>();

  add(flat: Record<string, Primitive>) {
    for (const k in flat) {
      let a = this.f.get(k);
      if (!a) { a = { count: 0, vals: new Map(), mixed: false }; this.f.set(k, a); }
      a.count++;
      const v = flat[k];
      const c = a.vals.get(v);
      if (c !== undefined) a.vals.set(v, c + 1);
      else if (v !== null && a.vals.size < STATS_MAX_VALUES && !(typeof v === 'string' && v.length > STATS_MAX_LEN)) {
        a.vals.set(v, 1);
        if (typeof v !== 'string') a.mixed = true;
      }
    }
  }

  result(total: number, n: number): FieldStat[] {
    const scale = total / Math.max(n, 1);
    // only the fields that are reported get their top values computed
    const names = [...this.f.keys()].sort((a, b) => a.localeCompare(b)).slice(0, STATS_MAX_FIELDS);
    return names.map((name) => {
      const a = this.f.get(name) as FieldAcc;
      return { name, count: Math.round(a.count * scale), top: topValues(a) };
    });
  }
}

/** the STATS_TOP most frequent values, without sorting them all; ties keep first-seen order (newest rows) */
function topValues(a: FieldAcc): { v: string; c: number }[] {
  let entries: Iterable<[Primitive, number]> = a.vals;
  if (a.mixed) {
    const merged = new Map<string, number>();
    for (const [v, c] of a.vals) { const k = String(v); merged.set(k, (merged.get(k) ?? 0) + c); }
    entries = merged;
  }
  const top: { v: string; c: number }[] = [];
  for (const [v, c] of entries) {
    if (top.length === STATS_TOP && c <= top[STATS_TOP - 1].c) continue;
    let i = top.length;
    while (i > 0 && top[i - 1].c < c) i--;
    top.splice(i, 0, { v: String(v), c });
    if (top.length > STATS_TOP) top.pop();
  }
  return top;
}

function dedupeTerms(terms: HighlightTerm[]): HighlightTerm[] {
  const seen = new Set<string>();
  return terms.filter((t) => {
    const k = `${t.field}\u0000${t.mode}\u0000${t.value.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function toHit(r: Row): Hit {
  return { id: r.id, index: r.index, file: r.file, ts: r.ts, flat: r.flat, raw: r.raw, isJson: r.isJson };
}

const NICE_BUCKETS = [1e3, 5e3, 1e4, 3e4, 6e4, 3e5, 6e5, 18e5, 36e5, 108e5, 216e5, 432e5, 864e5, 6048e5];

/**
 * @param newestFirst `matched` is sorted newest first with untimed rows last, so the time span is
 *   read off its two ends instead of a scan
 */
export function histogram(matched: Row[], from: number | null, to: number | null, newestFirst = false) {
  let lo: number, hi: number;
  if (from !== null && to !== null && isFinite(from) && isFinite(to)) { lo = from; hi = to; }
  else if (newestFirst) {
    hi = matched.length ? matched[0].ts ?? -Infinity : -Infinity;
    let j = matched.length - 1;
    while (j >= 0 && matched[j].ts === null) j--;
    lo = j >= 0 ? (matched[j].ts as number) : Infinity;
  } else {
    lo = Infinity; hi = -Infinity;
    for (const r of matched) if (r.ts !== null) { if (r.ts < lo) lo = r.ts; if (r.ts > hi) hi = r.ts; }
  }
  if (!isFinite(lo) || !isFinite(hi)) return null;
  const N = 60;
  const span = Math.max(hi - lo, 1000);
  const bucketMs = NICE_BUCKETS.find((x) => span / x <= N) ?? Math.ceil(span / N);
  const start = Math.floor(lo / bucketMs) * bucketMs;
  const n = Math.max(1, Math.floor((hi - start) / bucketMs) + 1);
  const counts = new Array<number>(n).fill(0);
  for (const r of matched) {
    if (r.ts === null) continue;
    const i = Math.floor((r.ts - start) / bucketMs);
    if (i >= 0 && i < n) counts[i]++;
  }
  return { start, bucketMs, counts };
}
