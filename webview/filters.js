// Filter pills, their menus and the filter editor.
import { $, S, knownFields } from './state';
import { esc } from './lib/format';
import { FIELD_OK } from './lib/kql';
import { FILTER_OPS, addOrUpdateFilter, filterText } from './lib/grid';
import { sendQuery } from './query';
import { requestSuggest } from './autocomplete';
import { requestContext } from './context';

export function filtersChanged() {
  renderFilters();
  sendQuery();
  if (S.ctx) requestContext();
}
/** ⊕ / ⊖ / ∃: like Kibana, re-adding an existing filter updates it instead of duplicating it */
export function addFilter(field, value, negate) {
  addOrUpdateFilter(S.ui.filters, field, value, negate);
  filtersChanged();
}
export function renderFilters() {
  const fs = S.ui.filters || [];
  const pills = fs.map((f, i) => {
    const txt = filterText(f);
    const state = `${f.negate ? 'excluding' : 'including'}${f.disabled ? ', disabled' : ''}`;
    return `<span class="pill ${f.negate ? 'neg' : ''} ${f.disabled ? 'off' : ''}">
      <button class="pillbtn" data-pill="${i}" aria-haspopup="menu" title="${esc((f.negate ? 'NOT ' : '') + txt)} (${state}). Click for actions.">${f.negate ? '<b class="not">NOT</b> ' : ''}${esc(txt)}</button>
      <button class="x" data-pillrm="${i}" aria-label="Remove filter ${esc(txt)}">×</button></span>`;
  }).join('');
  $('#filterbar').innerHTML =
    (fs.length ? '<button class="btn ghost tiny" id="filtersMenu" aria-haspopup="menu" aria-label="Actions for all filters" title="Actions for all filters">☰</button>' : '') +
    pills + '<button class="btn ghost tiny" id="addFilterBtn">+ Add filter</button>';
}

// ---------- popover (filter menus and editor) ----------
export let popReturn = null;
export function openPop(anchor, html) {
  const pop = $('#pop');
  pop.innerHTML = html;
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = r.bottom + 4 + 'px';
  popReturn = anchor;
  const first = pop.querySelector('input:not([type=hidden]), select, textarea, button');
  if (first) first.focus();
}
export function closePop(restoreFocus) {
  const pop = $('#pop');
  if (pop.classList.contains('hidden')) return;
  pop.classList.add('hidden');
  pop.replaceChildren();
  if (restoreFocus && popReturn && document.body.contains(popReturn)) popReturn.focus();
  popReturn = null;
}
export const menuHtml = (items) => `<div class="menu" role="menu">${items.map(([act, label]) => `<button role="menuitem" data-act="${act}">${esc(label)}</button>`).join('')}</div>`;
export function pillMenu(i, anchor) {
  const f = S.ui.filters[i];
  openPop(anchor, menuHtml([
    ['edit:' + i, 'Edit filter'],
    ['neg:' + i, f.negate ? 'Include results' : 'Exclude results'],
    ['dis:' + i, f.disabled ? 'Re-enable' : 'Temporarily disable'],
    ['del:' + i, 'Delete'],
  ]));
}
export function allMenu(anchor) {
  openPop(anchor, menuHtml([
    ['all:on', 'Enable all'], ['all:off', 'Disable all'], ['all:inv', 'Invert inclusion'], ['all:del', 'Remove all'],
  ]));
}
export function filterEditor(i, anchor) {
  const f = i >= 0 ? S.ui.filters[i] : { field: '', op: 'is', value: '', negate: false, disabled: false };
  const opKey = (FILTER_OPS.find((o) => o[1] === f.op && o[2] === !!f.negate) || FILTER_OPS[0])[0];
  const names = new Set(knownFields());
  $('#fieldNames').innerHTML = [...names].map((n) => `<option value="${esc(n)}"></option>`).join('');
  const val = f.op === 'is' ? (f.value === null ? 'null' : f.value ?? '') : f.op === 'is_one_of' ? (f.values || []).join(', ') : '';
  openPop(anchor, `<form class="fedit" id="fedit" aria-label="${i >= 0 ? 'Edit' : 'Add'} filter">
    <div class="fedrow"><label class="fedf">Field<input id="feField" list="fieldNames" spellcheck="false" value="${esc(f.field || '')}" placeholder="e.g. level"></label>
      <label class="fedo">Operator<select id="feOp">${FILTER_OPS.map(([k, , , l]) => `<option value="${k}" ${k === opKey ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
    <label class="fedv" data-for="is is_not">Value<input id="feVal" list="valueNames" autocomplete="off" spellcheck="false" value="${esc(val)}"></label>
    <label class="fedv" data-for="is_one_of is_not_one_of"><span>Values <span class="muted">(comma-separated)</span></span><input id="feVals" spellcheck="false" value="${esc(val)}"></label>
    <div class="fedv fedrow" data-for="between not_between"><label>From<input id="feGte" spellcheck="false" value="${esc(f.gte || '')}" placeholder="number or 2026-11-13T10:00"></label>
      <label>To<input id="feLte" spellcheck="false" value="${esc(f.lte || '')}" placeholder="number or date"></label></div>
    <label class="fedv" data-for="query not_query">KQL query<textarea id="feQuery" rows="2" spellcheck="false">${esc(f.query || '')}</textarea></label>
    <label><span>Custom label <span class="muted">(optional)</span></span><input id="feLabel" value="${esc(f.label || '')}"></label>
    <div class="fedact"><span class="feerr" id="feErr" role="alert"></span><span class="spacer"></span>
      <button type="button" class="btn ghost" id="feCancel">Cancel</button><button type="submit" class="btn primary">${i >= 0 ? 'Save' : 'Add filter'}</button></div>
  </form>`);
  const form = $('#fedit');
  const sync = () => {
    const k = $('#feOp').value;
    for (const el of form.querySelectorAll('.fedv')) el.classList.toggle('hidden', !el.dataset.for.split(' ').includes(k));
    $('#feField').closest('label').classList.toggle('hidden', k === 'query' || k === 'not_query');
  };
  sync();
  $('#feOp').onchange = sync;
  // value suggestions for the chosen field
  let feTimer = null;
  const feSuggest = () => {
    clearTimeout(feTimer);
    const field = $('#feField') && $('#feField').value.trim();
    if (!field || !FIELD_OK.test(field)) return;
    feTimer = setTimeout(() => requestSuggest(field, $('#feVal').value, (res) => {
      const dl = $('#valueNames');
      if (dl) dl.innerHTML = res.values.map((v) => `<option value="${esc(v.v)}"></option>`).join('');
    }), 100);
  };
  $('#valueNames').replaceChildren();
  $('#feVal').addEventListener('focus', feSuggest);
  $('#feVal').addEventListener('input', feSuggest);
  $('#feField').addEventListener('change', () => { $('#valueNames').replaceChildren(); });
  $('#feCancel').onclick = () => closePop(true);
  form.onsubmit = (e) => {
    e.preventDefault();
    const [, op, negate] = FILTER_OPS.find((o) => o[0] === $('#feOp').value);
    const nf = { field: $('#feField').value.trim(), op, negate, disabled: i >= 0 ? !!f.disabled : false };
    const label = $('#feLabel').value.trim();
    if (label) nf.label = label;
    let err = '';
    if (op !== 'query' && !/^[A-Za-z_@][\w.@-]*$/.test(nf.field)) err = 'Enter a field name';
    else if (op === 'is') { const v = $('#feVal').value; nf.value = v === 'null' ? null : v; }
    else if (op === 'is_one_of') { nf.values = $('#feVals').value.split(',').map((x) => x.trim()).filter(Boolean); if (!nf.values.length) err = 'Enter at least one value'; }
    else if (op === 'between') { nf.gte = $('#feGte').value.trim(); nf.lte = $('#feLte').value.trim(); if (!nf.gte && !nf.lte) err = 'Enter a start or an end'; }
    else if (op === 'query') { nf.field = ''; nf.query = $('#feQuery').value.trim(); if (!nf.query) err = 'Enter a query'; }
    if (err) { $('#feErr').textContent = err; return; }
    if (i >= 0) S.ui.filters[i] = nf; else S.ui.filters.push(nf);
    closePop(false);
    filtersChanged();
    $('#addFilterBtn').focus();
  };
}
export function popAction(act) {
  const [a, arg] = act.split(':');
  const fs = S.ui.filters;
  const i = Number(arg);
  if (a === 'edit') { const anchor = popReturn; closePop(false); filterEditor(i, anchor && document.body.contains(anchor) ? anchor : $('#addFilterBtn')); return; }
  if (a === 'neg') fs[i].negate = !fs[i].negate;
  else if (a === 'dis') fs[i].disabled = !fs[i].disabled;
  else if (a === 'del') fs.splice(i, 1);
  else if (a === 'all') {
    if (arg === 'del') fs.length = 0;
    else for (const f of fs) { if (arg === 'on') f.disabled = false; else if (arg === 'off') f.disabled = true; else f.negate = !f.negate; }
  }
  closePop(false);
  filtersChanged();
  $('#addFilterBtn').focus();
}

export function initFilters() {
  $('#filterbar').addEventListener('click', (e) => {
    const t = e.target;
    const rm = t.closest('[data-pillrm]');
    if (rm) { S.ui.filters.splice(Number(rm.dataset.pillrm), 1); filtersChanged(); $('#addFilterBtn').focus(); return; }
    const pb = t.closest('[data-pill]');
    if (pb) { pillMenu(Number(pb.dataset.pill), pb); return; }
    if (t.closest('#filtersMenu')) { allMenu(t.closest('#filtersMenu')); return; }
    if (t.closest('#addFilterBtn')) filterEditor(-1, t.closest('#addFilterBtn'));
  });
  $('#pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) popAction(b.dataset.act);
  });
  $('#pop').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(true); return; }
    const items = [...$('#pop').querySelectorAll('[role=menuitem]')];
    if (!items.length || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  });
  document.addEventListener('mousedown', (e) => {
    if (!$('#pop').contains(e.target) && !/** @type {Element} */ (e.target).closest('[data-pill], #filtersMenu, #addFilterBtn')) closePop(false);
  });
  window.addEventListener('resize', () => closePop(false));
}
