import * as path from 'path';
import { detectFields, flatten, parseLine, parseTimestamp } from './parse';
import { compileQuery, Pred, QueryError } from './query';
import { EvictionOrder, RowBuffer } from './ring';
import {
  DetectedFields, FieldStat, Hit, PAGE_SIZE, Primitive, QueryRequest, QueryResult, Row, StoreLimits,
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
const STATS_SAMPLE = 10000;

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

function merge(a: Row[], b: Row[]): Row[] {
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
}

interface Bounds { idxSet: Set<string> | null; from: number; to: number; timed: boolean }

export class LogStore {
  private buf = new RowBuffer();
  private order = new EvictionOrder();
  private rowsPerIndex = new Map<string, number>();
  private nextId = 1;
  private lastByFile = new Map<string, Row>();
  private indexes = new Map<string, IndexState>();
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
      if (r.index === index && r.isJson) r.ts = f ? parseTimestamp(r.flat[f]) : null;
    });
  }

  ingest(index: string, filePath: string, lines: string[]) {
    const file = path.basename(filePath);
    const fileKey = index + '\u0000' + filePath;
    const st = this.state(index);
    const arrival = Date.now();
    for (const line of lines) {
      const obj = parseLine(line);
      if (obj) {
        const flat = flatten(obj);
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
          ts: tsf ? parseTimestamp(flat[tsf]) : null,
          flat, raw: line, lower, isJson: true, bytes: estimateBytes(line, lower, flat), arrival,
        };
        this.add(row);
        continue;
      }
      // Non-JSON: continuation lines (stack traces) attach to the previous entry of the same file.
      const prev = this.lastByFile.get(fileKey);
      if (prev && (CONTINUATION.test(line) || EXCEPTION_HEADER.test(line)) && prev.raw.length < 200_000) {
        prev.raw += '\n' + line;
        prev.lower += line.toLowerCase() + '\n';
        const c = prev.flat['_continuation'];
        prev.flat['_continuation'] = (typeof c === 'string' && c ? c + '\n' : '') + line;
        const extra = line.length * 3 + 8;
        prev.bytes += extra;
        this.bytes += extra;
        this.touched.add(prev);
        continue;
      }
      const m = LEADING_TS.exec(line);
      const flat = { message: line };
      const lower = line.toLowerCase() + '\n';
      this.add({
        id: this.nextId++, index, file, fileKey,
        ts: m ? parseTimestamp(m[1]) : null,
        flat, raw: line, lower, isJson: false, bytes: estimateBytes(line, lower, flat), arrival,
      });
    }
    this.enforce();
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

  /** Full query: scans every retained row and starts a new session. */
  query(req: QueryRequest, now = Date.now()): QueryResult {
    const t0 = Date.now();
    let pred: Pred;
    try {
      pred = compileQuery(req.q || '', { tsFieldOf: (i) => this.detectedFor(i).ts });
    } catch (e) {
      this.session = null;
      this.pendingNew = [];
      this.touched.clear();
      return this.emptyResult(e instanceof QueryError ? e.message : String(e));
    }
    const b = this.bounds(req, now);
    const matched: Row[] = [];
    this.buf.forEach((r) => { if (this.accepts(r, b, pred)) matched.push(r); });
    matched.sort(cmp);
    this.session = { req, pred, matched };
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
  tick(now = Date.now()): QueryResult | null {
    const s = this.session;
    if (!s) { this.pendingNew = []; this.touched.clear(); this.evicted = false; return null; }
    if (this.dirty) return this.query(s.req, now);
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
      if (m === s.matched) m = m.slice();
      while (m.length && (m[m.length - 1].ts as number) < b.from) m.pop();
    }

    const fresh = [...candidates].filter((r) => this.accepts(r, b, s.pred)).sort(cmp);
    let prepended = 0;
    if (fresh.length) {
      if (!m.length || cmp(fresh[fresh.length - 1], m[0]) <= 0) {
        m = fresh.concat(m);
        prepended = fresh.length;
      } else {
        m = merge(m, fresh);
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

  private emptyResult(error?: string): QueryResult {
    return {
      total: 0, scanned: this.buf.length, hits: [], histogram: null, fields: [], fieldSample: 0, tookMs: 0,
      reset: true, prepended: 0, detected: this.detectedMap(), memoryBytes: this.bytes, indexRows: this.indexRows(), error,
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
