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

/**
 * A filter pill (Kibana filter bar). Combined with the query using AND.
 *   is          field equals value (case-insensitive for strings)
 *   is_one_of   field equals any of values
 *   between     gte <= field <= lte (numbers or dates; either bound optional)
 *   exists      field is present and not empty
 *   query       a KQL expression, for filters that do not fit the forms above
 */
export interface Filter {
  field: string;
  op: 'is' | 'is_one_of' | 'between' | 'exists' | 'query';
  value?: Primitive;
  values?: Primitive[];
  gte?: string;
  lte?: string;
  query?: string;
  negate: boolean;
  disabled: boolean;
  label?: string;
}

/** Sort keys apply in order; ties fall back to newest first. `@timestamp` sorts by each row's detected time. */
export interface SortSpec {
  field: string;
  dir: 'asc' | 'desc';
}

export interface QueryRequest {
  q: string;
  indexes: string[];
  range: TimeRange;
  filters?: Filter[];
  sort?: SortSpec[];
}

/**
 * A search term to highlight in results. `field` null = free text (any field).
 *   word      whole-word match (case-insensitive)
 *   phrase    substring match (case-insensitive)
 *   wildcard  `*` pattern; anchored to the whole value when `field` is set
 *   exact     the whole value equals `value` (filter pills)
 */
export interface HighlightTerm {
  field: string | null;
  value: string;
  mode: 'word' | 'phrase' | 'wildcard' | 'exact';
}

export interface SuggestRequest {
  field: string;
  /** typed so far; values starting with it rank first, then values containing it */
  prefix: string;
  indexes: string[];
  range: TimeRange;
}

export interface SuggestResult {
  values: { v: string; c: number }[];
  /** rows looked at */
  sampled: number;
  /** the field is a time field: values are minutes, newest first */
  time: boolean;
}

export interface ContextRequest {
  /** hit id of the anchor document */
  id: number;
  /** number of newer documents to return */
  newer: number;
  /** number of older documents to return */
  older: number;
  indexes: string[];
  filters?: Filter[];
  /** only documents from the anchor's own file */
  sameFile: boolean;
}

export interface ContextResult {
  anchor: Hit | null;
  /** newest first, all newer than the anchor */
  newer: Hit[];
  /** newest first, all older than the anchor */
  older: Hit[];
  /** more documents exist beyond each end */
  moreNewer: boolean;
  moreOlder: boolean;
  error?: string;
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
  /** search terms to highlight in the results */
  highlight: HighlightTerm[];
  /** every field name seen in the selected indexes, regardless of hits (for autocomplete) */
  fieldNames: string[];
  error?: string;
}

export interface StoreLimits {
  maxRows: number;
  maxBytes: number;
}

export const PAGE_SIZE = 200;
