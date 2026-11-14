import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileTailer, FolderTailer, LOG_EXT, Tailer, TailerEvents } from './engine/tailer';
import { DetectedFields, Filter, IndexSource, PAGE_SIZE, Primitive, QueryRequest, QueryResult, SortSpec, StoreLimits } from './engine/types';
import { WorkerClient } from './engine/workerClient';

type Mode = 'live' | 'interval' | 'manual';

interface UiState {
  q: string;
  indexes: string[];
  range: QueryRequest['range'];
  columns: string[] | null;
  mode: Mode;
  filters: Filter[];
  sort: SortSpec[];
}

const FILTER_OPS = new Set<Filter['op']>(['is', 'is_one_of', 'between', 'exists', 'query']);
const isPrim = (v: unknown): v is Primitive => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Webview input is untrusted: keep only well-formed filters. */
function cleanFilters(x: unknown): Filter[] {
  if (!Array.isArray(x)) return [];
  const out: Filter[] = [];
  for (const f of x.slice(0, 100)) {
    if (!f || typeof f !== 'object' || !FILTER_OPS.has(f.op)) continue;
    const c: Filter = { field: String(f.field ?? ''), op: f.op, negate: !!f.negate, disabled: !!f.disabled };
    if (typeof f.label === 'string' && f.label.trim()) c.label = f.label.trim();
    if (f.op === 'is') c.value = isPrim(f.value) ? f.value : String(f.value ?? '');
    if (f.op === 'is_one_of') c.values = Array.isArray(f.values) ? f.values.filter(isPrim).slice(0, 200) : [];
    if (f.op === 'between') { c.gte = String(f.gte ?? ''); c.lte = String(f.lte ?? ''); }
    if (f.op === 'query') c.query = String(f.query ?? '');
    out.push(c);
  }
  return out;
}

function cleanSort(x: unknown): SortSpec[] {
  if (!Array.isArray(x)) return [];
  return x.filter((k) => k && typeof k.field === 'string' && k.field && (k.dir === 'asc' || k.dir === 'desc'))
    .slice(0, 5).map((k) => ({ field: k.field, dir: k.dir }));
}

const STATE_KEY = 'logscope.state';
const HISTORY_KEY = 'logscope.history';
const HISTORY_MAX = 20;
export const INDEX_KEY = 'logscope.indexes';
const LIVE_DEBOUNCE_MS = 300;
const RELATIVE_SLIDE_MS = 5000;

/** Settings editable from the in-panel settings form (key -> minimum for numbers, null for strings). */
const EDITABLE: Record<string, number | null> = {
  initialTailMB: 1, maxMemoryMB: 32, maxRows: 1000, pollIntervalMs: 0, refreshIntervalSeconds: 1,
  timestampField: null, levelField: null, messageField: null,
};

function settingsSnapshot() {
  const c = vscode.workspace.getConfiguration('logscope');
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(EDITABLE)) out[k] = c.get(k);
  return out;
}

/** Validate and write settings; updates the workspace value if one exists there, otherwise the user value. */
async function saveSettings(values: Record<string, unknown>) {
  const c = vscode.workspace.getConfiguration('logscope');
  for (const [k, min] of Object.entries(EDITABLE)) {
    if (!(k in values)) continue;
    let v: unknown = values[k];
    if (min === null) v = String(v ?? '').trim();
    else {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
      v = Math.max(min, Math.round(n));
    }
    if (c.get(k) === v) continue;
    const target = c.inspect(k)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await c.update(k, v, target);
  }
}

function cfg() {
  const c = vscode.workspace.getConfiguration('logscope');
  return {
    limits: {
      maxRows: Math.max(1000, c.get<number>('maxRows', 200000)),
      maxBytes: Math.max(32, c.get<number>('maxMemoryMB', 512)) * 1024 * 1024,
    } as StoreLimits,
    overrides: {
      ts: c.get<string>('timestampField') || null,
      level: c.get<string>('levelField') || null,
      msg: c.get<string>('messageField') || null,
    } as Partial<DetectedFields>,
    initialBytes: Math.max(1, c.get<number>('initialTailMB', 50)) * 1024 * 1024,
    intervalSec: Math.max(1, c.get<number>('refreshIntervalSeconds', 5)),
    pollMs: c.get<number>('pollIntervalMs', 2000),
  };
}

export class LogScopePanel {
  static current: LogScopePanel | undefined;
  private static readonly sourcesChanged = new vscode.EventEmitter<void>();
  /** fires after the saved index list changes (used by the sidebar) */
  static readonly onDidChangeSources = LogScopePanel.sourcesChanged.event;

  private panel: vscode.WebviewPanel;
  private engine: WorkerClient;
  private tailers = new Map<string, Tailer>();
  private sources: IndexSource[];
  private ui: UiState;
  /** recent non-empty queries, newest first */
  private history: string[];
  private conf = cfg();

  private ready = false;
  private openSettingsWhenReady = false;
  private resultSeq = 0;
  private pendingLines = 0;
  /** serializes all engine requests so pages always match the result they were asked for */
  private chain: Promise<unknown> = Promise.resolve();
  private tickQueued = false;

  private liveTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private disposables: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext) {
    if (LogScopePanel.current) {
      LogScopePanel.current.panel.reveal();
      return LogScopePanel.current;
    }
    LogScopePanel.current = new LogScopePanel(ctx);
    return LogScopePanel.current;
  }

  private constructor(private ctx: vscode.ExtensionContext) {
    this.engine = new WorkerClient(path.join(ctx.extensionPath, 'dist', 'worker.js'), this.conf.limits, this.conf.overrides);
    this.engine.onError = (msg) => this.toast(`Engine error: ${msg.split('\n')[0]}`, 'error');

    this.sources = ctx.workspaceState.get<IndexSource[]>(INDEX_KEY, []);
    this.ui = {
      q: '', indexes: [], range: { kind: 'all' }, columns: null, mode: 'live', filters: [], sort: [],
      ...ctx.workspaceState.get<Partial<UiState>>(STATE_KEY, {}),
    };
    this.history = ctx.workspaceState.get<string[]>(HISTORY_KEY, []).filter((x) => typeof x === 'string').slice(0, HISTORY_MAX);
    this.ui.filters = cleanFilters(this.ui.filters);
    this.ui.sort = cleanSort(this.ui.sort);
    this.ui.indexes = this.ui.indexes.filter((n) => this.sources.some((s) => s.name === n));

    this.panel = vscode.window.createWebviewPanel('logscope', 'KibanaLocal', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('logscope')) return;
      this.conf = cfg();
      this.engine.configure(this.conf.limits, this.conf.overrides);
      this.applyTimers();
      this.pushState();
      this.pushSettings();
      this.scheduleTick(0);
    }, null, this.disposables);

    for (const s of this.sources) this.startTailer(s);
    this.applyTimers();
  }

  // ---------- sources ----------

  addSource(p: string, name?: string) {
    let kind: 'file' | 'folder';
    try {
      kind = fs.statSync(p).isDirectory() ? 'folder' : 'file';
    } catch {
      void vscode.window.showErrorMessage(`KibanaLocal: path not found: ${p}`);
      return;
    }
    const existing = this.sources.find((s) => path.resolve(s.path) === path.resolve(p));
    if (existing) {
      this.ui.indexes = [existing.name];
      this.afterSourcesChanged();
      return;
    }
    const base = (name || path.basename(p).replace(LOG_EXT, '') || 'logs').trim();
    let n = base;
    for (let i = 2; this.sources.some((s) => s.name === n); i++) n = `${base}-${i}`;
    const src: IndexSource = { name: n, path: p, kind };
    this.sources.push(src);
    this.ui.indexes = [n];
    this.startTailer(src);
    this.afterSourcesChanged();
  }

  /** select a single saved index (from the sidebar) */
  focusIndex(name: string) {
    if (!this.sources.some((s) => s.name === name)) return;
    this.ui.indexes = [name];
    this.afterSourcesChanged();
  }

  /** Drop an index's rows and read its file(s) again with the current settings. */
  reloadSource(name: string) {
    const src = this.sources.find((s) => s.name === name);
    if (!src) return;
    this.tailers.get(name)?.dispose();
    this.tailers.delete(name);
    this.engine.dropIndex(name);
    this.startTailer(src);
    this.runQuery();
  }

  reloadAll() {
    for (const s of this.sources) this.reloadSource(s.name);
    this.toast(`Reloaded ${this.sources.length} index${this.sources.length === 1 ? '' : 'es'}`, 'info');
  }

  /** Open the in-panel settings form (immediately, or once the webview has loaded). */
  showSettings() {
    if (this.ready) this.post({ type: 'showSettings' });
    else this.openSettingsWhenReady = true;
  }

  /** Remove a saved index when the panel is not open (sidebar). */
  static async removeSaved(ctx: vscode.ExtensionContext, name: string) {
    if (LogScopePanel.current) { LogScopePanel.current.removeSource(name); return; }
    const sources = ctx.workspaceState.get<IndexSource[]>(INDEX_KEY, []).filter((s) => s.name !== name);
    const ui = ctx.workspaceState.get<Partial<UiState>>(STATE_KEY, {});
    if (Array.isArray(ui.indexes)) ui.indexes = ui.indexes.filter((n) => n !== name);
    await ctx.workspaceState.update(STATE_KEY, ui);
    await ctx.workspaceState.update(INDEX_KEY, sources);
    LogScopePanel.sourcesChanged.fire();
  }

  removeSource(name: string) {
    this.tailers.get(name)?.dispose();
    this.tailers.delete(name);
    this.sources = this.sources.filter((s) => s.name !== name);
    this.ui.indexes = this.ui.indexes.filter((x) => x !== name);
    this.engine.dropIndex(name);
    this.afterSourcesChanged();
  }

  private afterSourcesChanged() {
    this.persist();
    this.pushState();
    this.runQuery();
  }

  private startTailer(src: IndexSource) {
    const ev: TailerEvents = {
      onLines: (file, lines) => {
        this.engine.ingest(src.name, file, lines);
        this.pendingLines += lines.length;
        this.onNewData();
      },
      onTruncate: (file) => {
        this.engine.dropFile(src.name, file);
        this.toast(`${path.basename(file)} was truncated — reloading`, 'info');
        this.onNewData();
      },
      onRotate: (file) => this.toast(`${path.basename(file)} was rotated — following the new file`, 'info'),
      onError: (file, err) => this.toast(`${path.basename(file)}: ${err.message}`, 'error'),
    };
    const t: Tailer = src.kind === 'folder'
      ? new FolderTailer(src.path, ev, this.conf.initialBytes)
      : new FileTailer(src.path, ev, this.conf.initialBytes);
    this.tailers.set(src.name, t);
    t.start();
  }

  // ---------- refresh modes ----------

  private onNewData() {
    if (this.ui.mode === 'live') this.scheduleTick(LIVE_DEBOUNCE_MS);
    else this.post({ type: 'pending', count: this.pendingLines });
  }

  private scheduleTick(delay: number) {
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => { this.liveTimer = null; this.tick(); }, delay);
  }

  private applyTimers() {
    if (this.intervalTimer) { clearInterval(this.intervalTimer); this.intervalTimer = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.ui.mode === 'interval') {
      this.intervalTimer = setInterval(() => this.tick(), this.conf.intervalSec * 1000);
    } else if (this.ui.mode === 'live' && this.ui.range.kind === 'relative') {
      // keep a sliding "last N minutes" window moving even when no new lines arrive
      this.intervalTimer = setInterval(() => this.tick(), RELATIVE_SLIDE_MS);
    }
    // One shared poll for all tailers: fallback for missed fs.watch events and rotation re-attach.
    if (this.conf.pollMs > 0) {
      this.pollTimer = setInterval(() => { for (const t of this.tailers.values()) t.poke(); }, Math.max(250, this.conf.pollMs));
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const p = this.chain.then(op, op);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private runQuery() {
    if (!this.ready) return;
    const req: QueryRequest = { q: this.ui.q, indexes: this.ui.indexes, range: this.ui.range, filters: this.ui.filters, sort: this.ui.sort };
    void this.enqueue(async () => {
      try {
        const r = await this.engine.query(req);
        this.pendingLines = 0;
        this.sendResult(r);
      } catch (e) {
        this.toast(String(e), 'error');
      }
    });
  }

  private tick() {
    if (!this.ready || this.tickQueued) return;
    this.tickQueued = true;
    void this.enqueue(async () => {
      this.tickQueued = false;
      try {
        const r = await this.engine.tick();
        this.pendingLines = 0;
        if (r) this.sendResult(r);
        else this.post({ type: 'pending', count: 0 });
      } catch (e) {
        this.toast(String(e), 'error');
      }
    });
  }

  private sendResult(result: QueryResult) {
    this.post({ type: 'result', seq: ++this.resultSeq, result });
  }

  // ---------- messaging ----------

  private post(m: unknown) { void this.panel.webview.postMessage(m); }
  private toast(text: string, level: 'info' | 'error') { this.post({ type: 'toast', level, text }); }

  private pushState() {
    this.post({ type: 'state', sources: this.sources, ui: this.ui, intervalSec: this.conf.intervalSec, pageSize: PAGE_SIZE, history: this.history });
  }

  private pushSettings() {
    this.post({ type: 'settings', values: settingsSnapshot() });
  }

  /** add a query to the recent-queries list (deduplicated, newest first) */
  private remember(q: string) {
    const t = q.trim();
    if (!t) return;
    this.history = [t, ...this.history.filter((x) => x !== t)].slice(0, HISTORY_MAX);
    void this.ctx.workspaceState.update(HISTORY_KEY, this.history);
  }

  private persist() {
    void this.ctx.workspaceState.update(INDEX_KEY, this.sources).then(() => LogScopePanel.sourcesChanged.fire());
    void this.ctx.workspaceState.update(STATE_KEY, this.ui);
  }

  private async onMessage(m: any) {
    switch (m?.type) {
      case 'ready':
        this.ready = true;
        this.pushState();
        this.pushSettings();
        if (this.openSettingsWhenReady) { this.openSettingsWhenReady = false; this.post({ type: 'showSettings' }); }
        this.runQuery();
        break;
      case 'query':
        this.ui.q = String(m.q ?? '');
        this.ui.indexes = Array.isArray(m.indexes) ? m.indexes : [];
        this.ui.range = m.range ?? { kind: 'all' };
        if ('filters' in m) this.ui.filters = cleanFilters(m.filters);
        if ('sort' in m) this.ui.sort = cleanSort(m.sort);
        this.remember(this.ui.q);
        this.persist();
        this.applyTimers();
        this.runQuery();
        break;
      case 'page': {
        const seq = m.seq, offset = Number(m.offset) || 0;
        void this.enqueue(async () => {
          if (seq !== this.resultSeq) return; // a newer result superseded this request
          const hits = await this.engine.page(offset, PAGE_SIZE);
          if (seq === this.resultSeq) this.post({ type: 'page', seq, offset, hits });
        });
        break;
      }
      case 'suggest': {
        const req = { field: String(m.field ?? ''), prefix: String(m.prefix ?? ''), indexes: this.ui.indexes, range: this.ui.range };
        const token = m.token;
        if (!req.field) break;
        void this.enqueue(async () => {
          try {
            const result = await this.engine.suggest(req);
            this.post({ type: 'suggest', token, result });
          } catch {
            this.post({ type: 'suggest', token, result: { values: [], sampled: 0, time: false } });
          }
        });
        break;
      }
      case 'clearHistory':
        this.history = [];
        void this.ctx.workspaceState.update(HISTORY_KEY, this.history);
        break;
      case 'context': {
        const req = {
          id: Number(m.id),
          newer: Math.min(10000, Math.max(0, Number(m.newer) || 0)),
          older: Math.min(10000, Math.max(0, Number(m.older) || 0)),
          indexes: this.ui.indexes,
          filters: this.ui.filters,
          sameFile: !!m.sameFile,
        };
        const token = m.token;
        void this.enqueue(async () => {
          try {
            const result = await this.engine.context(req);
            this.post({ type: 'context', token, result });
          } catch (e) {
            this.toast(String(e), 'error');
          }
        });
        break;
      }
      case 'columns':
        this.ui.columns = Array.isArray(m.columns) ? m.columns : null;
        this.persist();
        break;
      case 'mode':
        if (m.mode === 'live' || m.mode === 'interval' || m.mode === 'manual') this.ui.mode = m.mode;
        this.persist();
        this.applyTimers();
        this.tick();
        break;
      case 'refresh':
        for (const t of this.tailers.values()) t.poke();
        setTimeout(() => this.tick(), 150);
        break;
      case 'addPath':
        if (m.path) this.addSource(String(m.path).trim().replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'), m.name || undefined);
        break;
      case 'browse': {
        const folder = m.kind === 'folder';
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: !folder, canSelectFolders: folder, canSelectMany: false,
          openLabel: folder ? 'Use folder as index' : 'Use file as index',
        });
        if (uris?.[0]) this.post({ type: 'browsed', path: uris[0].fsPath });
        break;
      }
      case 'remove':
        this.removeSource(String(m.name));
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text ?? ''));
        vscode.window.setStatusBarMessage('KibanaLocal: copied', 1500);
        break;
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'logscope');
        break;
      case 'saveSettings':
        try {
          const before = this.conf.initialBytes;
          await saveSettings(m.values && typeof m.values === 'object' ? m.values : {});
          this.conf = cfg();
          this.pushSettings();
          this.toast(this.conf.initialBytes !== before && this.sources.length
            ? 'Settings saved. Initial load size changed: click "Reload all indexes" to apply it to loaded files.'
            : 'Settings saved', 'info');
        } catch (e) {
          this.toast(`Could not save settings: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
        break;
      case 'reloadAll':
        this.reloadAll();
        break;
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.css'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource}; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"><title>KibanaLocal</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  dispose() {
    LogScopePanel.current = undefined;
    for (const t of [this.liveTimer]) if (t) clearTimeout(t);
    for (const t of [this.intervalTimer, this.pollTimer]) if (t) clearInterval(t);
    for (const t of this.tailers.values()) t.dispose();
    this.tailers.clear();
    this.engine.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
