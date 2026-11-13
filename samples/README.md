# Sample logs for testing KibanaLocal

```sh
npm run samples          # writes samples/data/ (~17k lines, last 24h, error spike ~3h ago)
npm run samples -- --big # also writes data/big.log (~120 MB) to test logscope.initialTailMB
npm run samples:live     # appends to data/live.log (add: -- --rate 50 | --rotate 30 | --truncate 30)
```

Timestamps are relative to when you run the generator, so re-run it before testing "last N minutes" ranges.

| Add as index | Exercises |
| --- | --- |
| `data/app.log` | ISO `@timestamp`, `level`/`message`, nested `http.*`, `user.*`, arrays, nulls, error spike |
| `data/payments.jsonl` | epoch-ms `ts`, `severity`/`msg`, deep nesting, booleans, `payments \| {…}` prefixed lines |
| `data/services/` (folder) | folder index, epoch-seconds `time`, `lvl`, `_file` filter |
| `data/mixed.log` | plain-text lines, multi-line Java stack traces, JSON mixed in, junk lines |
| `data/edge-cases.log` | `"… UTC"` dates, nested `log.level`, unicode, 5 KB values, >6-level nesting |
| `data/live.log` | live tailing, rotation, truncation |

## Queries to try (counts from a fresh `npm run samples`)

| Index | Query | Matches |
| --- | --- | --- |
| app | `level:ERROR` | 182 |
| app | `http.status:(500 or 503) and host:web-2` | 73 |
| app | `not level:INFO` | 1422 |
| all | `"database pool"` | 46 |
| payments | `severity:(error or fatal)` | 149 |
| payments | `payment.amount>400` | 594 |
| services | `lvl:error and region:eu*` | 50 |
| services | `_file:auth.ndjson` | 1500 |
| edge | `日本語` | 62 |
