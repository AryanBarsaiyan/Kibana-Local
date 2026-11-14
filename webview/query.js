// Sending searches to the host.
// ---------- query ----------
import { $, RANGE_MS, S, vscode } from './state';
import { acClose } from './autocomplete';
import { closeContext } from './context';

export function currentRange() {
  const k = $('#range').value;
  if (k === 'all') return { kind: 'all' };
  if (k === 'custom') {
    const f = Date.parse($('#from').value), t = Date.parse($('#to').value);
    return isNaN(f) || isNaN(t) ? { kind: 'all' } : { kind: 'absolute', from: f, to: t };
  }
  return { kind: 'relative', ms: RANGE_MS[k] };
}
export function sendQuery() {
  S.expanded.clear();
  S.sug = null;
  vscode.postMessage({ type: 'query', q: S.ui.q, indexes: S.ui.indexes, range: S.ui.range, filters: S.ui.filters, sort: S.ui.sort });
}
/** user-initiated search (query, range, indexes): leaves the surrounding-documents view */
export function search() {
  acClose();
  S.ui.q = $('#q').value;
  const t = S.ui.q.trim();
  if (t) S.history = [t, ...S.history.filter((x) => x !== t)].slice(0, 20);
  S.ui.range = currentRange();
  if (S.ctx) closeContext();
  sendQuery();
}
