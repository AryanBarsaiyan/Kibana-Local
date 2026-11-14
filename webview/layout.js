// Page skeleton. Imported first by main.js; renders at import time so every other module can
// look up its elements.
import { $, RANGES } from './state';


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
export const vp = $('#vp'), spacer = $('#spacer');
