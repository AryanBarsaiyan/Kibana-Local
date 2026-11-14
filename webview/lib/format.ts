/** Pure formatting helpers for the webview (no DOM access, unit-tested in test/webview.test.ts). */

export type Value = string | number | boolean | null;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML-escape for text and attribute values */
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** own-property lookup: field names such as `constructor` must not resolve to Object.prototype */
export const own = (o: Record<string, Value> | null | undefined, k: string | null | undefined): Value | undefined =>
  o && k != null && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

export const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function fmtTs(t: number | null | undefined): string {
  if (t == null) return '—';
  const d = new Date(t);
  return `${d.toLocaleString('en', { month: 'short' })} ${pad(d.getDate())}, ${d.getFullYear()} @ ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** histogram axis label; coarser buckets drop the finer parts */
export function fmtShort(t: number, bucket: number): string {
  const d = new Date(t);
  if (bucket >= 864e5) return `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
  if (bucket >= 6e4) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** epoch ms → value for <input type="datetime-local"> in local time */
export const toLocalInput = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 6e4).toISOString().slice(0, 19);

export function levelClass(v: unknown): string {
  const s = String(v ?? '').toLowerCase();
  if (/(fatal|crit|emerg|alert|panic|error|^err$|^50$|^60$)/.test(s)) return 'lv-error';
  if (/(warn|^40$)/.test(s)) return 'lv-warn';
  if (/(info|notice|^30$)/.test(s)) return 'lv-info';
  if (/(debug|trace|^20$|^10$)/.test(s)) return 'lv-debug';
  return '';
}

/** a value as it must be written in a query: bare when safe, otherwise double-quoted */
export function quoteVal(v: unknown): string {
  const str = String(v);
  return /^[\w.\-@/]+$/.test(str) && !/^(and|or|not)$/i.test(str) ? str : `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const fmtBytes = (b: number) =>
  b > 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : b > 1 << 20 ? Math.round(b / (1 << 20)) + ' MB' : Math.round(b / 1024) + ' KB';

/** filter-pill value */
export const fmtVal = (v: Value | undefined) => (v === null ? 'null' : v === '' ? '(empty)' : String(v));

/** cell value: null shows as the word */
export const showVal = (v: Value) => (v === null ? 'null' : v);
