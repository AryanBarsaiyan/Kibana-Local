# KibanaLocal

Kibana-style Discover view for local **JSON-lines (LDJSON / NDJSON / JSONL)** log files, right inside VS Code.

> KibanaLocal is an independent project. It is not affiliated with, endorsed by, or sponsored by Elastic N.V. or Elasticsearch B.V. Kibana and Elasticsearch are trademarks of Elasticsearch B.V.

## Features
- **Indexes**: add a log file, or a folder (every `.log/.jsonl/.ndjson/.ldjson/.json/.txt/.out` inside becomes part of that index). Query one, several (Ctrl/Cmd-click), or all.
- **Live tailing**: byte-offset tailing; only new bytes are read. Handles truncation/rotation and partial lines.
- **Refresh modes**: ● Live (real-time) · ⟳ Every N s · ❚❚ Manual (shows a `+N` badge for new lines).
- **KQL-style search**:
  - `level:ERROR` · `txn_id:abc*` · `ctx.merchant_id:*` (exists)
  - `message:"gateway timeout"` (phrase) · `level:(ERROR or WARN)`
  - `latency > 500` · `@timestamp >= 2026-11-13T10:00`
  - `and` / `or` / `not` / parentheses; bare words = free text over all values
- **Histogram** (click a bar to zoom), time ranges, **field sidebar** with top values and ⊕/⊖ filters, column picker, expandable doc view (Table / JSON).
- Auto-detects timestamp / level / message fields (override in settings). Non-JSON lines are kept; indented lines (stack traces) attach to the previous entry.

- **Mixed schemas**: timestamp/level/message are detected per index, and the default *level* / *message* columns resolve per row — so `level` vs `severity`, `message` vs `text` line up in one view.
- **Big files**: the engine runs in a worker thread, live updates are incremental (only new lines are matched), and the results grid is virtualized with on-demand paging.
- **Rotation-safe**: follows logrotate (rename + create) via inode, detects in-place truncation and copytruncate.

## Keyboard
`/` focus search · `↑/↓` `PgUp/PgDn` `Home/End` move through results · `Enter` expand/collapse · `Tab` reaches every control.

## Usage
Click the **KibanaLocal** icon in the Activity Bar, or Command Palette → **KibanaLocal: Open**, then **+ Index** and paste a path. Or right-click a log file/folder → **Open in KibanaLocal**. Press `/` to focus search.

## Settings
| Setting | Default | |
|---|---|---|
| `logscope.maxRows` | 200000 | lines kept in memory per index (oldest by timestamp dropped) |
| `logscope.maxMemoryMB` | 512 | memory budget shared by all indexes (oldest by timestamp dropped); retained data is ~4× the raw file size |
| `logscope.initialTailMB` | 50 | only the last N MB of a large file are loaded at first |
| `logscope.refreshIntervalSeconds` | 5 | for the "Every Ns" mode |
| `logscope.pollIntervalMs` | 2000 | fallback polling (Docker/NFS/WSL, rotation); 0 disables |
| `logscope.timestampField` / `levelField` / `messageField` | auto | override detection |

## Development
`npm run build` · `npm run watch` · `npm run lint` · `npm run typecheck` · `npm test` · `npm run package`
