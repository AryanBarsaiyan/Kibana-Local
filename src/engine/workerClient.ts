import { Worker } from 'worker_threads';
import { FromWorker, ToWorker } from './protocol';
import { DetectedFields, Hit, QueryRequest, QueryResult, StoreLimits } from './types';

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Promise-based wrapper around the engine worker. Messages are processed in order. */
export class WorkerClient {
  private w: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  onError: (msg: string) => void = () => {};

  constructor(workerPath: string, limits: StoreLimits, overrides: Partial<DetectedFields>) {
    this.w = new Worker(workerPath);
    this.w.on('message', (m: FromWorker) => {
      if (m.type === 'error') {
        if (m.reqId !== undefined) this.settle(m.reqId, undefined, new Error(m.message));
        else this.onError(m.message);
        return;
      }
      this.settle(m.reqId, m.type === 'result' ? m.result : m.hits);
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

  configure(limits: StoreLimits, overrides: Partial<DetectedFields>) { this.post({ type: 'config', limits, overrides }); }
  ingest(index: string, file: string, lines: string[]) { this.post({ type: 'ingest', index, file, lines }); }
  dropFile(index: string, file: string) { this.post({ type: 'dropFile', index, file }); }
  dropIndex(index: string) { this.post({ type: 'dropIndex', index }); }
  query(req: QueryRequest) { return this.request<QueryResult>({ type: 'query', req }); }
  tick() { return this.request<QueryResult | null>({ type: 'tick' }); }
  page(offset: number, count: number) { return this.request<Hit[]>({ type: 'page', offset, count }); }

  dispose() {
    for (const p of this.pending.values()) p.reject(new Error('disposed'));
    this.pending.clear();
    void this.w.terminate();
  }
}
