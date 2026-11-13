import { DetectedFields, Hit, QueryRequest, QueryResult, StoreLimits } from './types';

/** host → worker */
export type ToWorker =
  | { type: 'init'; limits: StoreLimits; overrides: Partial<DetectedFields> }
  | { type: 'config'; limits: StoreLimits; overrides: Partial<DetectedFields> }
  | { type: 'ingest'; index: string; file: string; lines: string[] }
  | { type: 'dropFile'; index: string; file: string }
  | { type: 'dropIndex'; index: string }
  | { type: 'query'; reqId: number; req: QueryRequest }
  | { type: 'tick'; reqId: number }
  | { type: 'page'; reqId: number; offset: number; count: number };

/** worker → host */
export type FromWorker =
  | { type: 'result'; reqId: number; result: QueryResult | null }
  | { type: 'page'; reqId: number; hits: Hit[] }
  | { type: 'error'; reqId?: number; message: string };
