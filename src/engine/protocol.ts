import { ContextRequest, ContextResult, DetectedFields, Hit, QueryRequest, QueryResult, StoreLimits, SuggestRequest, SuggestResult } from './types';

/**
 * Data handed to the worker at start-up.
 * `generation` is a shared Int32Array[1] holding the newest query generation; the worker polls it
 * while scanning so a superseded query or tick stops early instead of running to completion.
 */
export interface WorkerInit { generation: SharedArrayBuffer }

/** host → worker */
export type ToWorker =
  | { type: 'init'; limits: StoreLimits; overrides: Partial<DetectedFields> }
  | { type: 'config'; limits: StoreLimits; overrides: Partial<DetectedFields> }
  | { type: 'ingest'; index: string; file: string; lines: string[] }
  /** answered with `ack` once every message posted before it has been processed (ingest backpressure) */
  | { type: 'sync'; reqId: number }
  | { type: 'dropFile'; index: string; file: string }
  | { type: 'dropIndex'; index: string }
  /** `gen`: the query generation this request belongs to; it is abandoned once a newer one starts */
  | { type: 'query'; reqId: number; gen: number; req: QueryRequest }
  | { type: 'tick'; reqId: number; gen: number }
  | { type: 'page'; reqId: number; offset: number; count: number }
  | { type: 'context'; reqId: number; req: ContextRequest }
  | { type: 'suggest'; reqId: number; req: SuggestRequest };

/** worker → host */
export type FromWorker =
  /** result null: tick had nothing to do, or the request was superseded by a newer generation */
  | { type: 'result'; reqId: number; result: QueryResult | null }
  | { type: 'ack'; reqId: number }
  | { type: 'page'; reqId: number; hits: Hit[] }
  | { type: 'context'; reqId: number; result: ContextResult }
  | { type: 'suggest'; reqId: number; result: SuggestResult }
  | { type: 'error'; reqId?: number; message: string };
