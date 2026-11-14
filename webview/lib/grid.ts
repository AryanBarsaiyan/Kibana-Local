/** Pure pieces of the results grid: virtual-list geometry, sort cycling, filter labels (unit-tested). */
import { fmtVal, Value } from './format';

// ---------- virtual list geometry ----------
// Collapsed rows are rowH tall; an expanded row adds `extra` pixels. `ex` is sorted by row index.

export interface Extra { i: number; extra: number }

/** y offset of row i */
export function topOf(i: number, ex: readonly Extra[], rowH: number): number {
  let acc = 0;
  for (const e of ex) { if (e.i < i) acc += e.extra; else break; }
  return i * rowH + acc;
}

/** row at y offset */
export function indexAt(y: number, ex: readonly Extra[], rowH: number): number {
  let acc = 0;
  for (const e of ex) {
    const top = e.i * rowH + acc;
    if (y < top) break;
    if (y < top + rowH + e.extra) return e.i;
    acc += e.extra;
  }
  return Math.max(0, Math.floor((y - acc) / rowH));
}

// ---------- sorting ----------

export interface SortKey { field: string; dir: 'asc' | 'desc' }
export const DEFAULT_SORT: SortKey[] = [{ field: '@timestamp', dir: 'desc' }];

/** An empty sort list means the default: newest first. */
export const effSort = (sort: readonly SortKey[] | null | undefined): SortKey[] => (sort && sort.length ? [...sort] : DEFAULT_SORT);

/**
 * Sort after a header click. Click: sort by this column alone (asc → desc → default; time just flips).
 * Shift-click (`add`): add it as a further key, or cycle it (asc → desc → removed).
 * Returns [] for the default order.
 */
export function nextSort(current: readonly SortKey[] | null | undefined, field: string, add: boolean): SortKey[] {
  const isT = field === '@timestamp';
  let s = effSort(current).map((x) => ({ ...x }));
  const i = s.findIndex((x) => x.field === field);
  const flip = (d: SortKey['dir']): SortKey['dir'] => (d === 'asc' ? 'desc' : 'asc');
  if (!add) {
    if (i >= 0 && s.length === 1) {
      if (isT) s[0].dir = flip(s[0].dir);
      else if (s[0].dir === 'asc') s[0].dir = 'desc';
      else s = [];
    } else if (i >= 0) s = [{ field, dir: flip(s[i].dir) }];
    else s = [{ field, dir: isT ? 'desc' : 'asc' }];
  } else if (i >= 0) {
    if (s[i].dir === 'asc') s[i].dir = 'desc';
    else if (s.length > 1) s.splice(i, 1);
    else s[i].dir = 'asc';
  } else s.push({ field, dir: isT ? 'desc' : 'asc' });
  if (s.length === 1 && s[0].field === '@timestamp' && s[0].dir === 'desc') s = [];
  return s;
}

// ---------- filter pills ----------

export interface Filter {
  field: string;
  op: 'is' | 'is_one_of' | 'between' | 'exists' | 'query';
  value?: Value; values?: Value[]; gte?: string; lte?: string; query?: string;
  negate: boolean; disabled: boolean; label?: string;
}

/** [menu value, op, negate, label] */
export const FILTER_OPS: [string, Filter['op'], boolean, string][] = [
  ['is', 'is', false, 'is'], ['is_not', 'is', true, 'is not'],
  ['is_one_of', 'is_one_of', false, 'is one of'], ['is_not_one_of', 'is_one_of', true, 'is not one of'],
  ['between', 'between', false, 'is between'], ['not_between', 'between', true, 'is not between'],
  ['exists', 'exists', false, 'exists'], ['not_exists', 'exists', true, 'does not exist'],
  ['query', 'query', false, 'matches KQL query'], ['not_query', 'query', true, 'does not match KQL query'],
];

export function filterText(f: Filter): string {
  if (f.label) return f.label;
  switch (f.op) {
    case 'is': return `${f.field}: ${fmtVal(f.value)}`;
    case 'is_one_of': return `${f.field}: ${(f.values || []).map(fmtVal).join(', ')}`;
    case 'between':
      return f.gte && f.lte ? `${f.field}: ${f.gte} → ${f.lte}` : f.gte ? `${f.field} ≥ ${f.gte}` : `${f.field} ≤ ${f.lte}`;
    case 'exists': return `${f.field}: exists`;
    case 'query': return f.query || '(empty query)';
  }
  return '?';
}

/** ⊕ / ⊖ / ∃: like Kibana, re-adding an existing filter updates it instead of duplicating it (mutates `filters`). */
export function addOrUpdateFilter(filters: Filter[], field: string, value: Value | undefined, negate: boolean): Filter[] {
  const op = value === undefined ? 'exists' : 'is';
  const same = filters.find((f) => f.op === op && f.field === field && !f.label &&
    (op === 'exists' || ((f.value === null) === (value === null) && String(f.value) === String(value))));
  if (same) { same.negate = !!negate; same.disabled = false; }
  else filters.push(op === 'exists' ? { field, op, negate: !!negate, disabled: false } : { field, op, value, negate: !!negate, disabled: false });
  return filters;
}
