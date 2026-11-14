// KibanaLocal webview entry point (bundled by esbuild into dist/webview.js).
// No inline styles in HTML strings: the CSP has no 'unsafe-inline', so every dynamic style is set
// through the DOM (el.style.*), which CSP permits.
import './layout';
import { $, RANGE_MS, S, toast, vscode } from './state';
import { toLocalInput } from './lib/format';
import { search } from './query';
import { initAutocomplete } from './autocomplete';
import { initFilters } from './filters';
import { applyPage, applyResult, initGrid, renderAll, renderPending } from './grid';
import { initContext, renderContext } from './context';
import { fillSettings, initSettings, renderUsage, toggleAdd, toggleSettings } from './settings';


initGrid();
initAutocomplete();
initFilters();
initContext();
initSettings();

$('#searchBtn').onclick = search;
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
