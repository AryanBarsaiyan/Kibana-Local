// Shared webview state, constants and DOM helpers. No module here touches the DOM at import time
// except layout.js, which renders the page skeleton.
import { own } from './lib/format';

export const vscode = acquireVsCodeApi();
export const post = (m) => vscode.postMessage(m);

export const $ = (sel, el = document) => el.querySelector(sel);

export const ROW_H = 24;
export const OVERSCAN = 12;
export const DOC_GUESS = 280;
export const RANGES = [
  ['all', 'All time'], ['5m', 'Last 5 minutes'], ['15m', 'Last 15 minutes'], ['1h', 'Last 1 hour'],
  ['4h', 'Last 4 hours'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['custom', 'Custom…'],
];
export const RANGE_MS = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '24h': 864e5, '7d': 6048e5 };

export const S = {
  sources: [],
  ui: { q: '', indexes: [], range: { kind: 'all' }, columns: null, mode: 'live', filters: [], sort: [] },
  pageSize: 200,
  seq: 0,
  result: null,
  detected: {},
  /** sparse: position -> hit */
  rows: [],
  requested: new Set(),
  expanded: new Set(),
  docHeights: new Map(),
  docTab: new Map(),
  openField: null,
  fieldFilter: '',
  pending: 0,
  focus: -1,
  /** surrounding-documents view, or null when showing results */
  ctx: null,
  ctxToken: 0,
  ctxExpanded: new Set(),
  /** recent queries, newest first (persisted by the host) */
  history: [],
  /** autocomplete dropdown: { items, sel, ctx } or null when closed */
  ac: null,
  /** latest value suggestions from the engine: { field, prefix, values, time } */
  sug: null,
  sugToken: 0,
  sugCbs: new Map(),
  /** compiled highlight rules for the current result */
  hl: [],
  /** current settings values from the host, or null before the first `settings` message */
  settings: null,
};

/** @typedef {{ ts: string | null, level: string | null, msg: string | null }} Detected */
/** detected ts/level/msg field names of an index */
export const det = (index) => /** @type {Detected} */ (own(S.detected, index) || { ts: null, level: null, msg: null });
export const activeIndexes = () => (S.ui.indexes.length ? S.ui.indexes : S.sources.map((s) => s.name));

export function knownFields() {
  const names = new Set(['@timestamp', '_index', '_file']);
  for (const x of (S.result && S.result.fields) || []) names.add(x.name);
  for (const n of (S.result && S.result.fieldNames) || []) names.add(n);
  return [...names];
}

/** sidebar type icon: ◷ time, # number, ◑ boolean, t text */
export function fieldKind(name, stat) {
  if (name === '@timestamp' || activeIndexes().some((i) => det(i).ts === name)) return '◷';
  const x = stat || (S.result && S.result.fields.find((f) => f.name === name));
  const v = x && x.top[0] && x.top[0].v;
  return v !== undefined && v !== '' && !isNaN(Number(v)) ? '#' : v === 'true' || v === 'false' ? '◑' : 't';
}

let toastTimer = null;
export function toast(text, level = 'info') {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast ' + level;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}
