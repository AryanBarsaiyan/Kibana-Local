import * as path from 'path';
import { detectFields, flatten, own, parseLine, parseTimestamp } from './parse';
import { compileFilters, compileQuery, filterHighlights, getField, Pred, QueryContext, QueryError } from './query';
import { EvictionOrder, RowBuffer } from './ring';
import {
  ContextRequest, ContextResult, DetectedFields, FieldStat, Filter, HighlightTerm, Hit, PAGE_SIZE, Primitive, QueryRequest,
  QueryResult, Row, SortSpec, StoreLimits, SuggestRequest, SuggestResult,
} from './types';

const LEADING_TS = /^\[?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d| UTC)?)\]?/;
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

/** Free-text search runs over field values only (like Kibana), not JSON keys/punctuation. */
function valuesText(flat: Record<string, Primitive>): string {
  let s = '';
  for (const v of Object.values(flat)) if (v !== null && v !== undefined) s += String(v).toLowerCase() + '\n';
  return s;
}

/**
 * Rough retained-heap estimate. V8 stores ASCII strings at 1 byte/char;
 * calibrated against process.memoryUsage() in test/memory.test.ts.
 */
function estimateBytes(raw: string, lower: string, flat: Record<string, Primitive>): number {
  // fixed per-row cost: row object + buffer slot (160) + arrival field and eviction-queue slot (40, measured)
  let b = 200 + raw.length + lower.length;
  for (const k in flat) {
    const v = flat[k];
    b += 24 + (typeof v === 'string' ? 16 + v.length : 8);
  }
  return b;
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
  private order = new EvictionOrder();
  private rowsPerIndex = new Map<string, number>();
  private nextId = 1;
  private lastByFile = new Map<string, Row>();
  private indexes = new Map<string, IndexState>();
  /** field names seen per index (capped), for autocomplete */
  private names = new Map<string, Set<string>>();
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
      const lower = valuesText(flat);
      const row: Row = {
        id: this.nextId++, index, file, fileKey,
        ts: tsf ? parseTimestamp(own(flat, tsf)) : null,
        flat, raw: line, lower, isJson: true, bytes: estimateBytes(line, lower, flat), arrival,
      };
      this.add(row);
      return;
    }
    // Non-JSON: continuation lines (stack traces) attach to the previous entry of the same file.
    const prev = this.lastByFile.get(fileKey);
    if (prev && (CONTINUATION.test(line) || EXCEPTION_HEADER.test(line)) && prev.raw.length < 200_000) {
      prev.raw += '\n' + line;
      prev.lower += line.toLowerCase() + '\n';
      const c = own(prev.flat, '_continuation');
      prev.flat['_continuation'] = (typeof c === 'string' && c ? c + '\n' : '') + line;
      const extra = line.length * 3 + 8;
      prev.bytes += extra;
      this.bytes += extra;
      this.touched.add(prev);
      return;
    }
    this.addPlain(index, file, fileKey, arrival, line);
  }

  /** a non-JSON line: the whole line is the message */
  private addPlain(index: string, file: string, fileKey: string, arrival: number, line: string) {
    const m = LEADING_TS.exec(line);
    const flat: Record<string, Primitive> = { message: line };
    this.noteNames(index, flat);
    const lower = line.toLowerCase() + '\n';
    this.add({
      id: this.nextId++, index, file, fileKey,
      ts: m ? parseTimestamp(m[1]) : null,
      flat, raw: line, lower, isJson: false, bytes: estimateBytes(line, lower, flat), arrival,
    });
  }

  private noteNames(index: string, flat: Record<string, Primitive>) {
    let set = this.names.get(index);
    if (!set) { set = new Set(); this.names.set(index, set); }
    for (const k in flat) {
      if (set.size >= MAX_FIELD_NAMES) return;
      set.add(k);
    }
  }

  /** field names across the given indexes (all when empty), sorted */
  fieldNames(indexes: string[] = []): string[] {
    const out = new Set<string>();
    for (const [name, set] of this.names) if (!indexes.length || indexes.includes(name)) for (const k of set) out.add(k);
    return [...out].sort();
  }

  private add(row: Row) {
    this.buf.push(row);
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
    this.dirty = true;
  }

  dropIndex(index: string) {
    for (const r of this.buf.retain((r) => r.index !== index)) this.bytes -= r.bytes;
    this.rowsPerIndex.delete(index);
    this.order.dropWhere((k) => k.startsWith(index + '\u0000'));
    for (const k of [...this.lastByFile.keys()]) if (k.startsWith(index + '\u0000')) this.lastByFile.delete(k);
    this.indexes.delete(index);
    this.names.delete(index);
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
    this.buf.forEach((r) => {
      if (cancelled && ++seen % CANCEL_CHECK_EVERY === 0 && cancelled()) throw new Cancelled();
      if (this.accepts(r, b, pred)) matched.push(r);
    });
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
    this.buf.forEachNewest((r) => {
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
    });
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
      histogram: histogram(matched, b.timed ? b.from : null, b.timed ? Math.min(b.to, now) : null),
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

  private fieldStats(matched: Row[]): { fields: FieldStat[]; sample: number } {
    const n = Math.min(matched.length, STATS_SAMPLE);
    const counts = new Map<string, number>();
    const vals = new Map<string, Map<string, number>>();
    for (let i = 0; i < n; i++) {
      const flat = matched[i].flat;
      for (const k in flat) {
        counts.set(k, (counts.get(k) ?? 0) + 1);
        const v = flat[k];
        if (v === null || v === undefined) continue;
        const s = String(v);
        if (s.length > 120) continue;
        let m = vals.get(k);
        if (!m) { m = new Map(); vals.set(k, m); }
        if (m.size < 2000 || m.has(s)) m.set(s, (m.get(s) ?? 0) + 1);
      }
    }
    const scale = matched.length / Math.max(n, 1);
    const fields: FieldStat[] = [];
    for (const [name, c] of counts) {
      const m = vals.get(name);
      const top = m ? [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, c2]) => ({ v, c: c2 })) : [];
      fields.push({ name, count: Math.round(c * scale), top });
    }
    fields.sort((a, b) => a.name.localeCompare(b.name));
    return { fields: fields.slice(0, 400), sample: n };
  }
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

export function histogram(matched: Row[], from: number | null, to: number | null) {
  let lo: number, hi: number;
  if (from !== null && to !== null && isFinite(from) && isFinite(to)) { lo = from; hi = to; }
  else {
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
