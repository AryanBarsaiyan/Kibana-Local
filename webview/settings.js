// In-panel settings form and the add-index panel.
// [key, label, unit, min (null = text), help]
import { $, S, vscode } from './state';
import { esc, fmtBytes } from './lib/format';

export const SETTINGS = [
  ['initialTailMB', 'Initial load per file', 'MB', 1, 'Only the last N MB of each file is read when it is first loaded. Applies when indexes are (re)loaded.'],
  ['maxMemoryMB', 'Memory budget', 'MB', 32, 'Shared by all indexes. Over budget, the oldest lines by timestamp are dropped first. Lowering it frees memory right away.'],
  ['maxRows', 'Max lines per index', 'lines', 1000, 'Each index keeps its newest N lines (by timestamp); older lines of that index are dropped.'],
  ['pollIntervalMs', 'File check interval', 'ms', 0, 'Extra polling for Docker, WSL and network drives where file watching is unreliable. 0 turns it off.'],
  ['refreshIntervalSeconds', '"Every N s" refresh', 's', 1, 'Interval used by the "Every N s" refresh mode.'],
  ['timestampField', 'Timestamp field', '', null, 'Leave empty to auto-detect (e.g. @timestamp, meta.ts).'],
  ['levelField', 'Level field', '', null, 'Leave empty to auto-detect.'],
  ['messageField', 'Message field', '', null, 'Leave empty to auto-detect.'],
];
export const setInputs = () => [...document.querySelectorAll('#setFields input')];
export const readSettingsForm = () => {
  const out = {};
  for (const el of setInputs()) out[el.dataset.key] = el.type === 'number' ? Number(el.value) : el.value.trim();
  return out;
};
export const settingsDirty = () => {
  if (!S.settings) return false;
  const f = readSettingsForm();
  return SETTINGS.some(([k]) => String(f[k] ?? '') !== String(S.settings[k] ?? ''));
};
export function fillSettings(force) {
  if (!S.settings || (!force && settingsDirty())) return;
  for (const el of setInputs()) el.value = S.settings[el.dataset.key] ?? '';
  renderSettingsState();
}
export function renderSettingsState() {
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
export function renderUsage() {
  const el = $('#setUsage');
  const r = S.result, st = S.settings;
  if (!r || !st) { el.textContent = ''; return; }
  const memPct = Math.min(100, Math.round((r.memoryBytes / (st.maxMemoryMB * 1048576)) * 100));
  const perIdx = Object.entries(r.indexRows || {}).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} ${n.toLocaleString()}`).join(' · ');
  el.textContent = `In use now: ~${fmtBytes(r.memoryBytes)} of ${st.maxMemoryMB} MB (${memPct}%) · lines per index (max ${Number(st.maxRows).toLocaleString()}): ${perIdx || 'none loaded'}`;
}
export const toggleSettings = (show) => {
  $('#setPanel').classList.toggle('hidden', !show);
  $('#settingsBtn').setAttribute('aria-expanded', String(show));
  if (show) { fillSettings(true); renderUsage(); $('#s_initialTailMB').focus(); }
};
export const toggleAdd = (show) => {
  $('#addPanel').classList.toggle('hidden', !show);
  $('#addBtn').setAttribute('aria-expanded', String(show));
  if (show) $('#addPath').focus();
};
export const doAdd = () => {
  const p = $('#addPath').value.trim();
  if (!p) { $('#addPath').focus(); return; }
  vscode.postMessage({ type: 'addPath', path: p, name: $('#addName').value.trim() });
  $('#addPath').value = '';
  $('#addName').value = '';
  toggleAdd(false);
};

export function initSettings() {
  $('#setFields').innerHTML = SETTINGS.map(([k, label, unit, min, help]) => `
    <label class="sfield" for="s_${k}">
      <span class="slabel">${esc(label)}${unit ? ` <span class="muted">(${esc(unit)})</span>` : ''}</span>
      <input id="s_${k}" data-key="${k}" ${min === null ? 'type="text" spellcheck="false" placeholder="auto-detect"' : `type="number" min="${min}" step="1"`} aria-describedby="h_${k}">
      <span class="muted shelp" id="h_${k}">${esc(help)}</span>
    </label>`).join('');
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
  $('#addBtn').onclick = () => toggleAdd($('#addPanel').classList.contains('hidden'));
  $('#browseFile').onclick = () => vscode.postMessage({ type: 'browse', kind: 'file' });
  $('#browseFolder').onclick = () => vscode.postMessage({ type: 'browse', kind: 'folder' });
  $('#addGo').onclick = doAdd;
  $('#addPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
}
