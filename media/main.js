// KibanaLocal webview. No inline styles in HTML strings: the CSP has no 'unsafe-inline',
// so every dynamic style is set through the DOM (el.style.*), which CSP permits.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ROW_H = 24;
  const OVERSCAN = 12;
  const DOC_GUESS = 280;
  const RANGES = [
    ['all', 'All time'], ['5m', 'Last 5 minutes'], ['15m', 'Last 15 minutes'], ['1h', 'Last 1 hour'],
    ['4h', 'Last 4 hours'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['custom', 'Custom…'],
  ];
  const RANGE_MS = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '24h': 864e5, '7d': 6048e5 };

  const S = {
    sources: [],
    ui: { q: '', indexes: [], range: { kind: 'all' }, columns: null, mode: 'live' },
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
  };

  // ---------- layout ----------
  $('#app').innerHTML = `
  <header class="top">
    <div class="row">
      <div class="indexes" id="indexes" role="toolbar" aria-label="Indexes"></div>
      <button class="btn ghost" id="addBtn" aria-expanded="false" aria-controls="addPanel">+ Index</button>
      <div class="spacer"></div>
      <label class="sr" for="mode">Refresh mode</label>
      <select id="mode">
        <option value="live">● Live</option>
        <option value="interval">⟳ Every 5s</option>
        <option value="manual">❚❚ Manual</option>
      </select>
      <button class="btn" id="refreshBtn">Refresh <span class="badge hidden" id="pending" aria-live="polite"></span></button>
      <button class="btn ghost" id="settingsBtn" aria-label="KibanaLocal settings" aria-expanded="false" aria-controls="setPanel">⚙</button>
    </div>
    <div class="addpanel hidden" id="addPanel" role="group" aria-label="Add index">
      <input id="addName" placeholder="Index name (optional)" class="small" aria-label="Index name">
      <input id="addPath" placeholder="/path/to/service.log  or  /path/to/logs/  (folder = every log file inside)" class="grow" aria-label="File or folder path">
      <button class="btn ghost" id="browseFile">File…</button>
      <button class="btn ghost" id="browseFolder">Folder…</button>
      <button class="btn primary" id="addGo">Add</button>
    </div>
    <div class="setpanel hidden" id="setPanel" role="group" aria-label="KibanaLocal settings">
      <div class="setgrid" id="setFields"></div>
      <div class="setusage" id="setUsage" aria-live="polite"></div>
      <div class="setactions">
        <button class="btn primary" id="setSave">Save</button>
        <button class="btn ghost" id="setReload" title="Drop loaded lines and read every index again with the current settings">Reload all indexes</button>
        <button class="btn ghost" id="setVsc">Open in VS Code Settings</button>
        <span class="spacer"></span>
        <span class="muted" id="setDirty"></span>
        <button class="btn ghost" id="setClose">Close</button>
      </div>
    </div>
    <div class="row">
      <div class="qwrap">
        <input id="q" spellcheck="false" aria-label="Search query" aria-describedby="qerr"
          placeholder='Search…  level:ERROR and txn_id:abc*  ·  msg:"gateway timeout"  ·  latency > 500  ·  not path:/health   (press / to focus)' />
        <div class="qerr hidden" id="qerr" role="alert"></div>
      </div>
      <label class="sr" for="range">Time range</label>
      <select id="range"></select>
      <span id="custom" class="hidden">
        <input type="datetime-local" step="1" id="from" aria-label="From"> → <input type="datetime-local" step="1" id="to" aria-label="To">
      </span>
      <button class="btn primary" id="searchBtn">Search</button>
    </div>
  </header>
  <div class="body">
    <aside class="side" aria-label="Fields">
      <input id="fieldFilter" placeholder="Filter fields" class="fieldfilter" aria-label="Filter fields">
      <div id="fields"></div>
    </aside>
    <main class="main">
      <div class="meta" id="meta" aria-live="polite"></div>
      <div class="hist" id="hist" role="group" aria-label="Hits over time; click a bar to zoom"></div>
      <div class="histaxis" id="histaxis" aria-hidden="true"></div>
      <div class="ghead" id="ghead" role="presentation"></div>
      <div class="vp" id="vp" tabindex="0" role="grid" aria-label="Log entries. Arrow keys to move, Enter to expand.">
        <div class="spacer-v" id="spacer"></div>
      </div>
      <div class="empty hidden" id="empty"></div>
    </main>
  </div>
  <div class="toast hidden" id="toast" role="status"></div>`;

  $('#range').innerHTML = RANGES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  const vp = $('#vp'), spacer = $('#spacer');

  // ---------- helpers ----------
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const fmtTs = (t) => {
    if (t == null) return '—';
    const d = new Date(t);
    return `${d.toLocaleString('en', { month: 'short' })} ${pad(d.getDate())}, ${d.getFullYear()} @ ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };
  const fmtShort = (t, bucket) => {
    const d = new Date(t);
    if (bucket >= 864e5) return `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
    if (bucket >= 6e4) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const toLocalInput = (t) => new Date(t - new Date(t).getTimezoneOffset() * 6e4).toISOString().slice(0, 19);
  const levelClass = (v) => {
    const s = String(v ?? '').toLowerCase();
    if (/(fatal|crit|emerg|alert|panic|error|^err$|^50$|^60$)/.test(s)) return 'lv-error';
    if (/(warn|^40$)/.test(s)) return 'lv-warn';
    if (/(info|notice|^30$)/.test(s)) return 'lv-info';
    if (/(debug|trace|^20$|^10$)/.test(s)) return 'lv-debug';
    return '';
  };
  const quoteVal = (v) => {
    const s = String(v);
    return /^[\w.\-@/]+$/.test(s) && !/^(and|or|not)$/i.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  };
  const det = (index) => S.detected[index] || { ts: null, level: null, msg: null };
  const activeIndexes = () => (S.ui.indexes.length ? S.ui.indexes : S.sources.map((s) => s.name));
  const fmtBytes = (b) => (b > 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : b > 1 << 20 ? Math.round(b / (1 << 20)) + ' MB' : Math.round(b / 1024) + ' KB');

  function toast(text, level = 'info') {
    const t = $('#toast');
    t.textContent = text;
    t.className = 'toast ' + level;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  // ---------- columns ----------
  // Virtual columns resolve to each row's own detected field, so indexes with
  // different schemas (level vs severity, message vs text) line up in one view.
  const VIRTUAL = { _level: 'level', _message: 'message' };
  const resolveCol = (h, c) => (c === '_level' ? det(h.index).level : c === '_message' ? det(h.index).msg : c);
  function defaultColumns() {
    const idx = activeIndexes();
    const c = [];
    if (idx.some((i) => det(i).level)) c.push('_level');
    if (idx.some((i) => det(i).msg)) c.push('_message');
    return c.length ? c : ['_source'];
  }
  const columns = () => (S.ui.columns && S.ui.columns.length ? S.ui.columns : defaultColumns());
  const showIndexCol = () => activeIndexes().length > 1 && !columns().includes('_index');
  const showTime = () => activeIndexes().some((i) => det(i).ts) || (S.result && S.result.hits.some((h) => h.ts != null));
  const isLevelCol = (c) => c === '_level' || activeIndexes().some((i) => det(i).level === c);
  const isMsgCol = (c) => c === '_source' || c === '_message' || activeIndexes().some((i) => det(i).msg === c);

  function setColumns(c) {
    S.ui.columns = c;
    vscode.postMessage({ type: 'columns', columns: c });
    renderHeader(); renderRows(true); renderFields();
  }
  function toggleColumn(f) {
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
  function gridTemplate() {
    const parts = ['22px'];
    if (showTime()) parts.push('228px');
    if (showIndexCol()) parts.push('110px');
    for (const c of columns()) parts.push(isLevelCol(c) ? '80px' : isMsgCol(c) ? 'minmax(220px, 4fr)' : 'minmax(90px, 1fr)');
    return parts.join(' ');
  }

  // ---------- query ----------
  function currentRange() {
    const k = $('#range').value;
    if (k === 'all') return { kind: 'all' };
    if (k === 'custom') {
      const f = Date.parse($('#from').value), t = Date.parse($('#to').value);
      return isNaN(f) || isNaN(t) ? { kind: 'all' } : { kind: 'absolute', from: f, to: t };
    }
    return { kind: 'relative', ms: RANGE_MS[k] };
  }
  function search() {
    S.ui.q = $('#q').value;
    S.ui.range = currentRange();
    S.expanded.clear();
    vscode.postMessage({ type: 'query', q: S.ui.q, indexes: S.ui.indexes, range: S.ui.range });
  }
  function addFilter(field, value, negate) {
    let q = $('#q').value.trim();
    const term = `${negate ? 'not ' : ''}${field}:${value === null ? '*' : quoteVal(value)}`;
    if (q && /\bor\b/i.test(q)) q = `(${q})`;
    $('#q').value = q ? `${q} and ${term}` : term;
    search();
  }

  // ---------- virtual list geometry ----------
  // Collapsed rows are ROW_H tall; expanded rows add a measured doc height.
  function extras() {
    const out = [];
    if (!S.expanded.size) return out;
    S.rows.forEach((h, i) => {
      if (h && S.expanded.has(h.id)) out.push({ i, extra: S.docHeights.get(h.id) ?? DOC_GUESS });
    });
    return out; // forEach on a sparse array visits in index order
  }
  function topOf(i, ex) {
    let acc = 0;
    for (const e of ex) { if (e.i < i) acc += e.extra; else break; }
    return i * ROW_H + acc;
  }
  function indexAt(y, ex) {
    let acc = 0;
    for (const e of ex) {
      const top = e.i * ROW_H + acc;
      if (y < top) break;
      if (y < top + ROW_H + e.extra) return e.i;
      acc += e.extra;
    }
    return Math.max(0, Math.floor((y - acc) / ROW_H));
  }

  function requestPage(i) {
    const offset = Math.floor(i / S.pageSize) * S.pageSize;
    if (S.requested.has(offset)) return;
    S.requested.add(offset);
    vscode.postMessage({ type: 'page', seq: S.seq, offset });
  }

  // ---------- render ----------
  function renderIndexes() {
    const el = $('#indexes');
    if (!S.sources.length) { el.innerHTML = '<span class="muted">No indexes yet — add a log file or folder →</span>'; return; }
    const sel = new Set(S.ui.indexes);
    el.innerHTML = `<button class="chip ${sel.size ? '' : 'on'}" data-all="1" aria-pressed="${!sel.size}">All</button>` +
      S.sources.map((s) => `<span class="chip ${sel.has(s.name) ? 'on' : ''}" role="group">
        <button class="chipbtn" data-idx="${esc(s.name)}" aria-pressed="${sel.has(s.name)}" title="${esc(s.path)} — Ctrl/Cmd-click to multi-select">${s.kind === 'folder' ? '📁' : '📄'} ${esc(s.name)}</button>
        <button class="x" data-rm="${esc(s.name)}" aria-label="Remove index ${esc(s.name)}">×</button></span>`).join('');
  }

  function renderMeta() {
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
      <span class="muted det" title="${esc(detTxt)}">${label}</span>`;
    const qe = $('#qerr');
    if (r.error) { qe.textContent = r.error; qe.classList.remove('hidden'); $('#q').classList.add('bad'); $('#q').setAttribute('aria-invalid', 'true'); }
    else { qe.classList.add('hidden'); $('#q').classList.remove('bad'); $('#q').removeAttribute('aria-invalid'); }
    renderUsage();
  }

  function renderHist() {
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

  function renderHeader() {
    const gh = $('#ghead');
    if (!S.result || !S.result.total) { gh.replaceChildren(); return; }
    gh.style.gridTemplateColumns = gridTemplate();
    gh.style.paddingRight = vp.offsetWidth - vp.clientWidth + 'px';
    const cells = ['<div role="columnheader"></div>'];
    if (showTime()) cells.push('<div role="columnheader">Time</div>');
    if (showIndexCol()) cells.push('<div role="columnheader">_index</div>');
    for (const c of columns()) {
      cells.push(`<div role="columnheader">${esc(VIRTUAL[c] || c)}${c !== '_source' ? ` <button class="rmcol" data-rmcol="${esc(c)}" aria-label="Remove column ${esc(c)}">×</button>` : ''}</div>`);
    }
    gh.innerHTML = cells.join('');
  }

  function cellHtml(h, col) {
    if (col === '_source') {
      const parts = [];
      for (const k in h.flat) { if (parts.length >= 30) break; parts.push(`<span class="sk">${esc(k)}:</span> ${esc(h.flat[k])}`); }
      return parts.join(' ');
    }
    col = resolveCol(h, col);
    if (!col) return '<span class="muted">-</span>';
    const v = col === '_index' ? h.index : col === '_file' ? h.file : h.flat[col];
    if (v === undefined) return '<span class="muted">-</span>';
    if (det(h.index).level === col) return `<span class="lvl ${levelClass(v)}">${esc(v)}</span>`;
    return esc(v === null ? 'null' : v);
  }

  function rowHtml(h) {
    const open = S.expanded.has(h.id);
    const cells = [`<div class="c exp" aria-hidden="true">${open ? '▾' : '▸'}</div>`];
    if (showTime()) cells.push(`<div class="c time" role="gridcell">${esc(fmtTs(h.ts))}</div>`);
    if (showIndexCol()) cells.push(`<div class="c" role="gridcell"><span class="idxtag">${esc(h.index)}</span></div>`);
    for (const c of columns()) cells.push(`<div class="c ${isMsgCol(c) ? 'msg' : ''}" role="gridcell">${cellHtml(h, c)}</div>`);
    return `<div class="cells">${cells.join('')}</div>${open ? `<div class="doc">${docHtml(h)}</div>` : ''}`;
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderRows(false); });
  }

  /** @param {boolean} force rebuild every visible row (columns/expansion changed) */
  function renderRows(force) {
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
          const lv = levelClass(h.flat[det(h.index).level]);
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

  function docHtml(h) {
    const tab = S.docTab.get(h.id) || 'table';
    const head = `<div class="doctabs" role="tablist">
      <button class="tab ${tab === 'table' ? 'on' : ''}" role="tab" aria-selected="${tab === 'table'}" data-tab="table" data-id="${h.id}">Table</button>
      <button class="tab ${tab === 'json' ? 'on' : ''}" role="tab" aria-selected="${tab === 'json'}" data-tab="json" data-id="${h.id}">JSON</button>
      <span class="spacer"></span>
      <button class="btn ghost tiny" data-copy="${h.id}">Copy JSON</button>
      <span class="muted">${esc(h.index)} · ${esc(h.file)}</span></div>`;
    if (tab === 'json') {
      let pretty;
      const first = h.raw.split('\n')[0];
      try { pretty = h.isJson ? JSON.stringify(JSON.parse(first.slice(first.indexOf('{'))), null, 2) : h.raw; } catch { pretty = h.raw; }
      const cont = h.isJson && h.flat._continuation ? '\n\n' + h.flat._continuation : '';
      return head + `<pre class="json">${esc(pretty + cont)}</pre>`;
    }
    const cols = columns();
    const lvf = det(h.index).level;
    const rows = Object.keys(h.flat).map((k) => {
      const v = h.flat[k];
      const jv = esc(JSON.stringify(v));
      return `<tr>
      <td class="acts">
        <button class="act" data-f="${esc(k)}" data-v="${jv}" data-neg="0" aria-label="Filter for ${esc(k)} value" title="Filter for value">⊕</button><button class="act" data-f="${esc(k)}" data-v="${jv}" data-neg="1" aria-label="Filter out ${esc(k)} value" title="Filter out value">⊖</button><button class="act ${cols.includes(k) ? 'on' : ''}" data-col="${esc(k)}" aria-label="Toggle column ${esc(k)}" title="Toggle column">▦</button><button class="act" data-exists="${esc(k)}" aria-label="Filter for ${esc(k)} present" title="Field present">∃</button>
      </td><th scope="row" class="fk">${esc(k)}</th><td class="fv ${k === lvf ? levelClass(v) : ''}">${esc(v === null ? 'null' : v)}</td></tr>`;
    }).join('');
    return head + `<table class="doctbl">${rows}</table>`;
  }

  function renderFields() {
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
          <div class="fdetfoot muted">In ${Math.round((x.count / Math.max(r.total, 1)) * 100)}% of hits${r.fieldSample < r.total ? ` · top values from newest ${r.fieldSample.toLocaleString()}` : ''}</div></div>`;
      }
      const v = x.top[0] && x.top[0].v;
      const icon = tsFields.has(x.name) ? '◷' : v !== undefined && v !== '' && !isNaN(Number(v)) ? '#' : v === 'true' || v === 'false' ? '◑' : 't';
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

  function renderPending() {
    const b = $('#pending');
    const show = S.ui.mode !== 'live' && S.pending > 0;
    b.textContent = show ? '+' + S.pending.toLocaleString() : '';
    b.classList.toggle('hidden', !show);
  }

  function renderAll() {
    renderIndexes(); renderMeta(); renderHist(); renderHeader(); renderRows(true); renderFields(); renderPending();
  }

  // ---------- results ----------
  function applyResult(seq, r) {
    const prev = S.result;
    S.seq = seq;
    S.result = r;
    S.detected = r.detected || {};
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

  function applyPage(seq, offset, hits) {
    if (seq !== S.seq) return;
    hits.forEach((h, k) => { S.rows[offset + k] = h; });
    renderRows(false);
  }

  // ---------- keyboard ----------
  function moveFocus(i) {
    const r = S.result;
    if (!r || !r.total) return;
    S.focus = Math.max(0, Math.min(r.total - 1, i));
    const ex = extras();
    const top = topOf(S.focus, ex);
    if (top < vp.scrollTop) vp.scrollTop = top;
    else if (top + ROW_H > vp.scrollTop + vp.clientHeight) vp.scrollTop = top + ROW_H - vp.clientHeight;
    renderRows(false);
  }
  function toggleExpand(i) {
    const h = S.rows[i];
    if (!h) return;
    if (S.expanded.has(h.id)) S.expanded.delete(h.id); else S.expanded.add(h.id);
    S.focus = i;
    renderRows(true);
  }
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

  // ---------- events ----------
  vp.addEventListener('scroll', scheduleRender, { passive: true });
  new ResizeObserver(() => { renderHeader(); scheduleRender(); }).observe(vp);

  $('#searchBtn').onclick = search;
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  document.addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (e.key === '/' && !(a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName))) { e.preventDefault(); $('#q').focus(); }
  });
  $('#range').onchange = () => {
    const custom = $('#range').value === 'custom';
    $('#custom').classList.toggle('hidden', !custom);
    if (custom) {
      const now = Date.now();
      if (!$('#from').value) $('#from').value = toLocalInput(now - 36e5);
      if (!$('#to').value) $('#to').value = toLocalInput(now);
    }
    search();
  };
  $('#from').onchange = search;
  $('#to').onchange = search;
  $('#mode').onchange = () => {
    S.ui.mode = $('#mode').value;
    vscode.postMessage({ type: 'mode', mode: S.ui.mode });
    S.pending = 0;
    renderPending();
  };
  $('#refreshBtn').onclick = () => { S.pending = 0; renderPending(); vscode.postMessage({ type: 'refresh' }); };
  // ---------- settings panel ----------
  // [key, label, unit, min (null = text), help]
  const SETTINGS = [
    ['initialTailMB', 'Initial load per file', 'MB', 1, 'Only the last N MB of each file is read when it is first loaded. Applies when indexes are (re)loaded.'],
    ['maxMemoryMB', 'Memory budget', 'MB', 32, 'Shared by all indexes. Over budget, the oldest lines by timestamp are dropped first. Lowering it frees memory right away.'],
    ['maxRows', 'Max lines per index', 'lines', 1000, 'Each index keeps its newest N lines (by timestamp); older lines of that index are dropped.'],
    ['pollIntervalMs', 'File check interval', 'ms', 0, 'Extra polling for Docker, WSL and network drives where file watching is unreliable. 0 turns it off.'],
    ['refreshIntervalSeconds', '"Every N s" refresh', 's', 1, 'Interval used by the "Every N s" refresh mode.'],
    ['timestampField', 'Timestamp field', '', null, 'Leave empty to auto-detect (e.g. @timestamp, meta.ts).'],
    ['levelField', 'Level field', '', null, 'Leave empty to auto-detect.'],
    ['messageField', 'Message field', '', null, 'Leave empty to auto-detect.'],
  ];
  $('#setFields').innerHTML = SETTINGS.map(([k, label, unit, min, help]) => `
    <label class="sfield" for="s_${k}">
      <span class="slabel">${esc(label)}${unit ? ` <span class="muted">(${esc(unit)})</span>` : ''}</span>
      <input id="s_${k}" data-key="${k}" ${min === null ? 'type="text" spellcheck="false" placeholder="auto-detect"' : `type="number" min="${min}" step="1"`} aria-describedby="h_${k}">
      <span class="muted shelp" id="h_${k}">${esc(help)}</span>
    </label>`).join('');
  S.settings = null;
  const setInputs = () => [...document.querySelectorAll('#setFields input')];
  const readSettingsForm = () => {
    const out = {};
    for (const el of setInputs()) out[el.dataset.key] = el.type === 'number' ? Number(el.value) : el.value.trim();
    return out;
  };
  const settingsDirty = () => {
    if (!S.settings) return false;
    const f = readSettingsForm();
    return SETTINGS.some(([k]) => String(f[k] ?? '') !== String(S.settings[k] ?? ''));
  };
  function fillSettings(force) {
    if (!S.settings || (!force && settingsDirty())) return;
    for (const el of setInputs()) el.value = S.settings[el.dataset.key] ?? '';
    renderSettingsState();
  }
  function renderSettingsState() {
    let bad = null;
    for (const [k, , , min] of SETTINGS) {
      const el = $(`#s_${k}`);
      const invalid = min !== null && (el.value === '' || !Number.isFinite(Number(el.value)) || Number(el.value) < min);
      el.classList.toggle('bad', invalid);
      el.setAttribute('aria-invalid', String(invalid));
      if (invalid && !bad) bad = `${SETTINGS.find((s) => s[0] === k)[1]} must be at least ${min}`;
    }
    $('#setDirty').textContent = bad || (settingsDirty() ? 'Unsaved changes' : '');
    $('#setSave').disabled = !!bad || !settingsDirty();
  }
  function renderUsage() {
    const el = $('#setUsage');
    const r = S.result, st = S.settings;
    if (!r || !st) { el.textContent = ''; return; }
    const memPct = Math.min(100, Math.round((r.memoryBytes / (st.maxMemoryMB * 1048576)) * 100));
    const perIdx = Object.entries(r.indexRows || {}).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, n]) => `${name} ${n.toLocaleString()}`).join(' · ');
    el.textContent = `In use now: ~${fmtBytes(r.memoryBytes)} of ${st.maxMemoryMB} MB (${memPct}%) · lines per index (max ${Number(st.maxRows).toLocaleString()}): ${perIdx || 'none loaded'}`;
  }
  const toggleSettings = (show) => {
    $('#setPanel').classList.toggle('hidden', !show);
    $('#settingsBtn').setAttribute('aria-expanded', String(show));
    if (show) { fillSettings(true); renderUsage(); $('#s_initialTailMB').focus(); }
  };
  $('#settingsBtn').onclick = () => toggleSettings($('#setPanel').classList.contains('hidden'));
  $('#setClose').onclick = () => toggleSettings(false);
  $('#setFields').addEventListener('input', renderSettingsState);
  $('#setFields').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#setSave').disabled) $('#setSave').click(); });
  $('#setSave').onclick = () => {
    vscode.postMessage({ type: 'saveSettings', values: readSettingsForm() });
  };
  $('#setReload').onclick = () => vscode.postMessage({ type: 'reloadAll' });
  $('#setVsc').onclick = () => vscode.postMessage({ type: 'openSettings' });
  $('#setPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleSettings(false); $('#settingsBtn').focus(); } });
  const toggleAdd = (show) => {
    $('#addPanel').classList.toggle('hidden', !show);
    $('#addBtn').setAttribute('aria-expanded', String(show));
    if (show) $('#addPath').focus();
  };
  $('#addBtn').onclick = () => toggleAdd($('#addPanel').classList.contains('hidden'));
  $('#browseFile').onclick = () => vscode.postMessage({ type: 'browse', kind: 'file' });
  $('#browseFolder').onclick = () => vscode.postMessage({ type: 'browse', kind: 'folder' });
  const doAdd = () => {
    const p = $('#addPath').value.trim();
    if (!p) { $('#addPath').focus(); return; }
    vscode.postMessage({ type: 'addPath', path: p, name: $('#addName').value.trim() });
    $('#addPath').value = '';
    $('#addName').value = '';
    toggleAdd(false);
  };
  $('#addGo').onclick = doAdd;
  $('#addPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
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

  function handleActs(t) {
    const a = t.closest('[data-f]');
    if (a) { addFilter(a.dataset.f, JSON.parse(a.dataset.v), a.dataset.neg === '1'); return true; }
    const ex = t.closest('[data-exists]');
    if (ex) { addFilter(ex.dataset.exists, null, false); return true; }
    const c = t.closest('[data-col]');
    if (c) { toggleColumn(c.dataset.col); return true; }
    return false;
  }

  $('#ghead').addEventListener('click', (e) => {
    const rc = e.target.closest('[data-rmcol]');
    if (rc) toggleColumn(rc.dataset.rmcol);
  });

  vp.addEventListener('click', (e) => {
    const t = e.target;
    if (handleActs(t)) return;
    const tab = t.closest('[data-tab]');
    if (tab) { S.docTab.set(Number(tab.dataset.id), tab.dataset.tab); renderRows(true); return; }
    const cp = t.closest('[data-copy]');
    if (cp) {
      const h = S.rows.find((x) => x && String(x.id) === cp.dataset.copy);
      if (h) vscode.postMessage({ type: 'copy', text: h.raw });
      return;
    }
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

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'state': {
        S.sources = m.sources;
        S.ui = m.ui;
        S.pageSize = m.pageSize || 200;
        $('#q').value = S.ui.q || '';
        $('#mode').value = S.ui.mode;
        $('#mode').options[1].textContent = `⟳ Every ${m.intervalSec || 5}s`;
        const r = S.ui.range;
        if (r.kind === 'all') $('#range').value = 'all';
        else if (r.kind === 'relative') $('#range').value = Object.keys(RANGE_MS).find((k) => RANGE_MS[k] === r.ms) || 'all';
        else { $('#range').value = 'custom'; $('#custom').classList.remove('hidden'); $('#from').value = toLocalInput(r.from); $('#to').value = toLocalInput(r.to); }
        if (!S.sources.length) toggleAdd(true);
        renderAll();
        break;
      }
      case 'result':
        applyResult(m.seq, m.result);
        break;
      case 'page':
        applyPage(m.seq, m.offset, m.hits);
        break;
      case 'pending':
        S.pending = m.count;
        renderPending();
        break;
      case 'browsed':
        toggleAdd(true);
        $('#addPath').value = m.path;
        $('#addName').focus();
        break;
      case 'toast':
        toast(m.text, m.level);
        break;
      case 'settings':
        S.settings = m.values;
        fillSettings(false);
        renderUsage();
        break;
      case 'showSettings':
        toggleSettings(true);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
