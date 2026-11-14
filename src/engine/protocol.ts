import { ContextRequest, ContextResult, DetectedFields, Hit, QueryRequest, QueryResult, StoreLimits, SuggestRequest, SuggestResult } from './types';

/** host → worker */
export type ToWorker =
  | { type: 'init'; limits: StoreLimits; overrides: Partial<DetectedFields> }
  | { type: 'config'; limits: StoreLimits; overrides: Partial<DetectedFields> }
  | { type: 'ingest'; index: string; file: string; lines: string[] }
  | { type: 'dropFile'; index: string; file: string }
  | { type: 'dropIndex'; index: string }
  | { type: 'query'; reqId: number; req: QueryRequest }
  | { type: 'tick'; reqId: number }
  | { type: 'page'; reqId: number; offset: number; count: number }
  | { type: 'context'; reqId: number; req: ContextRequest }
  | { type: 'suggest'; reqId: number; req: SuggestRequest };

/** worker → host */
export type FromWorker =
  | { type: 'result'; reqId: number; result: QueryResult | null }
  | { type: 'page'; reqId: number; hits: Hit[] }
  | { type: 'context'; reqId: number; result: ContextResult }
  | { type: 'suggest'; reqId: number; result: SuggestResult }
  | { type: 'error'; reqId?: number; message: string };
