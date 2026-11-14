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
        <input id="q" spellcheck="false" autocomplete="off" aria-label="Search query" aria-describedby="qerr"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ac"
          placeholder='Search…  level:ERROR and txn_id:abc*  ·  msg:"gateway timeout"  ·  latency > 500  ·  not path:/health   (press / to focus)' />
        <div class="qerr hidden" id="qerr" role="alert"></div>
        <div class="ac hidden" id="ac" role="listbox" aria-label="Suggestions"></div>
      </div>
      <label class="sr" for="range">Time range</label>
      <select id="range"></select>
      <span id="custom" class="hidden">
        <input type="datetime-local" step="1" id="from" aria-label="From"> → <input type="datetime-local" step="1" id="to" aria-label="To">
      </span>
      <button class="btn primary" id="searchBtn">Search</button>
    </div>
    <div class="row filterbar" id="filterbar" role="group" aria-label="Filters"></div>
  </header>
  <div class="body">
    <aside class="side" aria-label="Fields">
      <input id="fieldFilter" placeholder="Filter fields" class="fieldfilter" aria-label="Filter fields">
      <div id="fields"></div>
    </aside>
    <main class="main">
      <div class="disc" id="disc">
        <div class="meta" id="meta" aria-live="polite"></div>
        <div class="hist" id="hist" role="group" aria-label="Hits over time; click a bar to zoom"></div>
        <div class="histaxis" id="histaxis" aria-hidden="true"></div>
        <div class="ghead" id="ghead" role="row"></div>
        <div class="vp" id="vp" tabindex="0" role="grid" aria-label="Log entries. Arrow keys to move, Enter to expand.">
          <div class="spacer-v" id="spacer"></div>
        </div>
        <div class="empty hidden" id="empty"></div>
      </div>
      <div class="ctx hidden" id="ctx" role="region" aria-label="Surrounding documents">
        <div class="ctxhead">
          <button class="btn ghost" id="ctxBack">← Back to results</button>
          <b>Surrounding documents</b>
          <span class="muted" id="ctxAnchor"></span>
          <span class="spacer"></span>
          <label class="ctxopt"><input type="checkbox" id="ctxSame"> Only this file</label>
          <label class="ctxopt">Load <input type="number" id="ctxStep" min="1" max="500" step="1" value="5" aria-label="Documents per load"> at a time</label>
        </div>
        <div class="muted ctxnote">Neighbours in time from the selected indexes. Filters apply; the search query and time range do not.</div>
        <div class="ghead" id="ctxGhead" role="row"></div>
        <div class="ctxlist" id="ctxList" tabindex="-1">
          <div class="ctxmore"><button class="btn ghost tiny" data-more="newer" id="ctxNewer">Load newer</button><span class="muted" id="ctxNewerInfo"></span></div>
          <div id="ctxRows" role="grid" aria-label="Surrounding documents"></div>
          <div class="ctxmore"><button class="btn ghost tiny" data-more="older" id="ctxOlder">Load older</button><span class="muted" id="ctxOlderInfo"></span></div>
        </div>
      </div>
    </main>
  </div>
  <div class="pop hidden" id="pop"></div>
  <datalist id="fieldNames"></datalist>
  <datalist id="valueNames"></datalist>
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
    const str = String(v);
    return /^[\w.\-@/]+$/.test(str) && !/^(and|or|not)$/i.test(str) ? str : `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  };
  const det = (index) => S.detected[index] || { ts: null, level: null, msg: null };
  /** sidebar type icon: ◷ time, # number, ◑ boolean, t text */
  function fieldKind(name, stat) {
    if (name === '@timestamp' || activeIndexes().some((i) => det(i).ts === name)) return '◷';
    const x = stat || (S.result && S.result.fields.find((f) => f.name === name));
    const v = x && x.top[0] && x.top[0].v;
    return v !== undefined && v !== '' && !isNaN(Number(v)) ? '#' : v === 'true' || v === 'false' ? '◑' : 't';
  }
  const activeIndexes = () => (S.ui.indexes.length ? S.ui.indexes : S.sources.map((s) => s.name));
  const fmtBytes = (b) => (b > 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : b > 1 << 20 ? Math.round(b / (1 << 20)) + ' MB' : Math.round(b / 1024) + ' KB');

  function toast(text, level = 'info') {
    const t = $('#toast');
    t.textContent = text;
    t.className = 'toast ' + level;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  // ---------- search-term highlighting ----------
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** engine terms → regexes. `anchored` rules must match a whole value. */
  function compileHl(terms) {
    const out = [];
    for (const t of terms || []) {
      let src, anchored = false;
      if (t.mode === 'word') src = `(?<![\\w])${reEsc(t.value)}(?![\\w])`;
      else if (t.mode === 'phrase') src = reEsc(t.value);
      else if (t.mode === 'exact') { src = `^${reEsc(t.value)}$`; anchored = true; }
      else {
        const body = t.value.split('*').map(reEsc).join(t.field ? '.*' : '\\S*');
        anchored = !!t.field;
        src = anchored ? `^${body}$` : body;
      }
      try { out.push({ field: t.field, re: new RegExp(src, 'gi'), anchored }); } catch { /* skip */ }
    }
    return out;
  }
  /**
   * Escape `text` and wrap search-term matches in <mark>. Rules for other fields are skipped;
   * with field === null (raw JSON) every unanchored rule applies.
   */
  function hl(text, field) {
    const str = String(text);
    if (!S.hl.length || !str) return esc(str);
    const ranges = [];
    for (const r of S.hl) {
      if (field === null ? r.anchored : r.field !== null && r.field !== field) continue;
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(str)) && ranges.length < 500) {
        if (!m[0].length) { r.re.lastIndex++; continue; }
        ranges.push([m.index, m.index + m[0].length]);
      }
    }
    if (!ranges.length) return esc(str);
    ranges.sort((a, b) => a[0] - b[0]);
    let out = '', at = 0;
    for (let i = 0; i < ranges.length; i++) {
      let [a, b] = ranges[i];
      while (i + 1 < ranges.length && ranges[i + 1][0] <= b) b = Math.max(b, ranges[++i][1]);
      if (a < at) a = at;
      if (b <= a) continue;
      out += esc(str.slice(at, a)) + '<mark class="hl">' + esc(str.slice(a, b)) + '</mark>';
      at = b;
    }
    return out + esc(str.slice(at));
  }
  const showVal = (v) => (v === null ? 'null' : v);

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
    if (S.ctx) renderContext(false);
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
  function sendQuery() {
    S.expanded.clear();
    S.sug = null;
    vscode.postMessage({ type: 'query', q: S.ui.q, indexes: S.ui.indexes, range: S.ui.range, filters: S.ui.filters, sort: S.ui.sort });
  }
  /** user-initiated search (query, range, indexes): leaves the surrounding-documents view */
  function search() {
    acClose();
    S.ui.q = $('#q').value;
    const t = S.ui.q.trim();
    if (t) S.history = [t, ...S.history.filter((x) => x !== t)].slice(0, 20);
    S.ui.range = currentRange();
    if (S.ctx) closeContext();
    sendQuery();
  }

  // ---------- autocomplete ----------
  const KW = ['and', 'or', 'not'];
  const OPS = [[':', 'equals / contains'], ['>', 'greater than'], ['<', 'less than'], ['>=', 'at least'], ['<=', 'at most']];
  const FIELD_OK = /^[A-Za-z_@][\w.@-]*$/;

  /** Same token rules as the engine's query tokenizer, with positions; an unclosed quote becomes an "open" token. */
  function acTokens(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(' || c === ')') { out.push({ t: c, s: i, e: i + 1 }); i++; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1, v = '';
        while (j < src.length && src[j] !== c) {
          if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; }
          v += src[j++];
        }
        if (j >= src.length) { out.push({ t: 'open', v, s: i, e: src.length }); break; }
        out.push({ t: 'str', v, s: i, e: j + 1 });
        i = j + 1;
        continue;
      }
      if (c === '>' || c === '<') {
        const two = src[i + 1] === '=';
        out.push({ t: 'op', v: two ? c + '=' : c, s: i, e: i + (two ? 2 : 1) });
        i += two ? 2 : 1;
        continue;
      }
      let j = i;
      while (j < src.length && !/[\s()"'<>]/.test(src[j])) j++;
      out.push({ t: 'word', v: src.slice(i, j), s: i, e: j });
      i = j;
    }
    return out;
  }
  const isKwTok = (t) => !!t && t.t === 'word' && KW.includes(t.v.toLowerCase());
  /** `field:` or `field:value` → field */
  const fieldOf = (t) => {
    if (!t || t.t !== 'word') return null;
    const ci = t.v.indexOf(':');
    if (ci <= 0) return null;
    const f = t.v.slice(0, ci);
    return FIELD_OK.test(f) ? f : null;
  };
  function knownFields() {
    const names = new Set(['@timestamp', '_index', '_file']);
    for (const x of (S.result && S.result.fields) || []) names.add(x.name);
    for (const n of (S.result && S.result.fieldNames) || []) names.add(n);
    return [...names];
  }

  /** What is being typed at the cursor. `from`/`to` is the text a suggestion replaces. */
  function acContext(text, pos) {
    const toks = acTokens(text.slice(0, pos));
    const stack = [];
    toks.forEach((t, k) => {
      if (t.t === '(') {
        const pv = toks[k - 1];
        stack.push(pv && pv.t === 'word' && pv.v.endsWith(':') && pv.e === t.s ? fieldOf(pv) : null);
      } else if (t.t === ')') stack.pop();
    });
    const group = stack.length ? stack[stack.length - 1] : null;
    const n = toks.length, last = toks[n - 1], prev = toks[n - 2], prev2 = toks[n - 3];
    const cmpField = (opTok, fTok) => opTok && opTok.t === 'op' && fTok && fTok.t === 'word' && FIELD_OK.test(fTok.v) ? fTok.v : null;
    if (!last) return { kind: 'start', from: 0, to: pos };
    if (last.t === 'open') {
      const f = prev && prev.t === 'word' && prev.v.endsWith(':') && prev.e === last.s ? fieldOf(prev) : group || cmpField(prev, prev2);
      return f ? { kind: 'value', field: f, prefix: last.v, from: last.s, to: pos, inGroup: !!group && !fieldOf(prev) } : { kind: 'none' };
    }
    if (last.t === 'word' && last.e === pos) {
      const f = fieldOf(last);
      if (f) return { kind: 'value', field: f, prefix: last.v.slice(f.length + 1), from: last.s + f.length + 1, to: pos };
      if (group && !isKwTok(last)) return { kind: 'value', field: group, prefix: last.v, from: last.s, to: pos, inGroup: true };
      const cf = cmpField(prev, prev2);
      if (cf) return { kind: 'value', field: cf, prefix: last.v, from: last.s, to: pos, cmp: true };
      return { kind: 'field', prefix: last.v, from: last.s, to: pos, afterTerm: !!prev && !isKwTok(prev) && prev.t !== '(' && prev.t !== 'op' };
    }
    if (last.t === 'op') {
      const cf = cmpField(last, prev);
      return cf ? { kind: 'value', field: cf, prefix: '', from: pos, to: pos, cmp: true } : { kind: 'none' };
    }
    if (last.t === 'word' && fieldOf(last) && last.v.endsWith(':')) return { kind: 'value', field: fieldOf(last), prefix: '', from: pos, to: pos };
    if (last.t === '(') return group ? { kind: 'value', field: group, prefix: '', from: pos, to: pos, inGroup: true } : { kind: 'field', prefix: '', from: pos, to: pos };
    if (isKwTok(last)) return { kind: 'field', prefix: '', from: pos, to: pos };
    if (group) return { kind: 'conj', from: pos, to: pos, inGroup: true };
    if (last.t === 'word' && !last.v.includes(':') && knownFields().includes(last.v) && !cmpField(prev, prev2)) {
      return { kind: 'op', field: last.v, fieldEnd: last.e, from: pos, to: pos };
    }
    return { kind: 'conj', from: pos, to: pos };
  }

  /** field names: prefix matches first, then substring matches */
  function matchNames(list, prefix, max) {
    const p = prefix.toLowerCase();
    const a = [], b = [];
    for (const x of list) {
      const i = x.toLowerCase().indexOf(p);
      if (i === 0) a.push(x); else if (i > 0) b.push(x);
    }
    return a.sort().concat(b.sort()).slice(0, max);
  }

  function acItems(c, text) {
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
  function requestSuggest(field, prefix, cb) {
    const token = ++S.sugToken;
    S.sugCbs.set(token, cb);
    vscode.postMessage({ type: 'suggest', token, field, prefix });
  }
  let acTimer = null, acWant = null;
  function acUpdate(force) {
    const q = $('#q');
    if (document.activeElement !== q && !force) return;
    const text = q.value, pos = q.selectionStart ?? text.length;
    const c = acContext(text, pos);
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
  function acClose() {
    clearTimeout(acTimer);
    acWant = null;
    acHide();
  }
  function acHide() {
    if (!S.ac) return;
    S.ac = null;
    $('#ac').classList.add('hidden');
    $('#ac').replaceChildren();
    $('#q').setAttribute('aria-expanded', 'false');
    $('#q').removeAttribute('aria-activedescendant');
  }
  const markMatch = (label, m) => {
    if (!m) return esc(label);
    const i = label.toLowerCase().indexOf(m.toLowerCase());
    return i < 0 ? esc(label) : esc(label.slice(0, i)) + '<b>' + esc(label.slice(i, i + m.length)) + '</b>' + esc(label.slice(i + m.length));
  };
  function renderAc() {
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
  function acMove(d) {
    const a = S.ac;
    const sel = a.items.map((it, i) => (it.type === 'hint' ? -1 : i)).filter((i) => i >= 0);
    if (!sel.length) return;
    const k = sel.indexOf(a.sel);
    a.sel = k < 0 ? (d > 0 ? sel[0] : sel[sel.length - 1]) : sel[(k + d + sel.length) % sel.length];
    renderAc();
  }
  function acAccept(i) {
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

  // ---------- filter pills ----------
  // [menu value, op, negate, label]
  const FILTER_OPS = [
    ['is', 'is', false, 'is'], ['is_not', 'is', true, 'is not'],
    ['is_one_of', 'is_one_of', false, 'is one of'], ['is_not_one_of', 'is_one_of', true, 'is not one of'],
    ['between', 'between', false, 'is between'], ['not_between', 'between', true, 'is not between'],
    ['exists', 'exists', false, 'exists'], ['not_exists', 'exists', true, 'does not exist'],
    ['query', 'query', false, 'matches KQL query'], ['not_query', 'query', true, 'does not match KQL query'],
  ];
  const fmtVal = (v) => (v === null ? 'null' : v === '' ? '(empty)' : String(v));
  function filterText(f) {
    if (f.label) return f.label;
    switch (f.op) {
      case 'is': return `${f.field}: ${fmtVal(f.value)}`;
      case 'is_one_of': return `${f.field}: ${(f.values || []).map(fmtVal).join(', ')}`;
      case 'between':
        return f.gte && f.lte ? `${f.field}: ${f.gte} → ${f.lte}` : f.gte ? `${f.field} ≥ ${f.gte}` : `${f.field} ≤ ${f.lte}`;
      case 'exists': return `${f.field}: exists`;
      case 'query': return f.query || '(empty query)';
    }
    return '?';
  }
  function filtersChanged() {
    renderFilters();
    sendQuery();
    if (S.ctx) requestContext();
  }
  /** ⊕ / ⊖ / ∃: like Kibana, re-adding an existing filter updates it instead of duplicating it */
  function addFilter(field, value, negate) {
    const op = value === undefined ? 'exists' : 'is';
    const same = S.ui.filters.find((f) => f.op === op && f.field === field && !f.label && (op === 'exists' || (f.value === null) === (value === null) && String(f.value) === String(value)));
    if (same) { same.negate = !!negate; same.disabled = false; }
    else S.ui.filters.push(op === 'exists' ? { field, op, negate: !!negate, disabled: false } : { field, op, value, negate: !!negate, disabled: false });
    filtersChanged();
  }
  function renderFilters() {
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
  let popReturn = null;
  function openPop(anchor, html) {
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
  function closePop(restoreFocus) {
    const pop = $('#pop');
    if (pop.classList.contains('hidden')) return;
    pop.classList.add('hidden');
    pop.replaceChildren();
    if (restoreFocus && popReturn && document.body.contains(popReturn)) popReturn.focus();
    popReturn = null;
  }
  const menuHtml = (items) => `<div class="menu" role="menu">${items.map(([act, label]) => `<button role="menuitem" data-act="${act}">${esc(label)}</button>`).join('')}</div>`;
  function pillMenu(i, anchor) {
    const f = S.ui.filters[i];
    openPop(anchor, menuHtml([
      ['edit:' + i, 'Edit filter'],
      ['neg:' + i, f.negate ? 'Include results' : 'Exclude results'],
      ['dis:' + i, f.disabled ? 'Re-enable' : 'Temporarily disable'],
      ['del:' + i, 'Delete'],
    ]));
  }
  function allMenu(anchor) {
    openPop(anchor, menuHtml([
      ['all:on', 'Enable all'], ['all:off', 'Disable all'], ['all:inv', 'Invert inclusion'], ['all:del', 'Remove all'],
    ]));
  }
  function filterEditor(i, anchor) {
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
  function popAction(act) {
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

  // ---------- sorting ----------
  // An empty sort list means the default: newest first.
  const effSort = () => (S.ui.sort && S.ui.sort.length ? S.ui.sort : [{ field: '@timestamp', dir: 'desc' }]);
  const sortLabel = (f) => (f === '@timestamp' ? 'Time' : VIRTUAL[f] || f);
  /** click: sort by this column alone (asc → desc → default); Shift-click: add or cycle it as a further sort key */
  function clickSort(field, add) {
    const isT = field === '@timestamp';
    let s = effSort().map((x) => ({ ...x }));
    const i = s.findIndex((x) => x.field === field);
    const flip = (d) => (d === 'asc' ? 'desc' : 'asc');
    if (!add) {
      if (i >= 0 && s.length === 1) {
        if (isT) s[0].dir = flip(s[0].dir);
        else if (s[0].dir === 'asc') s[0].dir = 'desc';
        else s = [];
      } else if (i >= 0) s = [{ field, dir: flip(s[i].dir) }];
      else s = [{ field, dir: isT ? 'desc' : 'asc' }];
    } else if (i >= 0) {
      if (s[i].dir === 'asc') s[i].dir = 'desc';
      else if (s.length > 1) s.splice(i, 1);
      else s[i].dir = 'asc';
    } else s.push({ field, dir: isT ? 'desc' : 'asc' });
    if (s.length === 1 && s[0].field === '@timestamp' && s[0].dir === 'desc') s = [];
    S.ui.sort = s;
    vp.scrollTop = 0;
    sendQuery();
    renderHeader();
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
      ${S.ui.sort && S.ui.sort.length ? `<span class="sortinfo">sorted by ${S.ui.sort.map((k) => `${esc(sortLabel(k.field))} ${k.dir === 'asc' ? '▲' : '▼'}`).join(', ')}
        <button class="linkbtn" id="resetSort">reset to newest first</button></span>` : ''}
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

  function headCells(sortable) {
    const s = effSort();
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
      cells.push(cell(c, VIRTUAL[c] || c, rm));
    }
    return cells.join('');
  }

  function renderHeader() {
    const gh = $('#ghead');
    if (!S.result || !S.result.total) { gh.replaceChildren(); return; }
    gh.style.gridTemplateColumns = gridTemplate();
    gh.style.paddingRight = vp.offsetWidth - vp.clientWidth + 'px';
    gh.innerHTML = headCells(true);
  }

  function cellHtml(h, col) {
    if (col === '_source') {
      const parts = [];
      for (const k in h.flat) { if (parts.length >= 30) break; parts.push(`<span class="sk">${esc(k)}:</span> ${hl(showVal(h.flat[k]), k)}`); }
      return parts.join(' ');
    }
    col = resolveCol(h, col);
    if (!col) return '<span class="muted">-</span>';
    const v = col === '_index' ? h.index : col === '_file' ? h.file : h.flat[col];
    if (v === undefined) return '<span class="muted">-</span>';
    if (det(h.index).level === col) return `<span class="lvl ${levelClass(v)}">${hl(showVal(v), col)}</span>`;
    return hl(showVal(v), col);
  }

  function rowHtml(h, expanded = S.expanded) {
    const open = expanded.has(h.id);
    const cells = [`<div class="c exp" aria-hidden="true">${open ? '▾' : '▸'}</div>`];
    if (showTime()) cells.push(`<div class="c time" role="gridcell">${esc(fmtTs(h.ts))}</div>`);
    if (showIndexCol()) cells.push(`<div class="c" role="gridcell"><span class="idxtag">${hl(h.index, '_index')}</span></div>`);
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
      <button class="btn ghost tiny" data-surround="${h.id}" title="Show the entries logged just before and after this one">View surrounding documents</button>
      <button class="btn ghost tiny" data-copy="${h.id}">Copy JSON</button>
      <span class="muted">${esc(h.index)} · ${esc(h.file)}</span></div>`;
    if (tab === 'json') {
      let pretty;
      const first = h.raw.split('\n')[0];
      try { pretty = h.isJson ? JSON.stringify(JSON.parse(first.slice(first.indexOf('{'))), null, 2) : h.raw; } catch { pretty = h.raw; }
      const cont = h.isJson && h.flat._continuation ? '\n\n' + h.flat._continuation : '';
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

  function renderPending() {
    const b = $('#pending');
    const show = S.ui.mode !== 'live' && S.pending > 0;
    b.textContent = show ? '+' + S.pending.toLocaleString() : '';
    b.classList.toggle('hidden', !show);
  }

  function renderAll() {
    renderIndexes(); renderFilters(); renderMeta(); renderHist(); renderHeader(); renderRows(true); renderFields(); renderPending();
  }

  // ---------- results ----------
  function applyResult(seq, r) {
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

  function applyPage(seq, offset, hits) {
    if (seq !== S.seq) return;
    hits.forEach((h, k) => { S.rows[offset + k] = h; });
    renderRows(false);
  }

  // ---------- surrounding documents ----------
  const ctxStep = () => Math.max(1, Math.min(500, Math.floor(Number($('#ctxStep').value)) || 5));
  function openContext(id) {
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
  function closeContext() {
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
  function requestContext() {
    const c = S.ctx;
    vscode.postMessage({ type: 'context', token: ++S.ctxToken, id: c.id, newer: c.newer, older: c.older, sameFile: c.sameFile });
  }
  function ctxHits() {
    const r = S.ctx && S.ctx.result;
    if (!r || !r.anchor) return [];
    return [...r.newer, r.anchor, ...r.older];
  }
  function renderContext(loadedNewer) {
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
      const lv = levelClass(h.flat[det(h.index).level]);
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
    if (ex) { addFilter(ex.dataset.exists, undefined, false); return true; }
    const c = t.closest('[data-col]');
    if (c) { toggleColumn(c.dataset.col); return true; }
    return false;
  }

  $('#ghead').addEventListener('click', (e) => {
    const rc = e.target.closest('[data-rmcol]');
    if (rc) { toggleColumn(rc.dataset.rmcol); return; }
    const sb = e.target.closest('[data-sort]');
    if (sb) clickSort(sb.dataset.sort, e.shiftKey);
  });
  $('#meta').addEventListener('click', (e) => {
    if (e.target.closest('#resetSort')) { S.ui.sort = []; sendQuery(); renderHeader(); }
  });

  const findHit = (id) => S.rows.find((x) => x && String(x.id) === id) || ctxHits().find((x) => String(x.id) === id);
  /** doc-view buttons shared by the results grid and the surrounding-documents list */
  function handleDocButtons(t, rerender) {
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
    if (!$('#pop').contains(e.target) && !e.target.closest('[data-pill], #filtersMenu, #addFilterBtn')) closePop(false);
  });
  window.addEventListener('resize', () => closePop(false));

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

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'state': {
        S.sources = m.sources;
        S.ui = m.ui;
        S.pageSize = m.pageSize || 200;
        if (Array.isArray(m.history)) S.history = m.history;
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
      case 'suggest': {
        const cb = S.sugCbs.get(m.token);
        S.sugCbs.delete(m.token);
        for (const t of [...S.sugCbs.keys()]) if (t < m.token) S.sugCbs.delete(t);
        if (cb) cb(m.result);
        break;
      }
      case 'context':
        if (!S.ctx || m.token !== S.ctxToken) break;
        S.ctx.result = m.result;
        renderContext(S.ctx.loading === 'newer');
        S.ctx.loading = null;
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
