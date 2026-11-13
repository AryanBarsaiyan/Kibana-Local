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
