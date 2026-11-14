import { Worker } from 'worker_threads';
import { FromWorker, ToWorker, WorkerInit } from './protocol';
import { ContextRequest, ContextResult, DetectedFields, Hit, QueryRequest, QueryResult, StoreLimits, SuggestRequest, SuggestResult } from './types';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** ingest batches posted before the client waits for the worker to catch up */
export const INGEST_WINDOW = 4;

/**
 * Promise-based wrapper around the engine worker. Messages are processed in order.
 *
 * Backpressure: `ingest()` returns a promise. Every `ingestWindow` batches the client asks the
 * worker for an ack, and until it arrives every `ingest()` call returns that pending promise, so
 * callers that await it (the tailers) stop reading. A 500 MB initial load therefore never sits in
 * the worker's message queue all at once.
 *
 * Cancellation: `supersede()` bumps a generation counter shared with the worker. Queries and ticks
 * carry the generation they were issued for; the worker abandons them (result `null`) as soon as
 * the counter moves on, even mid-scan.
 */
export class WorkerClient {
  private w: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private gen = new Int32Array(new SharedArrayBuffer(4));
  private unacked = 0;
  private drain: Promise<void> | null = null;
  onError: (msg: string) => void = () => {};

  constructor(workerPath: string, limits: StoreLimits, overrides: Partial<DetectedFields>, private ingestWindow = INGEST_WINDOW) {
    const init: WorkerInit = { generation: this.gen.buffer as SharedArrayBuffer };
    this.w = new Worker(workerPath, { workerData: init });
    this.w.on('message', (m: FromWorker) => {
      if (m.type === 'error') {
        if (m.reqId !== undefined) this.settle(m.reqId, undefined, new Error(m.message));
        else this.onError(m.message);
        return;
      }
      this.settle(m.reqId, m.type === 'page' ? m.hits : m.type === 'ack' ? undefined : m.result);
    });
    this.w.on('error', (e) => this.onError(e.stack || e.message));
    this.post({ type: 'init', limits, overrides });
  }

  private settle(id: number, v: unknown, err?: Error) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (err) p.reject(err); else p.resolve(v);
  }

  private post(m: ToWorker) { this.w.postMessage(m); }

  private request<T>(m: DistributiveOmit<Extract<ToWorker, { reqId: number }>, 'reqId'>): Promise<T> {
    const reqId = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.post({ ...(m as object), reqId } as ToWorker);
    });
  }

  /** current query generation */
  get generation() { return Atomics.load(this.gen, 0); }

  /** Start a new query generation; every query or tick of an older one is abandoned. */
  supersede(): number { return Atomics.add(this.gen, 0, 1) + 1; }

  configure(limits: StoreLimits, overrides: Partial<DetectedFields>) { this.post({ type: 'config', limits, overrides }); }

  /** Post a batch of lines. Resolves once the worker has room for more; never rejects. */
  ingest(index: string, file: string, lines: string[]): Promise<void> {
    this.post({ type: 'ingest', index, file, lines });
    if (++this.unacked >= this.ingestWindow && !this.drain) {
      this.unacked = 0;
      const d: Promise<void> = this.request<void>({ type: 'sync' })
        .catch(() => undefined)
        .then(() => { if (this.drain === d) this.drain = null; });
      this.drain = d;
    }
    return this.drain ?? Promise.resolve();
  }

  dropFile(index: string, file: string) { this.post({ type: 'dropFile', index, file }); }
  dropIndex(index: string) { this.post({ type: 'dropIndex', index }); }
  /** null when superseded by a newer generation before or while it ran */
  query(req: QueryRequest, gen = this.generation) { return this.request<QueryResult | null>({ type: 'query', req, gen }); }
  /** null when there was nothing new, or when superseded */
  tick(gen = this.generation) { return this.request<QueryResult | null>({ type: 'tick', gen }); }
  page(offset: number, count: number) { return this.request<Hit[]>({ type: 'page', offset, count }); }
  context(req: ContextRequest) { return this.request<ContextResult>({ type: 'context', req }); }
  suggest(req: SuggestRequest) { return this.request<SuggestResult>({ type: 'suggest', req }); }

  dispose() {
    for (const p of this.pending.values()) p.reject(new Error('disposed'));
    this.pending.clear();
    void this.w.terminate();
  }
}
