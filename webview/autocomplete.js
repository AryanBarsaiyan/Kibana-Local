// Query-bar autocomplete (parsing lives in lib/kql.ts).
import { $, S, fieldKind, knownFields, vscode } from './state';
import { esc, quoteVal } from './lib/format';
import { FIELD_OK, KW, OPS, acContext, acTokens, matchNames } from './lib/kql';
import { search } from './query';

export function acItems(c, text) {
  const items = [];
  const fieldItem = (name) => {
    const kind = fieldKind(name);
    const ops = kind === '#' || kind === '◷';
    return { type: 'field', icon: kind, label: name, insert: ops ? name + ' ' : name + ':', detail: ops ? 'field · then pick an operator' : 'field', from: c.from, to: c.to, match: c.prefix || '' };
  };
  const kwItem = (kw, detail) => ({ type: 'conj', icon: 'kw', label: kw, insert: kw + ' ', detail, from: c.from, to: c.to });
  switch (c.kind) {
    case 'start': {
      for (const h of S.history.slice(0, 8)) items.push({ type: 'history', icon: '⟲', label: h, insert: h, detail: 'recent', from: 0, to: text.length });
      for (const f of knownFields().slice(0, 15)) items.push(fieldItem(f));
      break;
    }
    case 'field': {
      const p = c.prefix.toLowerCase();
      if (p) for (const kw of KW) if (kw.startsWith(p) && (kw === 'not' || c.afterTerm)) items.push(kwItem(kw, kw === 'not' ? 'exclude the next term' : 'combine terms'));
      for (const f of matchNames(knownFields(), c.prefix, 15)) if (f.toLowerCase() !== p) items.push(fieldItem(f));
      const t = text.trim();
      if (t && c.to === text.length) {
        for (const h of S.history.filter((x) => x !== t && x.toLowerCase().includes(t.toLowerCase())).slice(0, 3)) {
          items.push({ type: 'history', icon: '⟲', label: h, insert: h, detail: 'recent', from: 0, to: text.length, match: t });
        }
      }
      break;
    }
    case 'value': {
      const sg = S.sug && S.sug.field === c.field && S.sug.prefix === c.prefix ? S.sug : null;
      let vals;
      if (sg) vals = sg.values;
      else {
        // instant fallback from the sidebar's top values while the engine answers
        const st = S.result && S.result.fields.find((f) => f.name === c.field);
        const p = c.prefix.toLowerCase();
        vals = st ? st.top.filter((t) => t.v !== '' && t.v.toLowerCase().includes(p)) : [];
      }
      for (const v of vals) {
        if (v.v === c.prefix) continue;
        items.push({ type: 'value', icon: '', label: v.v, insert: (c.cmp && /^[\w.:\-+]+$/.test(v.v) ? v.v : quoteVal(v.v)) + ' ', detail: sg && sg.time ? '' : v.c.toLocaleString(), from: c.from, to: c.to, match: c.prefix });
      }
      if (!items.length && c.prefix === '' && sg) items.push({ type: 'hint', label: `No values of ${c.field} in the current range`, from: c.from, to: c.to });
      break;
    }
    case 'op': {
      const numeric = fieldKind(c.field) !== 't' && fieldKind(c.field) !== '◑';
      const ops = numeric ? OPS.slice(1).concat([OPS[0]]) : OPS;
      for (const [op, d] of ops) {
        items.push(op === ':'
          ? { type: 'op', icon: 'op', label: ':', insert: ':', detail: d, from: c.fieldEnd, to: c.to }
          : { type: 'op', icon: 'op', label: op, insert: op + ' ', detail: d, from: c.from, to: c.to });
      }
      items.push(kwItem('and', 'combine terms'), kwItem('or', 'either term'));
      break;
    }
    case 'conj':
      if (c.inGroup) {
        items.push(kwItem('or', 'any of these values'), kwItem('and', 'all of these values'));
        items.push({ type: 'conj', icon: 'kw', label: ')', insert: ') ', detail: 'close the value group', from: c.from, to: c.to });
      } else {
        items.push(kwItem('and', 'both terms'), kwItem('or', 'either term'), kwItem('and not', 'exclude the next term'));
      }
      break;
  }
  return items;
}

/** ask the engine for values; the callback runs only for the latest request of its kind */
export function requestSuggest(field, prefix, cb) {
  const token = ++S.sugToken;
  S.sugCbs.set(token, cb);
  vscode.postMessage({ type: 'suggest', token, field, prefix });
}
export let acTimer = null, acWant = null;
export function acUpdate(force) {
  const q = $('#q');
  if (document.activeElement !== q && !force) return;
  const text = q.value, pos = q.selectionStart ?? text.length;
  const c = acContext(text, pos, knownFields());
  if (c.kind === 'none' || (c.kind === 'start' && !force && !S.history.length)) { acClose(); return; }
  if (c.kind === 'value' && !(S.sug && S.sug.field === c.field && S.sug.prefix === c.prefix)) {
    const want = c.field + '\u0000' + c.prefix;
    if (acWant !== want) {
      acWant = want;
      clearTimeout(acTimer);
      acTimer = setTimeout(() => requestSuggest(c.field, c.prefix, (res) => {
        if (acWant !== want) return;
        S.sug = { field: c.field, prefix: c.prefix, values: res.values, time: res.time };
        acUpdate(false);
      }), 100);
    }
  }
  const items = acItems(c, text);
  // nothing to show yet: hide, but keep a pending value request so its answer can reopen the list
  if (!items.length) { acHide(); return; }
  const prevSel = S.ac && S.ac.sel >= 0 ? S.ac.items[S.ac.sel] : null;
  let sel = -1;
  if (prevSel) sel = items.findIndex((x) => x.label === prevSel.label && x.type === prevSel.type);
  S.ac = { items, sel, ctx: c };
  renderAc();
}
export function acClose() {
  clearTimeout(acTimer);
  acWant = null;
  acHide();
}
export function acHide() {
  if (!S.ac) return;
  S.ac = null;
  $('#ac').classList.add('hidden');
  $('#ac').replaceChildren();
  $('#q').setAttribute('aria-expanded', 'false');
  $('#q').removeAttribute('aria-activedescendant');
}
export const markMatch = (label, m) => {
  if (!m) return esc(label);
  const i = label.toLowerCase().indexOf(m.toLowerCase());
  return i < 0 ? esc(label) : esc(label.slice(0, i)) + '<b>' + esc(label.slice(i, i + m.length)) + '</b>' + esc(label.slice(i + m.length));
};
export function renderAc() {
  const el = $('#ac'), a = S.ac;
  el.innerHTML = a.items.map((it, i) => it.type === 'hint'
    ? `<div class="aci hint muted">${esc(it.label)}</div>`
    : `<div class="aci ${i === a.sel ? 'on' : ''} t-${it.type}" role="option" id="ac-${i}" data-aci="${i}" aria-selected="${i === a.sel}">
      <span class="acicon ${it.icon === 'kw' || it.icon === 'op' ? 'word' : ''}" aria-hidden="true">${esc(it.icon === 'kw' ? 'kw' : it.icon === 'op' ? 'op' : it.icon)}</span>
      <span class="acl">${markMatch(it.label, it.match)}</span><span class="acd">${esc(it.detail || '')}</span></div>`).join('') +
    `<div class="acfoot">↑↓ select · Tab or Enter accept · Esc close${a.ctx.kind === 'start' && S.history.length ? ' · <button class="linkbtn" id="acClearHist">clear recent</button>' : ''}</div>`;
  el.classList.remove('hidden');
  $('#q').setAttribute('aria-expanded', 'true');
  if (a.sel >= 0) {
    $('#q').setAttribute('aria-activedescendant', 'ac-' + a.sel);
    const on = el.querySelector('.aci.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  } else $('#q').removeAttribute('aria-activedescendant');
}
export function acMove(d) {
  const a = S.ac;
  const sel = a.items.map((it, i) => (it.type === 'hint' ? -1 : i)).filter((i) => i >= 0);
  if (!sel.length) return;
  const k = sel.indexOf(a.sel);
  a.sel = k < 0 ? (d > 0 ? sel[0] : sel[sel.length - 1]) : sel[(k + d + sel.length) % sel.length];
  renderAc();
}
export function acAccept(i) {
  const it = S.ac && S.ac.items[i];
  if (!it || it.type === 'hint') return;
  const q = $('#q');
  const text = q.value;
  let ins = it.insert;
  const before = text.slice(0, it.from);
  // keep terms apart: "a" + "and " → "a and "
  if (it.type !== 'history' && it.type !== 'value' && it.label !== ':' && before && !/[\s(]$/.test(before)) ins = ' ' + ins;
  const after = text.slice(it.to).replace(/^\s+/, (m) => (/\s$/.test(ins) ? '' : m));
  q.value = before + ins + after;
  const at = before.length + ins.length;
  q.setSelectionRange(at, at);
  if (it.type === 'history') { acClose(); return; }
  S.ac.sel = -1;
  acUpdate(true);
}

/** query box and dropdown events */
export function initAutocomplete() {
  $('#q').addEventListener('keydown', (e) => {
    const open = !!S.ac;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { if (e.key === 'ArrowDown') acUpdate(true); if (S.ac) acMove(1); return; }
      acMove(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && open && S.ac.items.some((it) => it.type !== 'hint')) {
      e.preventDefault();
      acAccept(S.ac.sel >= 0 ? S.ac.sel : S.ac.items.findIndex((it) => it.type !== 'hint'));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && S.ac.sel >= 0) { acAccept(S.ac.sel); return; }
      search();
      return;
    }
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); acClose(); }
  });
  $('#q').addEventListener('input', (e) => {
    // "field :" (after accepting a numeric/time field, which leaves a space) → "field:"
    const q = $('#q'), pos = q.selectionStart;
    if (e.data === ':' && pos >= 3 && q.value.slice(pos - 2, pos) === ' :' && /[\w@.-]$/.test(q.value.slice(0, pos - 2))) {
      const w = acTokens(q.value.slice(0, pos - 2)).pop();
      if (w && w.t === 'word' && FIELD_OK.test(w.v) && w.e === pos - 2) {
        q.value = q.value.slice(0, pos - 2) + ':' + q.value.slice(pos);
        q.setSelectionRange(pos - 1, pos - 1);
      }
    }
    acUpdate(false);
  });
  $('#q').addEventListener('focus', () => { if (!$('#q').value) acUpdate(false); });
  $('#q').addEventListener('click', () => acUpdate(true));
  $('#q').addEventListener('keyup', (e) => { if (S.ac && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) acUpdate(false); });
  $('#q').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('#q')) acClose(); }, 120));
  // mousedown (not click) so the input keeps focus
  $('#ac').addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (e.target.closest('#acClearHist')) { S.history = []; vscode.postMessage({ type: 'clearHistory' }); acClose(); return; }
    const it = e.target.closest('[data-aci]');
    if (it) acAccept(Number(it.dataset.aci));
  });
  document.addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (e.key === '/' && !(a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName))) { e.preventDefault(); $('#q').focus(); }
  });
}
