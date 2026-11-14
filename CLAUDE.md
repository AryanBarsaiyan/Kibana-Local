# KibanaLocal (VS Code extension)

Kibana-style search, histogram and field explorer for local JSON-lines (LDJSON/NDJSON) log files, with live tailing. Published as `kibanalocal` by AryanBarsaiyan; command/setting IDs still use the old `logscope.*` prefix — keep it, renaming would break users' settings and keybindings.

## Commands

- `npm run build` / `npm run watch` — esbuild bundles `src/extension.ts` and `src/engine/worker.ts` into `dist/`
- `npm run typecheck` — `tsc` (strict, `noUnusedLocals/Parameters`, no emit)
- `npm run lint` — eslint
- `npm test` — compiles `src/engine` + `test` to `out-test/` and runs `node --test` (with `--expose-gc` for memory tests)
- `npm run samples` / `npm run samples:live` — generate sample logs into `samples/data/` (gitignored) / append live lines for tail testing
- `npm run package` — build the `.vsix`
- F5 in VS Code launches the Extension Development Host (`.vscode/launch.json`)

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test on ubuntu/macos/windows, Node 20. Run all three before calling a change done.

## Architecture

Three runtimes, connected by message passing:

1. **Extension host** — `src/extension.ts` (commands), `src/sidebar.ts` (Indexes tree view), `src/panel.ts` (`LogScopePanel`: the webview panel; owns sources, tailers, UI state, and a `WorkerClient`). UI state, index list and query history persist in `workspaceState`.
2. **Engine worker** (`worker_threads`) — `src/engine/worker.ts` hosts a `LogStore` so scanning/sorting ~200k rows never blocks the extension host. `workerClient.ts` is the promise wrapper (`reqId` → pending map). The message contract is `src/engine/protocol.ts` (`ToWorker` / `FromWorker`); change both sides together.
3. **Webview** — `media/main.js` + `media/main.css` (plain JS, no bundler). Talks to `panel.ts` via `postMessage`; message `type`s are handled in the `switch` in `panel.ts`.

Engine modules (`src/engine/`, pure Node, no `vscode` import — keep it that way so tests run without VS Code):
- `types.ts` — shared types (`Row`, `Filter`, `QueryRequest/Result`, `StoreLimits`, `PAGE_SIZE`)
- `parse.ts` — line parsing, `flatten`, timestamp parsing, ts/level/msg field auto-detection
- `query.ts` — KQL-like query compiler (`compileQuery`, `compileFilters`, highlights)
- `store.ts` — `LogStore`: ingest, per-index field detection, query/tick (incremental)/page/suggest/context, histogram, row & memory caps
- `ring.ts` — `RowBuffer` / `EvictionOrder` for eviction under `maxRows` / `maxMemoryMB`
- `tailer.ts` — `FileTailer` / `FolderTailer` polling tailers (`LOG_EXT` decides which files a folder index picks up)

## Conventions and gotchas

- Webview input is untrusted: sanitize in `panel.ts` (see `cleanFilters`) before it reaches the worker.
- Webview CSP has no `'unsafe-inline'`: never put inline `style=` in HTML strings in `main.js`; set styles via `el.style.*`.
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
