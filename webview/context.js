// Surrounding documents view.
// ---------- surrounding documents ----------
import { $, S, det, toast, vscode } from './state';
import { fmtTs, levelClass, own } from './lib/format';
import { spacer, vp } from './layout';
import { gridTemplate } from './columns';
import { handleActs, handleDocButtons, headCells, moveFocus, renderHeader, renderRows, rowHtml } from './grid';

export const ctxStep = () => Math.max(1, Math.min(500, Math.floor(Number($('#ctxStep').value)) || 5));
export function openContext(id) {
  const step = ctxStep();
  S.ctx = { id, newer: step, older: step, sameFile: $('#ctxSame').checked, result: null, scrollAnchor: true };
  S.ctxExpanded = new Set([id]);
  $('#disc').classList.add('hidden');
  $('#ctx').classList.remove('hidden');
  $('#ctxRows').replaceChildren();
  $('#ctxAnchor').textContent = 'loading…';
  requestContext();
  $('#ctxList').focus();
}
export function closeContext() {
  if (!S.ctx) return;
  const id = S.ctx.origin;
  S.ctx = null;
  $('#ctx').classList.add('hidden');
  $('#disc').classList.remove('hidden');
  renderHeader();
  renderRows(true);
  const row = id !== undefined && spacer.querySelector(`.r[data-id="${id}"]`);
  if (row) moveFocus(Number(row.dataset.i));
  vp.focus();
}
export function requestContext() {
  const c = S.ctx;
  vscode.postMessage({ type: 'context', token: ++S.ctxToken, id: c.id, newer: c.newer, older: c.older, sameFile: c.sameFile });
}
export function ctxHits() {
  const r = S.ctx && S.ctx.result;
  if (!r || !r.anchor) return [];
  return [...r.newer, r.anchor, ...r.older];
}
export function renderContext(loadedNewer) {
  const c = S.ctx, r = c && c.result;
  if (!r) return;
  const list = $('#ctxList');
  const prevH = list.scrollHeight, prevTop = list.scrollTop;
  const a = r.anchor;
  $('#ctxAnchor').textContent = a ? `around ${fmtTs(a.ts)} · ${a.index} · ${a.file}` : '';
  if (r.error) toast(r.error, 'error');
  const tpl = gridTemplate();
  const gh = $('#ctxGhead');
  gh.style.gridTemplateColumns = tpl;
  gh.innerHTML = headCells(false);
  const rowsEl = $('#ctxRows');
  rowsEl.innerHTML = ctxHits().map((h) => {
    const open = S.ctxExpanded.has(h.id);
    const lv = levelClass(own(h.flat, det(h.index).level));
    return `<div class="r static ${lv ? 'row-' + lv : ''} ${open ? 'open' : ''} ${h.id === a.id ? 'anchor' : ''}" role="row" data-id="${h.id}" aria-expanded="${open}"${h.id === a.id ? ' aria-current="true"' : ''}>${rowHtml(h, S.ctxExpanded)}</div>`;
  }).join('');
  for (const el of rowsEl.querySelectorAll('.cells')) el.style.gridTemplateColumns = tpl;
  gh.style.paddingRight = list.offsetWidth - list.clientWidth + 'px';
  const step = ctxStep();
  $('#ctxNewer').textContent = `Load ${step} newer`;
  $('#ctxOlder').textContent = `Load ${step} older`;
  $('#ctxNewer').disabled = !r.moreNewer;
  $('#ctxOlder').disabled = !r.moreOlder;
  $('#ctxNewerInfo').textContent = `${r.newer.length} newer${r.moreNewer ? '' : ' · no more'}`;
  $('#ctxOlderInfo').textContent = `${r.older.length} older${r.moreOlder ? '' : ' · no more'}`;
  if (c.scrollAnchor) {
    c.scrollAnchor = false;
    const el = rowsEl.querySelector('.r.anchor');
    if (el) el.scrollIntoView({ block: 'center' });
  } else if (loadedNewer) list.scrollTop = prevTop + (list.scrollHeight - prevH);
}

export function initContext() {
  $('#ctxBack').onclick = closeContext;
  $('#ctxSame').onchange = () => { if (S.ctx) { S.ctx.sameFile = $('#ctxSame').checked; S.ctx.scrollAnchor = true; requestContext(); } };
  $('#ctxStep').onchange = () => { if (S.ctx) renderContext(false); };
  $('#ctx').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#pop').classList.contains('hidden')) { e.preventDefault(); closeContext(); }
  });
  $('#ctxList').addEventListener('click', (e) => {
    const t = e.target;
    const more = t.closest('[data-more]');
    if (more && S.ctx) {
      S.ctx[more.dataset.more] += ctxStep();
      S.ctx.loading = more.dataset.more;
      requestContext();
      return;
    }
    if (handleActs(t)) return;
    if (handleDocButtons(t, () => renderContext(false))) return;
    if (t.closest('.doc')) return;
    const row = t.closest('.r');
    if (!row || String(window.getSelection()).length) return;
    const id = Number(row.dataset.id);
    if (S.ctxExpanded.has(id)) S.ctxExpanded.delete(id); else S.ctxExpanded.add(id);
    renderContext(false);
  });
}
