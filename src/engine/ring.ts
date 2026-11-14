import { Row } from './types';

/**
 * All retained rows in arrival (id) order, for scanning.
 * Rows can be removed from anywhere (eviction is by time, not arrival): removed rows are
 * flagged `dead` and skipped, and the array is compacted once dead rows dominate.
 */
export class RowBuffer {
  private a: Row[] = [];
  private deadCount = 0;

  get length() { return this.a.length - this.deadCount; }

  push(r: Row) { this.a.push(r); }

  remove(r: Row) {
    if (r.dead) return;
    r.dead = true;
    this.deadCount++;
    if (this.deadCount > 4096 && this.deadCount * 2 > this.a.length) {
      this.a = this.a.filter((x) => !x.dead);
      this.deadCount = 0;
    }
  }

  forEach(fn: (r: Row) => void) {
    for (const r of this.a) if (!r.dead) fn(r);
  }

  /** newest arrivals first; stops when fn returns false */
  forEachNewest(fn: (r: Row) => boolean) {
    for (let i = this.a.length - 1; i >= 0; i--) {
      const r = this.a[i];
      if (!r.dead && !fn(r)) return;
    }
  }

  /** position of the row with this id (ids only increase, so the array is sorted by id), or -1 */
  private indexOf(id: number): number {
    const a = this.a;
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a[mid].id < id) lo = mid + 1; else hi = mid;
    }
    return lo < a.length && a[lo].id === id ? lo : -1;
  }

  /** the live row with this id, by binary search */
  get(id: number): Row | undefined {
    const i = this.indexOf(id);
    return i >= 0 && !this.a[i].dead ? this.a[i] : undefined;
  }

  /**
   * Live rows that arrived after (dir 1) or before (dir -1) the row with this id, nearest first;
   * stops when fn returns false.
   */
  walkFrom(id: number, dir: 1 | -1, fn: (r: Row) => boolean) {
    const a = this.a;
    const at = this.indexOf(id);
    if (at < 0) return;
    for (let i = at + dir; i >= 0 && i < a.length; i += dir) {
      const r = a[i];
      if (!r.dead && !fn(r)) return;
    }
  }

  /** keep only rows matching pred; returns removed rows (flagged dead) */
  retain(pred: (r: Row) => boolean): Row[] {
    const kept: Row[] = [], removed: Row[] = [];
    this.forEach((r) => (pred(r) ? kept : removed).push(r));
    for (const r of removed) r.dead = true;
    this.a = kept;
    this.deadCount = 0;
    return removed;
  }
}

/** (ts, id) ascending; only for rows with a timestamp */
const byTime = (a: Row, b: Row) => (a.ts as number) - (b.ts as number) || a.id - b.id;

/**
 * Rows that have a timestamp, sorted by (ts, id), so a time-range query binary-searches its
 * window instead of visiting every row. Appends in time order (the common case: tailing) are
 * O(1); out-of-order rows (several files, late lines) wait in a side buffer that is sorted and
 * merged in on the next read. Removed rows are flagged `dead` by {@link RowBuffer} and skipped;
 * the array is compacted once they dominate.
 */
export class TimeIndex {
  private a: Row[] = [];
  private pending: Row[] = [];
  private deadCount = 0;
  /** timestamps changed (detection switched fields): rebuilt from the row buffer on next read */
  private stale = false;

  constructor(private source: RowBuffer) {}

  add(r: Row) {
    if (r.ts === null || this.stale) return;
    const last = this.a[this.a.length - 1];
    if (!this.pending.length && (!last || byTime(last, r) <= 0)) this.a.push(r);
    else this.pending.push(r);
  }

  /** a row was removed (already flagged dead) */
  removed(r: Row) {
    if (r.ts === null || this.stale) return;
    if (++this.deadCount > 4096 && this.deadCount * 2 > this.a.length + this.pending.length) {
      this.a = this.a.filter((x) => !x.dead);
      this.pending = this.pending.filter((x) => !x.dead);
      this.deadCount = 0;
    }
  }

  /** row timestamps changed or rows were bulk-removed: rebuild lazily */
  invalidate() {
    this.stale = true;
    this.a = [];
    this.pending = [];
    this.deadCount = 0;
  }

  private ready(): Row[] {
    if (this.stale) {
      const all: Row[] = [];
      this.source.forEach((r) => { if (r.ts !== null) all.push(r); });
      this.a = all.sort(byTime);
      this.stale = false;
    } else if (this.pending.length) {
      const p = this.pending.sort(byTime);
      this.pending = [];
      const a = this.a, out = new Array<Row>(a.length + p.length);
      let i = 0, j = 0, k = 0;
      while (i < a.length && j < p.length) out[k++] = byTime(a[i], p[j]) <= 0 ? a[i++] : p[j++];
      while (i < a.length) out[k++] = a[i++];
      while (j < p.length) out[k++] = p[j++];
      this.a = out;
    }
    return this.a;
  }

  /** index of the first row with ts >= t (strict: ts > t) */
  private static bound(a: Row[], t: number, strict: boolean): number {
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const ts = a[mid].ts as number;
      if (strict ? ts <= t : ts < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** live rows with from <= ts <= to, oldest first */
  forRange(from: number, to: number, fn: (r: Row) => void) {
    const a = this.ready();
    const end = TimeIndex.bound(a, to, true);
    for (let i = TimeIndex.bound(a, from, false); i < end; i++) {
      const r = a[i];
      if (!r.dead) fn(r);
    }
  }

  /**
   * Live rows after (dir 1: later in (ts, id) order) or before (dir -1) row `r`, nearest first;
   * stops when fn returns false. `r` must have a timestamp; with `r` null and dir 1, walks every
   * row from the oldest.
   */
  walkFrom(r: Row | null, dir: 1 | -1, fn: (r: Row) => boolean) {
    const a = this.ready();
    // first position strictly after r
    let lo = 0, hi = a.length;
    if (r) {
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (byTime(a[mid], r) <= 0) lo = mid + 1; else hi = mid;
      }
    } else if (dir < 0) return;
    for (let i = dir > 0 ? lo : lo - 1; i >= 0 && i < a.length; i += dir) {
      const x = a[i];
      if (x !== r && !x.dead && !fn(x)) return;
    }
  }

  /** live rows with from <= ts <= to, newest first; stops when fn returns false */
  forRangeNewest(from: number, to: number, fn: (r: Row) => boolean) {
    const a = this.ready();
    const start = TimeIndex.bound(a, from, false);
    for (let i = TimeIndex.bound(a, to, true) - 1; i >= start; i--) {
      const r = a[i];
      if (!r.dead && !fn(r)) return;
    }
  }
}

/** Rows of one source file in arrival order (≈ time order within a file). */
class FileQueue {
  private rows: (Row | undefined)[] = [];
  private head = 0;
  get size() { return this.rows.length - this.head; }
  push(r: Row) { this.rows.push(r); }
  peek(): Row { return this.rows[this.head] as Row; }
  shift(): Row {
    const r = this.rows[this.head] as Row;
    this.rows[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.rows.length) { this.rows = this.rows.slice(this.head); this.head = 0; }
    return r;
  }
}

/** eviction age: the row's timestamp, or when it arrived if it has none */
const age = (r: Row) => r.ts ?? r.arrival;
const older = (a: Row, b: Row) => { const x = age(a), y = age(b); return x !== y ? x < y : a.id < b.id; };

/**
 * Decides which rows to drop when over a limit: always the oldest by timestamp, either within
 * one index (per-index row limit) or across all indexes (shared memory budget).
 */
export class EvictionOrder {
  private queues = new Map<string, FileQueue>();

  add(r: Row) {
    let q = this.queues.get(r.fileKey);
    if (!q) { q = new FileQueue(); this.queues.set(r.fileKey, q); }
    q.push(r);
  }

  dropWhere(pred: (fileKey: string) => boolean) {
    for (const k of [...this.queues.keys()]) if (pred(k)) this.queues.delete(k);
  }

  /**
   * Evict oldest rows one at a time while `over()` is true.
   * With `keyPrefix`, only files whose key starts with it (i.e. one index) are considered.
   */
  evict(over: () => boolean, onEvict: (r: Row) => void, keyPrefix?: string) {
    if (!over()) return;
    // min-heap of file queues keyed by their oldest row (rebuilt per call, so timestamp recomputes are honoured)
    const h: FileQueue[] = [];
    for (const [k, q] of this.queues) if (q.size > 0 && (keyPrefix === undefined || k.startsWith(keyPrefix))) h.push(q);
    const less = (i: number, j: number) => older(h[i].peek(), h[j].peek());
    const down = (i: number) => {
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && less(l, m)) m = l;
        if (r < h.length && less(r, m)) m = r;
        if (m === i) return;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    };
    for (let i = (h.length >> 1) - 1; i >= 0; i--) down(i);
    while (h.length && over()) {
      onEvict(h[0].shift());
      if (h[0].size === 0) { h[0] = h[h.length - 1]; h.pop(); }
      if (h.length) down(0);
    }
    for (const [k, q] of this.queues) if (q.size === 0) this.queues.delete(k);
  }
}
