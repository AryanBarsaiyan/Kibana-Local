// Result columns and sorting.
// ---------- columns ----------
// Virtual columns resolve to each row's own detected field, so indexes with
// different schemas (level vs severity, message vs text) line up in one view.
import { S, activeIndexes, det, vscode } from './state';
import { nextSort } from './lib/grid';
import { vp } from './layout';
import { sendQuery } from './query';
import { renderFields, renderHeader, renderRows } from './grid';
import { renderContext } from './context';

// A Map, not an object literal: a field named `constructor` must not resolve to Object.prototype.
const VIRTUAL = new Map([['_level', 'level'], ['_message', 'message']]);
/** header label for a column: virtual columns get their display name, real fields their own */
export const colLabel = (c) => VIRTUAL.get(c) ?? c;
export const resolveCol = (h, c) => (c === '_level' ? det(h.index).level : c === '_message' ? det(h.index).msg : c);
export function defaultColumns() {
  const idx = activeIndexes();
  const c = [];
  if (idx.some((i) => det(i).level)) c.push('_level');
  if (idx.some((i) => det(i).msg)) c.push('_message');
  return c.length ? c : ['_source'];
}
export const columns = () => (S.ui.columns && S.ui.columns.length ? S.ui.columns : defaultColumns());
export const showIndexCol = () => activeIndexes().length > 1 && !columns().includes('_index');
export const showTime = () => activeIndexes().some((i) => det(i).ts) || (S.result && S.result.hits.some((h) => h.ts != null));
export const isLevelCol = (c) => c === '_level' || activeIndexes().some((i) => det(i).level === c);
export const isMsgCol = (c) => c === '_source' || c === '_message' || activeIndexes().some((i) => det(i).msg === c);

export function setColumns(c) {
  S.ui.columns = c;
  vscode.postMessage({ type: 'columns', columns: c });
  renderHeader(); renderRows(true); renderFields();
  if (S.ctx) renderContext(false);
}
export function toggleColumn(f) {
  const c = columns().filter((x) => x !== '_source');
  // toggling a real field that a virtual column already shows removes the virtual one
  for (const v of ['_level', '_message']) {
    if (c.includes(v) && activeIndexes().some((i) => (v === '_level' ? det(i).level : det(i).msg) === f)) {
      setColumns(c.filter((x) => x !== v));
      return;
    }
  }
  setColumns(c.includes(f) ? c.filter((x) => x !== f) : [...c, f]);
}
export function gridTemplate() {
  const parts = ['22px'];
  if (showTime()) parts.push('228px');
  if (showIndexCol()) parts.push('110px');
  for (const c of columns()) parts.push(isLevelCol(c) ? '80px' : isMsgCol(c) ? 'minmax(220px, 4fr)' : 'minmax(90px, 1fr)');
  return parts.join(' ');
}

// ---------- sorting ----------
export const sortLabel = (f) => (f === '@timestamp' ? 'Time' : colLabel(f));
/** click: sort by this column alone (asc → desc → default); Shift-click: add or cycle it as a further sort key */
export function clickSort(field, add) {
  S.ui.sort = nextSort(S.ui.sort, field, add);
  vp.scrollTop = 0;
  sendQuery();
  renderHeader();
}
