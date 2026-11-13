
# Changelog

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
