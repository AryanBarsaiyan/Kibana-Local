
# Changelog

## Unreleased
- **View surrounding documents opens instantly on big indexes**: it now walks outward from the selected line through the time index instead of scanning and sorting every loaded line (~18 ms → ~0.03 ms on 200k lines).
- Live updates no longer resend the full field-name list (up to 2,000 names per index) and detected fields every refresh; they are sent only when they change.
- Folder indexes rescan the directory at most once per 250 ms while files are being written, instead of on every write.
- A read error partway through a file (network drive hiccup, file locked by another process) no longer loads the lines already read a second time; reading resumes where it stopped.
- A non-ASCII character that a logger was still writing when the file was polled is no longer shown as `�`.
- A field named `constructor` (or `toString`, …) shows its own name in the column header and sort indicator instead of JavaScript source text.
- Errors while handling a panel action (e.g. a failed copy or file dialog) are reported as a toast instead of being silently dropped.
- Long stack traces take less memory while loading and are counted accurately against the memory budget.
- **About half the memory per line**: repeated short values (level, service, host, …) share one copy, and the lowercased search text is stored compactly. A 51 MB file now takes ~164 MB in memory instead of ~283 MB, and the memory budget (`logscope.maxMemoryMB`) is measured accurately (it used to under-count by ~25%, so usage could exceed the budget).
- **Faster time-range searches**: lines are indexed by timestamp, so a search over the last 15 minutes only visits those lines (2–3× faster on 200k lines). Field searches like `level:ERROR` test each distinct value once per search instead of once per line; live updates are ~1.6× faster.
- Folder indexes with many files check idle files less often (down to every 8th poll). Changes still show up immediately through file-system events; where those don't work (network or Docker mounts), a file that was idle is noticed within 16 s at the default 2 s poll interval.
- **Faster typing in the search box on big indexes**: a new search now cancels the one still running in the worker (it stops mid-scan) and skips queued refreshes, so only the latest query does any work.
- **Large initial loads no longer flood the engine**: file reading pauses while the worker catches up, so memory stays flat when an index starts with hundreds of MB.
- **Very long lines** (over 1M characters, or a line still being written with no newline) are cut with `…[line truncated]` instead of being buffered whole.
- Hardened against hostile log content: fields named `__proto__`, `constructor`, `toString` etc. are ordinary fields (previously `constructor:*` matched every line, and a `__proto__` field was silently dropped); deeply nested or unserializable JSON no longer aborts the rest of a batch; a single line with thousands of keys no longer bloats field autocomplete; queries nested too deeply or longer than 10,000 characters report an error.
- Messages from the panel UI are validated more strictly (time range, index names, columns, numbers and text lengths).
- **Wildcard searches can no longer freeze the engine**: a query like `a*a*a*a*a*a*a*a*b` used to backtrack for minutes on a single long line (and ran again every time the panel opened, since the query is saved). Wildcards are now matched piece by piece in linear time, in the engine and in result highlighting. A `*` in a field search now also matches across line breaks inside a value; a free-text wildcard like `err*full` still has to match within one field value.
- Typing a path into the panel's **Add index** box now asks for confirmation before KibanaLocal reads it; paths picked with **Browse…** and the sidebar/command-palette commands are added directly.
- Saved indexes are validated when a workspace is reopened; malformed entries (or ones with a relative path) are skipped.
- Folder indexes follow symbolic links only to files inside the folder, not out of it.
- The extension now declares that it is disabled in Restricted Mode (untrusted workspaces), as it already was by default.
- The packaged extension no longer includes development files (`CLAUDE.md`, `.claude/`).
- **Autocomplete** for the search box, like Kibana's KQL bar: suggests field names, operators (comparisons first for numeric and time fields), values with counts, `and` / `or` / `not`, `)` inside value groups, and recent queries (saved per workspace, with "clear recent"). Values come from the worker: the newest 50k lines of the selected indexes within the time range, prefix matches before substring matches; time fields suggest minutes in query format. Typing `:` after an accepted `field ` joins it to the field. The filter editor's Value box suggests values as well.
- **Search-term highlighting** in result cells and the expanded document (Table and JSON): free text and phrases anywhere, `field:value` terms only in that field, wildcards, and the values of enabled filter pills. Negated terms are not highlighted.
- **Filter pills**: ⊕ / ⊖ / ∃ now add Kibana-style filters to a filter bar instead of rewriting the search query. Each pill can be edited, excluded/included or temporarily disabled; a ☰ menu acts on all of them. **+ Add filter** offers *is*, *is not*, *is one of*, *is between*, *exists*, *does not exist* and custom KQL, with an optional label. Filters match exact values (case-insensitive) and are saved per workspace.
- **Column sorting**: click a header (Time, _index, or any field column) to sort; Shift-click adds secondary sort keys. Sorting runs in the worker; live updates keep the chosen order. "reset to newest first" restores the default.
- **Surrounding documents**: from an expanded entry, view its neighbours in time (5 each side by default) with load-more in both directions, an *Only this file* toggle, and re-anchoring on any neighbour. Filters apply; the query and time range do not.

## 0.4.0
- Renamed to **KibanaLocal** (display name, sidebar, tab and command titles). The extension ID and all `logscope.*` settings are unchanged, so existing settings and saved indexes keep working.
- Activity Bar icon with an **Indexes** sidebar: welcome buttons, inline **Reload** / **Remove** per index, **Open Log File** / **Reveal in File Explorer**, and a **Settings** button.
- In-panel **settings form** (⚙): initial load size, memory budget, max lines per index, file check interval, refresh interval and field overrides, with validation, live usage and **Reload all indexes**.
- `logscope.maxRows` is now **per index**: each index keeps its newest lines by timestamp. The memory budget stays shared and also drops the oldest lines by timestamp. Previously the earliest-loaded lines were dropped regardless of time, so one index could push out another entirely.
- Java stack traces: the unindented exception line (`java.lang.IllegalStateException: …`, `Exception in thread "main" …`) now stays with its log entry.
- Fixed: removing or reloading an index while a large file was still loading could leave stray lines behind.
- Sample log generator (`npm run samples`, `npm run samples:live`) for manual testing.

## 0.2.0
- Query engine runs in a worker thread; the extension host is never blocked.
- Live mode is incremental: only newly arrived lines are matched and merged.
- Virtualized results grid with on-demand paging (no "load more"); viewport stays put when new lines arrive while you are scrolled.
- Log rotation (rename + create) detected by inode; copytruncate detected by head signature.
- Timestamp/level/message detection is per index.
- Memory budget (`logscope.maxMemoryMB`) in addition to the row cap; ring-buffer eviction.
- One shared fallback poll instead of a poller per file (`logscope.pollIntervalMs`).
- Keyboard navigation (↑/↓/PgUp/PgDn/Home/End, Enter to expand, `/` to search) and ARIA roles.
- Fixed: dynamic styles were inline HTML attributes, which the webview CSP blocks (histogram bars could render empty).
- Crypto-random CSP nonce; esbuild bundle; ESLint; node:test suite; CI.

## 0.1.0
- First release.
