export type Primitive = string | number | boolean | null;

export interface Row {
  id: number;
  index: string;
  /** basename, for display */
  file: string;
  /** index + '\0' + full path; identifies the source file */
  fileKey: string;
  ts: number | null;
  flat: Record<string, Primitive>;
  raw: string;
  /** lowercased field values (free-text search target) */
  lower: string;
  isJson: boolean;
  /** estimated retained heap bytes, for the memory cap */
  bytes: number;
  /** ms epoch when ingested; eviction age for rows without a timestamp */
  arrival: number;
  /** set once evicted or dropped */
  dead?: boolean;
}

export interface IndexSource {
  name: string;
  path: string;
  kind: 'file' | 'folder';
}

export interface DetectedFields {
  ts: string | null;
  level: string | null;
  msg: string | null;
}

export type TimeRange =
  | { kind: 'all' }
  | { kind: 'relative'; ms: number }
  | { kind: 'absolute'; from: number; to: number };

export interface QueryRequest {
  q: string;
  indexes: string[];
  range: TimeRange;
}

export interface FieldStat {
  name: string;
  count: number;
  top: { v: string; c: number }[];
}

export interface Hit {
  id: number;
  index: string;
  file: string;
  ts: number | null;
  flat: Record<string, Primitive>;
  raw: string;
  isJson: boolean;
}

export interface QueryResult {
  total: number;
  scanned: number;
  /** first page of hits, offset 0 */
  hits: Hit[];
  histogram: { start: number; bucketMs: number; counts: number[] } | null;
  fields: FieldStat[];
  /** sample size the field stats were computed over */
  fieldSample: number;
  tookMs: number;
  /** full re-query (true) vs incremental update (false) */
  reset: boolean;
  /** incremental only: number of new hits inserted at the top, or -1 if positions shifted arbitrarily */
  prepended: number;
  detected: Record<string, DetectedFields>;
  memoryBytes: number;
  /** retained rows per index (the row limit applies to each) */
  indexRows: Record<string, number>;
  error?: string;
}

export interface StoreLimits {
  maxRows: number;
  maxBytes: number;
}

export const PAGE_SIZE = 200;
