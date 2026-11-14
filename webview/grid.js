// Results: index chips, meta line, histogram, virtualized grid, expanded docs, field sidebar.
import { $, DOC_GUESS, OVERSCAN, ROW_H, S, activeIndexes, det, fieldKind, vscode } from './state';
import { esc, fmtBytes, fmtShort, fmtTs, levelClass, own, showVal, toLocalInput } from './lib/format';
import { compileHl, highlight } from './lib/highlight';
import { effSort, indexAt as indexAtRows, topOf as topOfRows } from './lib/grid';
import { spacer, vp } from './layout';
import { clickSort, colLabel, columns, gridTemplate, isMsgCol, resolveCol, showIndexCol, showTime, sortLabel, toggleColumn } from './columns';
import { search, sendQuery } from './query';
import { addFilter, renderFilters } from './filters';
import { ctxHits, openContext } from './context';
import { renderUsage } from './settings';

export const hl = (text, field) => highlight(S.hl, text, field);
export const topOf = (i, ex) => topOfRows(i, ex, ROW_H);
export const indexAt = (y, ex) => indexAtRows(y, ex, ROW_H);

// ---------- virtual list geometry ----------
// Collapsed rows are ROW_H tall; expanded rows add a measured doc height.
export function extras() {
  const out = [];
  if (!S.expanded.size) return out;
  S.rows.forEach((h, i) => {
    if (h && S.expanded.has(h.id)) out.push({ i, extra: S.docHeights.get(h.id) ?? DOC_GUESS });
  });
  return out; // forEach on a sparse array visits in index order
}

export function requestPage(i) {
  const offset = Math.floor(i / S.pageSize) * S.pageSize;
  if (S.requested.has(offset)) return;
  S.requested.add(offset);
  vscode.postMessage({ type: 'page', seq: S.seq, offset });
}

// ---------- render ----------
export function renderIndexes() {
  const el = $('#indexes');
  if (!S.sources.length) { el.innerHTML = '<span class="muted">No indexes yet — add a log file or folder →</span>'; return; }
  const sel = new Set(S.ui.indexes);
  el.innerHTML = `<button class="chip ${sel.size ? '' : 'on'}" data-all="1" aria-pressed="${!sel.size}">All</button>` +
    S.sources.map((s) => `<span class="chip ${sel.has(s.name) ? 'on' : ''}" role="group">
      <button class="chipbtn" data-idx="${esc(s.name)}" aria-pressed="${sel.has(s.name)}" title="${esc(s.path)} — Ctrl/Cmd-click to multi-select">${s.kind === 'folder' ? '📁' : '📄'} ${esc(s.name)}</button>
      <button class="x" data-rm="${esc(s.name)}" aria-label="Remove index ${esc(s.name)}">×</button></span>`).join('');
}

export function renderMeta() {
  const r = S.result;
  if (!r) { $('#meta').innerHTML = ''; return; }
  const idx = activeIndexes();
  const detTxt = idx.map((i) => { const d = det(i); return `${i}: time=${d.ts ?? '—'} level=${d.level ?? '—'} msg=${d.msg ?? '—'}`; }).join('\n');
  const d0 = det(idx[0]);
  const label = idx.length === 1
    ? `time <code>${esc(d0.ts ?? 'not detected')}</code> · level <code>${esc(d0.level ?? '—')}</code> · message <code>${esc(d0.msg ?? '—')}</code>`
    : `fields detected per index`;
  $('#meta').innerHTML = `<b>${r.total.toLocaleString()}</b> hits
    <span class="muted">of ${r.scanned.toLocaleString()} lines · ${r.tookMs} ms · ~${fmtBytes(r.memoryBytes)} in memory</span>
    ${S.ui.sort && S.ui.sort.length ? `<span class="sortinfo">sorted by ${S.ui.sort.map((k) => `${esc(sortLabel(k.field))} ${k.dir === 'asc' ? '▲' : '▼'}`).join(', ')}
      <button class="linkbtn" id="resetSort">reset to newest first</button></span>` : ''}
    <span class="muted det" title="${esc(detTxt)}">${label}</span>`;
  const qe = $('#qerr');
  if (r.error) { qe.textContent = r.error; qe.classList.remove('hidden'); $('#q').classList.add('bad'); $('#q').setAttribute('aria-invalid', 'true'); }
  else { qe.classList.add('hidden'); $('#q').classList.remove('bad'); $('#q').removeAttribute('aria-invalid'); }
  renderUsage();
}

export function renderHist() {
  const h = S.result && S.result.histogram;
  const el = $('#hist'), ax = $('#histaxis');
  el.replaceChildren(); ax.replaceChildren();
  const show = !!h && h.counts.length >= 2;
  el.classList.toggle('hidden', !show); ax.classList.toggle('hidden', !show);
  if (!show) return;
  const max = Math.max(...h.counts, 1);
  h.counts.forEach((c, i) => {
    const t = h.start + i * h.bucketMs;
    const b = document.createElement('button');
    b.className = 'bar';
    b.dataset.i = String(i);
    b.title = `${fmtTs(t)}\n${c.toLocaleString()} hits`;
    b.setAttribute('aria-label', `${fmtTs(t)}: ${c} hits`);
    const fill = document.createElement('div');
    fill.style.height = c ? Math.max(4, (c / max) * 100) + '%' : '0';
    b.appendChild(fill);
    el.appendChild(b);
  });
  const n = h.counts.length;
  for (const i of [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1]) {
    const s = document.createElement('span');
    s.textContent = fmtShort(h.start + i * h.bucketMs, h.bucketMs);
    s.style.left = (i / Math.max(n - 1, 1)) * 100 + '%';
    ax.appendChild(s);
  }
}

export function headCells(sortable) {
  const s = effSort(S.ui.sort);
  const cell = (field, label, extra) => {
    if (!sortable) return `<div role="columnheader">${esc(label)}${extra}</div>`;
    const i = s.findIndex((x) => x.field === field);
    const k = s[i];
    const ind = k
      ? `<span class="sortind" aria-hidden="true">${k.dir === 'asc' ? '▲' : '▼'}${s.length > 1 ? `<sub>${i + 1}</sub>` : ''}</span>`
      : '<span class="sortind idle" aria-hidden="true">⇅</span>';
    return `<div role="columnheader" aria-sort="${k ? (k.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">` +
      `<button class="sorth" data-sort="${esc(field)}" title="Sort by ${esc(label)}. Shift-click to add it as a secondary sort.">${esc(label)} ${ind}</button>${extra}</div>`;
  };
  const cells = ['<div role="columnheader"></div>'];
  if (showTime()) cells.push(cell('@timestamp', 'Time', ''));
  if (showIndexCol()) cells.push(cell('_index', '_index', ''));
  for (const c of columns()) {
    if (c === '_source') { cells.push('<div role="columnheader">_source</div>'); continue; }
    const rm = sortable ? ` <button class="rmcol" data-rmcol="${esc(c)}" aria-label="Remove column ${esc(c)}">×</button>` : '';
    cells.push(cell(c, colLabel(c), rm));
  }
  return cells.join('');
}

export function renderHeader() {
  const gh = $('#ghead');
  if (!S.result || !S.result.total) { gh.replaceChildren(); return; }
  gh.style.gridTemplateColumns = gridTemplate();
  gh.style.paddingRight = vp.offsetWidth - vp.clientWidth + 'px';
  gh.innerHTML = headCells(true);
}

export function cellHtml(h, col) {
  if (col === '_source') {
    const parts = [];
    for (const k in h.flat) { if (parts.length >= 30) break; parts.push(`<span class="sk">${esc(k)}:</span> ${hl(showVal(h.flat[k]), k)}`); }
    return parts.join(' ');
  }
  col = resolveCol(h, col);
  if (!col) return '<span class="muted">-</span>';
  const v = col === '_index' ? h.index : col === '_file' ? h.file : own(h.flat, col);
  if (v === undefined) return '<span class="muted">-</span>';
  if (det(h.index).level === col) return `<span class="lvl ${levelClass(v)}">${hl(showVal(v), col)}</span>`;
  return hl(showVal(v), col);
}

export function rowHtml(h, expanded = S.expanded) {
  const open = expanded.has(h.id);
  const cells = [`<div class="c exp" aria-hidden="true">${open ? '▾' : '▸'}</div>`];
  if (showTime()) cells.push(`<div class="c time" role="gridcell">${esc(fmtTs(h.ts))}</div>`);
  if (showIndexCol()) cells.push(`<div class="c" role="gridcell"><span class="idxtag">${hl(h.index, '_index')}</span></div>`);
  for (const c of columns()) cells.push(`<div class="c ${isMsgCol(c) ? 'msg' : ''}" role="gridcell">${cellHtml(h, c)}</div>`);
  return `<div class="cells">${cells.join('')}</div>${open ? `<div class="doc">${docHtml(h)}</div>` : ''}`;
}

export let renderQueued = false;
export function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderRows(false); });
}

/** @param {boolean} force rebuild every visible row (columns/expansion changed) */
export function renderRows(force) {
  const r = S.result;
  const empty = $('#empty');
  if (!S.sources.length || !r || !r.total) {
    spacer.replaceChildren();
    spacer.style.height = '0';
    vp.setAttribute('aria-rowcount', '0');
    empty.classList.remove('hidden');
    empty.innerHTML = !S.sources.length
      ? `<h3>Local Kibana for your log files</h3><p>Click <b>+ Index</b> and give it the path of a JSON-lines log file (or a folder of them).<br>New lines stream in live as your service writes them.</p>`
      : r && r.error ? '' : '<p class="muted">No results match your search.</p>';
    return;
  }
  empty.classList.add('hidden');
  vp.setAttribute('aria-rowcount', String(r.total));
  const ex = extras();
  const total = r.total;
  spacer.style.height = topOf(total, ex) + 'px';
  const tpl = gridTemplate();
  const first = Math.max(0, indexAt(vp.scrollTop, ex) - OVERSCAN);
  const last = Math.min(total - 1, indexAt(vp.scrollTop + vp.clientHeight, ex) + OVERSCAN);

  const keep = new Map();
  for (const el of [...spacer.children]) {
    const i = Number(el.dataset.i);
    if (!force && i >= first && i <= last && el.dataset.id === String(S.rows[i] ? S.rows[i].id : 'ph')) keep.set(i, el);
    else el.remove();
  }
  for (let i = first; i <= last; i++) {
    let el = keep.get(i);
    const h = S.rows[i];
    if (!el) {
      el = document.createElement('div');
      el.dataset.i = String(i);
      el.id = 'r-' + i;
      el.setAttribute('role', 'row');
      el.setAttribute('aria-rowindex', String(i + 1));
      if (h) {
        el.dataset.id = String(h.id);
        const open = S.expanded.has(h.id);
        const lv = levelClass(own(h.flat, det(h.index).level));
        el.className = `r ${lv ? 'row-' + lv : ''} ${open ? 'open' : ''}`;
        el.setAttribute('aria-expanded', String(open));
        el.innerHTML = rowHtml(h);
      } else {
        el.dataset.id = 'ph';
        el.className = 'r ph';
        el.innerHTML = '<div class="cells"><div class="c"></div><div class="c muted">loading…</div></div>';
        requestPage(i);
      }
      spacer.appendChild(el);
    }
    el.classList.toggle('focus', i === S.focus);
    el.style.top = topOf(i, ex) + 'px';
    const cells = el.firstElementChild;
    if (cells) cells.style.gridTemplateColumns = tpl;
  }
  vp.setAttribute('aria-activedescendant', S.focus >= first && S.focus <= last ? 'r-' + S.focus : '');

  // measure expanded docs; re-layout once if the guess was off
  let changed = false;
  for (const el of spacer.querySelectorAll('.r.open')) {
    const id = Number(el.dataset.id);
    const extra = el.offsetHeight - ROW_H;
    if (S.docHeights.get(id) !== extra) { S.docHeights.set(id, extra); changed = true; }
  }
  if (changed) {
    const ex2 = extras();
    spacer.style.height = topOf(total, ex2) + 'px';
    for (const el of spacer.children) el.style.top = topOf(Number(el.dataset.i), ex2) + 'px';
  }
}

export function docHtml(h) {
  const tab = S.docTab.get(h.id) || 'table';
  const head = `<div class="doctabs" role="tablist">
    <button class="tab ${tab === 'table' ? 'on' : ''}" role="tab" aria-selected="${tab === 'table'}" data-tab="table" data-id="${h.id}">Table</button>
    <button class="tab ${tab === 'json' ? 'on' : ''}" role="tab" aria-selected="${tab === 'json'}" data-tab="json" data-id="${h.id}">JSON</button>
    <span class="spacer"></span>
    <button class="btn ghost tiny" data-surround="${h.id}" title="Show the entries logged just before and after this one">View surrounding documents</button>
    <button class="btn ghost tiny" data-copy="${h.id}">Copy JSON</button>
    <span class="muted">${esc(h.index)} · ${esc(h.file)}</span></div>`;
  if (tab === 'json') {
    let pretty;
    const first = h.raw.split('\n')[0];
    try { pretty = h.isJson ? JSON.stringify(JSON.parse(first.slice(first.indexOf('{'))), null, 2) : h.raw; } catch { pretty = h.raw; }
    const cont = h.isJson && own(h.flat, '_continuation') ? '\n\n' + own(h.flat, '_continuation') : '';
    return head + `<pre class="json">${hl(pretty + cont, null)}</pre>`;
  }
  const cols = columns();
  const lvf = det(h.index).level;
  const rows = Object.keys(h.flat).map((k) => {
    const v = h.flat[k];
    const jv = esc(JSON.stringify(v));
    return `<tr>
    <td class="acts">
      <button class="act" data-f="${esc(k)}" data-v="${jv}" data-neg="0" aria-label="Filter for ${esc(k)} value" title="Filter for value">⊕</button><button class="act" data-f="${esc(k)}" data-v="${jv}" data-neg="1" aria-label="Filter out ${esc(k)} value" title="Filter out value">⊖</button><button class="act ${cols.includes(k) ? 'on' : ''}" data-col="${esc(k)}" aria-label="Toggle column ${esc(k)}" title="Toggle column">▦</button><button class="act" data-exists="${esc(k)}" aria-label="Filter for ${esc(k)} present" title="Field present">∃</button>
    </td><th scope="row" class="fk">${esc(k)}</th><td class="fv ${k === lvf ? levelClass(v) : ''}">${hl(showVal(v), k)}</td></tr>`;
  }).join('');
  return head + `<table class="doctbl">${rows}</table>`;
}

export function renderFields() {
  const r = S.result;
  const el = $('#fields');
  if (!r) { el.innerHTML = ''; return; }
  const cols = columns().slice();
  for (const i of activeIndexes()) {
    const d = det(i);
    if (cols.includes('_level') && d.level) cols.push(d.level);
    if (cols.includes('_message') && d.msg) cols.push(d.msg);
  }
  const f = S.fieldFilter.toLowerCase();
  const list = r.fields.filter((x) => !f || x.name.toLowerCase().includes(f));
  const sel = list.filter((x) => cols.includes(x.name));
  const rest = list.filter((x) => !cols.includes(x.name));
  const sample = Math.max(r.fieldSample, 1);
  const tsFields = new Set(activeIndexes().map((i) => det(i).ts).filter(Boolean));
  const item = (x) => {
    const open = S.openField === x.name;
    const on = cols.includes(x.name);
    let body = '';
    if (open) {
      const maxC = x.top.length ? x.top[0].c : 1;
      body = `<div class="fdet">${x.top.length ? x.top.map((t) => {
        const jv = esc(JSON.stringify(t.v));
        return `<div class="tv"><span class="tvv" title="${esc(t.v)}">${esc(t.v === '' ? '(empty)' : t.v)}</span>
          <span class="tvp">${Math.round((t.c / sample) * 100)}%</span>
          <button class="act" data-f="${esc(x.name)}" data-v="${jv}" data-neg="0" aria-label="Filter for ${esc(t.v)}">⊕</button><button class="act" data-f="${esc(x.name)}" data-v="${jv}" data-neg="1" aria-label="Filter out ${esc(t.v)}">⊖</button>
          <div class="tvbar"><div data-w="${(t.c / maxC) * 100}"></div></div></div>`;
      }).join('') : '<div class="muted">No common values</div>'}
        <div class="fdetfoot muted">In ${Math.round((x.count / Math.max(r.total, 1)) * 100)}% of hits${r.fieldSample < r.total ? ` · top values from the first ${r.fieldSample.toLocaleString()}` : ''}</div></div>`;
    }
    const icon = tsFields.has(x.name) ? '◷' : fieldKind(x.name, x);
    return `<div class="field ${open ? 'open' : ''}">
      <div class="fname" role="button" tabindex="0" aria-expanded="${open}" data-field="${esc(x.name)}">
        <span class="ftype" aria-hidden="true">${icon}</span><span class="fn">${esc(x.name)}</span>
        <button class="colbtn ${on ? 'on' : ''}" data-col="${esc(x.name)}" aria-label="${on ? 'Remove' : 'Add'} column ${esc(x.name)}">${on ? '−' : '+'}</button>
      </div>${body}</div>`;
  };
  el.innerHTML = (sel.length ? `<div class="fsec">Selected fields</div>${sel.map(item).join('')}` : '') +
    `<div class="fsec">Available fields <span class="muted">${rest.length}</span></div>${rest.map(item).join('')}`;
  for (const b of el.querySelectorAll('[data-w]')) b.style.width = b.dataset.w + '%';
}

export function renderPending() {
  const b = $('#pending');
  const show = S.ui.mode !== 'live' && S.pending > 0;
  b.textContent = show ? '+' + S.pending.toLocaleString() : '';
  b.classList.toggle('hidden', !show);
}

export function renderAll() {
  renderIndexes(); renderFilters(); renderMeta(); renderHist(); renderHeader(); renderRows(true); renderFields(); renderPending();
}

// ---------- results ----------
export function applyResult(seq, r) {
  const prev = S.result;
  S.seq = seq;
  S.result = r;
  S.detected = r.detected || {};
  S.hl = compileHl(r.highlight);
  S.pending = 0;
  S.requested = new Set([0]);
  const old = S.rows;
  S.rows = [];
  r.hits.forEach((h, i) => { S.rows[i] = h; });
  if (!r.reset && prev && r.prepended > 0) {
    // keep already-loaded rows (shifted) and keep the user's viewport stable if they scrolled away from the top
    old.forEach((h, i) => { const j = i + r.prepended; if (j >= r.hits.length && j < r.total) S.rows[j] = h; });
    if (vp.scrollTop > 0) vp.scrollTop += r.prepended * ROW_H;
    if (S.focus >= 0) S.focus += r.prepended;
  } else if (r.reset) {
    vp.scrollTop = 0;
    S.focus = -1;
    S.docHeights.clear();
  }
  if (S.focus >= r.total) S.focus = r.total - 1;
  renderAll();
}

export function applyPage(seq, offset, hits) {
  if (seq !== S.seq) return;
  hits.forEach((h, k) => { S.rows[offset + k] = h; });
  renderRows(false);
}

export function moveFocus(i) {
  const r = S.result;
  if (!r || !r.total) return;
  S.focus = Math.max(0, Math.min(r.total - 1, i));
  const ex = extras();
  const top = topOf(S.focus, ex);
  if (top < vp.scrollTop) vp.scrollTop = top;
  else if (top + ROW_H > vp.scrollTop + vp.clientHeight) vp.scrollTop = top + ROW_H - vp.clientHeight;
  renderRows(false);
}
export function toggleExpand(i) {
  const h = S.rows[i];
  if (!h) return;
  if (S.expanded.has(h.id)) S.expanded.delete(h.id); else S.expanded.add(h.id);
  S.focus = i;
  renderRows(true);
}

export function handleActs(t) {
  const a = t.closest('[data-f]');
  if (a) { addFilter(a.dataset.f, JSON.parse(a.dataset.v), a.dataset.neg === '1'); return true; }
  const ex = t.closest('[data-exists]');
  if (ex) { addFilter(ex.dataset.exists, undefined, false); return true; }
  const c = t.closest('[data-col]');
  if (c) { toggleColumn(c.dataset.col); return true; }
  return false;
}

export const findHit = (id) => S.rows.find((x) => x && String(x.id) === id) || ctxHits().find((x) => String(x.id) === id);
/** doc-view buttons shared by the results grid and the surrounding-documents list */
export function handleDocButtons(t, rerender) {
  const tab = t.closest('[data-tab]');
  if (tab) { S.docTab.set(Number(tab.dataset.id), tab.dataset.tab); rerender(); return true; }
  const cp = t.closest('[data-copy]');
  if (cp) {
    const h = findHit(cp.dataset.copy);
    if (h) vscode.postMessage({ type: 'copy', text: h.raw });
    return true;
  }
  const sd = t.closest('[data-surround]');
  if (sd) {
    const id = Number(sd.dataset.surround);
    const origin = S.ctx ? S.ctx.origin : id;
    openContext(id);
    S.ctx.origin = origin;
    return true;
  }
  return false;
}

export function initGrid() {
  vp.addEventListener('keydown', (e) => {
    if (e.target !== vp) return;
    const page = Math.max(1, Math.floor(vp.clientHeight / ROW_H) - 1);
    const map = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, j: 1, k: -1 };
    if (e.key in map) { e.preventDefault(); moveFocus((S.focus < 0 ? -1 : S.focus) + map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); moveFocus(0); }
    else if (e.key === 'End') { e.preventDefault(); moveFocus(Infinity); }
    else if ((e.key === 'Enter' || e.key === ' ') && S.focus >= 0) { e.preventDefault(); toggleExpand(S.focus); }
  });
  vp.addEventListener('focus', () => { if (S.focus < 0 && S.result && S.result.total) moveFocus(0); });
  vp.addEventListener('scroll', scheduleRender, { passive: true });
  new ResizeObserver(() => { renderHeader(); scheduleRender(); }).observe(vp);
  $('#fieldFilter').addEventListener('input', (e) => { S.fieldFilter = e.target.value; renderFields(); });

  $('#indexes').addEventListener('click', (e) => {
    const t = e.target;
    const rm = t.closest('[data-rm]');
    if (rm) { vscode.postMessage({ type: 'remove', name: rm.dataset.rm }); return; }
    if (t.closest('[data-all]')) { S.ui.indexes = []; renderIndexes(); search(); return; }
    const c = t.closest('[data-idx]');
    if (!c) return;
    const n = c.dataset.idx;
    if (e.metaKey || e.ctrlKey || e.shiftKey) S.ui.indexes = S.ui.indexes.includes(n) ? S.ui.indexes.filter((x) => x !== n) : [...S.ui.indexes, n];
    else S.ui.indexes = S.ui.indexes.length === 1 && S.ui.indexes[0] === n ? [] : [n];
    renderIndexes();
    search();
  });

  $('#hist').addEventListener('click', (e) => {
    const b = e.target.closest('.bar');
    const h = S.result && S.result.histogram;
    if (!b || !h) return;
    const from = h.start + Number(b.dataset.i) * h.bucketMs;
    $('#range').value = 'custom';
    $('#custom').classList.remove('hidden');
    $('#from').value = toLocalInput(from);
    $('#to').value = toLocalInput(from + h.bucketMs - 1);
    search();
  });
  $('#ghead').addEventListener('click', (e) => {
    const rc = e.target.closest('[data-rmcol]');
    if (rc) { toggleColumn(rc.dataset.rmcol); return; }
    const sb = e.target.closest('[data-sort]');
    if (sb) clickSort(sb.dataset.sort, e.shiftKey);
  });
  $('#meta').addEventListener('click', (e) => {
    if (e.target.closest('#resetSort')) { S.ui.sort = []; sendQuery(); renderHeader(); }
  });
  vp.addEventListener('click', (e) => {
    const t = e.target;
    if (handleActs(t)) return;
    if (handleDocButtons(t, () => renderRows(true))) return;
    if (t.closest('.doc')) return;
    const row = t.closest('.r');
    if (!row || row.classList.contains('ph')) return;
    if (String(window.getSelection()).length) return; // let users select text without toggling
    toggleExpand(Number(row.dataset.i));
  });

  const fieldsEl = $('#fields');
  fieldsEl.addEventListener('click', (e) => {
    if (handleActs(e.target)) return;
    const f = e.target.closest('[data-field]');
    if (f) { S.openField = S.openField === f.dataset.field ? null : f.dataset.field; renderFields(); }
  });
  fieldsEl.addEventListener('keydown', (e) => {
    const f = e.target.closest && e.target.closest('.fname');
    if (f && e.target === f && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      S.openField = S.openField === f.dataset.field ? null : f.dataset.field;
      renderFields();
      const again = fieldsEl.querySelector(`.fname[data-field="${CSS.escape(f.dataset.field)}"]`);
      if (again) again.focus();
    }
  });
}
