# KibanaLocal (VS Code extension)

Kibana-style search, histogram and field explorer for local JSON-lines (LDJSON/NDJSON) log files, with live tailing. Published as `kibanalocal` by AryanBarsaiyan; command/setting IDs still use the old `logscope.*` prefix — keep it, renaming would break users' settings and keybindings.

## Commands

- `npm run build` / `npm run watch` — esbuild bundles `src/extension.ts`, `src/engine/worker.ts` (Node) and `webview/main.js` (browser IIFE → `dist/webview.js`) into `dist/`
- `npm run typecheck` — `tsc` (strict, `noUnusedLocals/Parameters`, no emit), then `tsc -p tsconfig.webview.json` (`checkJs` over `webview/*.js`, non-strict; ambient globals in `webview/globals.d.ts` — use JSDoc casts like `/** @type {HTMLInputElement} */ (el)` where DOM types are too wide)
- `npm run lint` — eslint
- `npm test` — compiles `src/engine`, `src/sanitize.ts`, `webview/lib` + `test` to `out-test/` and runs `node --test` (with `--expose-gc` for memory tests)
- `npm run samples` / `npm run samples:live` — generate sample logs into `samples/data/` (gitignored) / append live lines for tail testing
- `npm run package` — build the `.vsix`
- F5 in VS Code launches the Extension Development Host (`.vscode/launch.json`)

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test on ubuntu/macos/windows, Node 20. Run all three before calling a change done.

## Architecture

Three runtimes, connected by message passing:

1. **Extension host** — `src/extension.ts` (commands), `src/sidebar.ts` (Indexes tree view), `src/panel.ts` (`KibanaLocalPanel`: the webview panel; owns sources, tailers, UI state, and a `WorkerClient`), `src/sanitize.ts` (validation of every webview message and of restored workspace state). UI state, index list and query history persist in `workspaceState`.
2. **Engine worker** (`worker_threads`) — `src/engine/worker.ts` hosts a `LogStore` so scanning/sorting ~200k rows never blocks the extension host. `workerClient.ts` is the promise wrapper (`reqId` → pending map). The message contract is `src/engine/protocol.ts` (`ToWorker` / `FromWorker`); change both sides together.
   - **Cancellation**: a `SharedArrayBuffer` generation counter (`WorkerClient.supersede()`). Queries/ticks carry their `gen`; the panel skips queued stale ones and `LogStore.query` polls the counter mid-scan and throws `Cancelled` (worker replies `result: null`). Every new user query must go through `supersede()`.
   - **Backpressure**: `ingest()` returns a promise; every `INGEST_WINDOW` batches it sends `sync` and callers wait for the `ack`. `TailerEvents.onLines` may return that promise and the tailer pauses its stream until it settles.
3. **Webview** — ES modules in `webview/` bundled by esbuild to `dist/webview.js`; styles in `media/main.css`. `main.js` (entry: init + host message switch), `layout.js` (page skeleton, rendered at import — keep it the only module with import-time DOM work), `state.js` (`S`, `vscode`, `$`, shared helpers), `grid.js` (results, histogram, fields), `columns.js`, `query.js`, `autocomplete.js`, `filters.js`, `context.js`, `settings.js`. Pure logic lives in typed `webview/lib/*.ts` (format, highlight, kql, grid) and is unit-tested in `test/webview.test.ts`. Talks to `panel.ts` via `postMessage`; message `type`s are handled in the `switch` in `panel.ts`.

Engine modules (`src/engine/`, pure Node, no `vscode` import — keep it that way so tests run without VS Code):
- `types.ts` — shared types (`Row`, `Filter`, `QueryRequest/Result`, `StoreLimits`, `PAGE_SIZE`)
- `parse.ts` — line parsing, `flatten`, timestamp parsing, ts/level/msg field auto-detection
- `query.ts` — KQL-like query compiler (`compileQuery`, `compileFilters`, highlights); value matchers are memoized per distinct short string (`memo`)
- `store.ts` — `LogStore`: ingest, per-index field detection, query/tick (incremental)/page/suggest/context, histogram, row & memory caps
- `dict.ts` — `ValueDict`: dictionary encoding of low-cardinality string values (shared instances + cached lowercase); fields past `DICT_MAX_DISTINCT` values are left alone
- `ring.ts` — `RowBuffer` (arrival order) / `TimeIndex` ((ts, id)-sorted, for time-range scans) / `EvictionOrder` for eviction under `maxRows` / `maxMemoryMB`
- `tailer.ts` — `FileTailer` / `FolderTailer` polling tailers (`LOG_EXT` decides which files a folder index picks up; idle files in a folder back off via `pollEvery`)

## Conventions and gotchas

- Webview input is untrusted: sanitize with `src/sanitize.ts` (`cleanFilters`, `cleanRange`, `cleanIndexes`, …) in `panel.ts` before it reaches the worker; add a case to `test/sanitize.test.ts` for new message fields.
- Log lines are untrusted too: flattened rows are plain objects, but a `__proto__` key is stored as an own property (`setField`). Read row fields with `own(flat, key)` (engine `parse.ts`, webview `lib/format.ts`), never `flat[key]`, so `constructor`/`toString` never resolve to `Object.prototype`. Tailers cut lines at `MAX_LINE_CHARS`.
- Memory: the per-row byte-estimate constants in `store.ts` (`ROW_BYTES`, `FIELD_BYTES`, `STR_BYTES`) are calibrated by `test/memory.test.ts` (estimate/heap ratio and a heap/file-size guard). Re-run it after changing what a `Row` holds. Build per-row strings with `join()`, not `+=` (V8 keeps `+=` results as ropes that cost several times their length until first read). Anything that changes `row.ts` or bulk-removes rows must call `TimeIndex.invalidate()`.
- Measured and rejected (don't redo without new evidence): sending ingest batches as one joined string (structured clone of `string[]` costs the same, and `split()` in the worker yields sliced strings that pin whole batches); incremental field stats on ticks (high-cardinality fields like timestamps need a full pass over the 10k sample anyway).
- Webview CSP has no `'unsafe-inline'`: never put inline `style=` in HTML strings in `webview/`; set styles via `el.style.*`.
- Rows carry `fileKey = index + '\0' + fullPath`; use it (not `file`, which is a display basename) to identify sources.
- Settings live under `logscope.*` in `package.json` `contributes.configuration`; new settings must be read in `panel.ts` and passed to the worker as `StoreLimits` / field overrides.
- Update `changelog.md` for user-visible changes.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- graphify-out/ is gitignored here (local, rebuilt per machine). If it is missing, build it with `/graphify .`.
