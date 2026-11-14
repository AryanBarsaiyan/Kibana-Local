/**
 * Validation for everything the webview (or persisted workspace state) sends to the host.
 * Webview input is untrusted: these functions accept `unknown` and return only well-formed values.
 * Kept free of `vscode` imports so the tests can run them directly.
 */
import * as path from 'path';
import { Filter, IndexSource, Primitive, SortSpec, TimeRange } from './engine/types';

export const LIMITS = {
  filters: 100,
  filterValues: 200,
  sortKeys: 5,
  columns: 200,
  indexes: 500,
  /** characters in a query, filter value or label */
  text: 10_000,
  /** characters in a field or index name */
  name: 512,
  /** characters in a file or folder path */
  path: 4096,
} as const;

const FILTER_OPS = new Set<Filter['op']>(['is', 'is_one_of', 'between', 'exists', 'query']);
const isPrim = (v: unknown): v is Primitive =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
/** Primitives as text; objects become '' (String() on `{ toString: 1 }` would throw). */
const str = (v: unknown, max: number = LIMITS.text) =>
  (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '').slice(0, max);
const clip = (v: Primitive): Primitive => (typeof v === 'string' ? v.slice(0, LIMITS.text) : v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Keep only well-formed filters. */
export function cleanFilters(x: unknown): Filter[] {
  if (!Array.isArray(x)) return [];
  const out: Filter[] = [];
  for (const f of x.slice(0, LIMITS.filters)) {
    if (!isObj(f) || !FILTER_OPS.has(f.op as Filter['op'])) continue;
    const op = f.op as Filter['op'];
    const c: Filter = { field: str(f.field, LIMITS.name), op, negate: !!f.negate, disabled: !!f.disabled };
    if (typeof f.label === 'string' && f.label.trim()) c.label = f.label.trim().slice(0, LIMITS.text);
    if (op === 'is') c.value = isPrim(f.value) ? clip(f.value) : str(f.value);
    if (op === 'is_one_of') c.values = Array.isArray(f.values) ? f.values.filter(isPrim).slice(0, LIMITS.filterValues).map(clip) : [];
    if (op === 'between') { c.gte = str(f.gte); c.lte = str(f.lte); }
    if (op === 'query') c.query = str(f.query);
    out.push(c);
  }
  return out;
}

export function cleanSort(x: unknown): SortSpec[] {
  if (!Array.isArray(x)) return [];
  return x.filter((k) => isObj(k) && typeof k.field === 'string' && k.field && (k.dir === 'asc' || k.dir === 'desc'))
    .slice(0, LIMITS.sortKeys).map((k) => ({ field: k.field.slice(0, LIMITS.name), dir: k.dir }));
}

/** Index names, deduplicated; when `known` is given, only names in it survive. */
export function cleanIndexes(x: unknown, known?: readonly string[]): string[] {
  if (!Array.isArray(x)) return [];
  const ok = known ? new Set(known) : null;
  const out: string[] = [];
  for (const n of x.slice(0, LIMITS.indexes)) {
    if (typeof n !== 'string' || !n || n.length > LIMITS.name || out.includes(n)) continue;
    if (ok && !ok.has(n)) continue;
    out.push(n);
  }
  return out;
}

/**
 * Saved index sources (persisted workspace state). Entries need a name, an absolute path and a
 * known kind; malformed entries and repeated names are dropped.
 */
export function cleanSources(x: unknown): IndexSource[] {
  if (!Array.isArray(x)) return [];
  const out: IndexSource[] = [];
  const names = new Set<string>();
  for (const s of x.slice(0, LIMITS.indexes)) {
    if (!isObj(s)) continue;
    const { name, path: p, kind } = s;
    if (typeof name !== 'string' || !name.trim() || name.length > LIMITS.name || names.has(name)) continue;
    if (typeof p !== 'string' || !p || p.length > LIMITS.path || p.includes('\0') || !path.isAbsolute(p)) continue;
    if (kind !== 'file' && kind !== 'folder') continue;
    names.add(name);
    out.push({ name, path: p, kind });
  }
  return out;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A time range; anything malformed becomes "all time". */
export function cleanRange(x: unknown): TimeRange {
  if (!isObj(x)) return { kind: 'all' };
  if (x.kind === 'relative' && finite(x.ms) && x.ms > 0) return { kind: 'relative', ms: x.ms };
  if (x.kind === 'absolute' && finite(x.from) && finite(x.to)) {
    return x.from <= x.to ? { kind: 'absolute', from: x.from, to: x.to } : { kind: 'absolute', from: x.to, to: x.from };
  }
  return { kind: 'all' };
}

/** Column list, or null for "default columns". */
export function cleanColumns(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  const out = [...new Set(x.filter((c): c is string => typeof c === 'string' && !!c && c.length <= LIMITS.name))].slice(0, LIMITS.columns);
  return out.length ? out : null;
}

export function cleanText(x: unknown): string {
  return typeof x === 'string' ? x.slice(0, LIMITS.text) : '';
}

/** An integer in [min, max]; `fallback` for anything that is not a finite number. */
export function clampInt(x: unknown, min: number, max: number, fallback = min): number {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
