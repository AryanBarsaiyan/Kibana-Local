// Generates sample log data for manually testing Kibana-Local.
//   node samples/generate.mjs            -> ~16k lines across several files, last 24h
//   node samples/generate.mjs --big      -> also writes data/big.log (~120 MB) to test initialTailMB
// Output goes to samples/data/ (git- and vsix-ignored). Re-run any time to refresh timestamps.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'services'), { recursive: true });

// deterministic PRNG so runs are comparable
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');
const weighted = (pairs) => { let r = rnd() * pairs.reduce((s, [, w]) => s + w, 0); for (const [v, w] of pairs) if ((r -= w) < 0) return v; return pairs[0][0]; };

const NOW = Date.now();
const DAY = 864e5;
// timestamps spread over the last 24h, denser recently, with an error spike ~3h ago
const times = (n) => Array.from({ length: n }, () => NOW - Math.floor(DAY * rnd() ** 1.6)).sort((a, b) => a - b);
const SPIKE_FROM = NOW - 3 * 36e5, SPIKE_TO = SPIKE_FROM + 20 * 6e4;
const inSpike = (t) => t >= SPIKE_FROM && t <= SPIKE_TO;

const users = Array.from({ length: 40 }, (_, i) => `u_${1000 + i}`);
const routes = [['GET', '/api/orders'], ['GET', '/api/orders/:id'], ['POST', '/api/orders'], ['GET', '/api/users/me'], ['POST', '/api/login'], ['GET', '/health'], ['DELETE', '/api/cart/items/:id'], ['PUT', '/api/profile']];
const write = (name, lines) => { fs.writeFileSync(path.join(out, name), lines.join('\n') + '\n'); console.log(`${name.padEnd(24)} ${String(lines.length).padStart(6)} lines`); };

// 1) app.log — ISO "@timestamp", "level", "message", nested objects, arrays, stack traces
{
  const lines = [];
  for (const t of times(8000)) {
    const [method, route] = pick(routes);
    const status = inSpike(t) ? weighted([[200, 4], [500, 5], [503, 3]]) : weighted([[200, 80], [201, 8], [204, 3], [304, 3], [400, 2], [401, 2], [404, 3], [500, 1]]);
    const level = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : weighted([['INFO', 90], ['DEBUG', 10]]);
    const rec = {
      '@timestamp': new Date(t).toISOString(),
      level,
      message: status >= 500 ? `Request failed: ${pick(['upstream timeout', 'connection reset by peer', 'database pool exhausted', 'null reference in OrderService'])}` : `${method} ${route} completed`,
      service: 'web-api',
      host: pick(['web-1', 'web-2', 'web-3']),
      trace_id: hex(16),
      http: { method, path: route.replace(':id', String(int(1, 9999))), status, duration_ms: status >= 500 ? int(800, 30000) : int(2, 450), client: { ip: `10.0.${int(0, 9)}.${int(1, 254)}`, ua: pick(['Mozilla/5.0', 'curl/8.4.0', 'okhttp/4.12']) } },
      user: rnd() < 0.8 ? { id: pick(users), roles: pick([['user'], ['user', 'admin'], ['support']]) } : null,
    };
    if (status >= 500) rec.error = { type: pick(['TimeoutError', 'ECONNRESET', 'PoolExhaustedError', 'TypeError']), stack: 'Error: boom\n    at OrderService.load (src/orders.ts:88:13)\n    at async handler (src/routes.ts:41:5)' };
    lines.push(JSON.stringify(rec));
  }
  write('app.log', lines);
}

// 2) payments.jsonl — epoch-millis "ts", "severity", "msg", deep nesting, booleans, a prefix before the JSON
{
  const lines = [];
  for (const t of times(3000)) {
    const ok = rnd() > (inSpike(t) ? 0.4 : 0.04);
    const rec = {
      ts: t,
      severity: ok ? 'info' : pick(['error', 'fatal']),
      msg: ok ? 'payment captured' : `payment declined: ${pick(['insufficient_funds', 'card_expired', 'fraud_suspected', 'provider_unavailable'])}`,
      payment: { id: `pay_${hex(12)}`, amount: Math.round(rnd() * 50000) / 100, currency: pick(['USD', 'EUR', 'INR', 'GBP']), provider: pick(['stripe', 'adyen', 'razorpay']), card: { brand: pick(['visa', 'mastercard', 'amex']), last4: String(int(0, 9999)).padStart(4, '0') }, recurring: rnd() < 0.2 },
      customer_id: pick(users),
    };
    // some shippers prefix JSON with a tag; Kibana-Local should still parse from the first "{"
    lines.push((rnd() < 0.1 ? 'payments | ' : '') + JSON.stringify(rec));
  }
  write('payments.jsonl', lines);
}

// 3) services/ — folder index; epoch-seconds "time", "lvl", "msg", different services per file
for (const svc of ['auth', 'inventory', 'notifier']) {
  const lines = [];
  for (const t of times(1500)) {
    const lvl = weighted([['info', 80], ['debug', 10], ['warn', 7], ['error', inSpike(t) ? 30 : 3]]);
    lines.push(JSON.stringify({ time: Math.floor(t / 1000), lvl, svc, msg: `${svc}: ${pick({ auth: ['token issued', 'token refreshed', 'login failed', 'mfa challenge sent'], inventory: ['stock reserved', 'stock released', 'sku not found', 'reindex done'], notifier: ['email queued', 'sms sent', 'webhook retry', 'push delivered'] }[svc])}`, pid: int(1000, 1100), latency: Math.round(rnd() * 2000) / 10, region: pick(['us-east-1', 'eu-west-1', 'ap-south-1']) }));
  }
  write(`services/${svc}.ndjson`, lines);
}

// 4) mixed.log — plain-text lines with timestamps, Java-style multi-line stack traces, JSON mixed in, junk
{
  const lines = [];
  for (const t of times(1200)) {
    const d = new Date(t).toISOString().replace('T', ' ').slice(0, 23);
    const r = rnd();
    if (r < 0.6) lines.push(`${d} INFO  [main] c.e.batch.Job - processed batch ${int(1, 9999)} in ${int(5, 900)}ms`);
    else if (r < 0.8) lines.push(`[${d}] WARN  [pool-2] c.e.cache.Redis - slow command GET took ${int(100, 2000)}ms`);
    else if (r < 0.9) lines.push(`${d} ERROR [worker-${int(1, 8)}] c.e.batch.Job - job failed`, 'java.lang.IllegalStateException: cursor closed', '\tat com.example.batch.Job.run(Job.java:142)', '\tat java.base/java.lang.Thread.run(Thread.java:1583)', 'Caused by: java.sql.SQLException: connection lost', '\t... 2 more');
    else if (r < 0.97) lines.push(JSON.stringify({ timestamp: new Date(t).toISOString(), level: 'info', message: 'json line inside a text log', job: 'nightly' }));
    else lines.push(pick(['', '-----', 'garbage {not json', '{"truncated": ']));
  }
  write('mixed.log', lines);
}

// 5) edge-cases.log — odd field names, unicode, huge values, deep nesting, numeric-string timestamps
{
  const lines = [];
  for (const t of times(300)) {
    lines.push(JSON.stringify({
      datetime: new Date(t).toISOString().replace('T', ' ').replace('Z', ' UTC'),
      log: { level: pick(['INFO', 'ERROR']) }, // nested level -> detected as "log.level"
      text: pick(['héllo wörld ✓', '日本語のログ', 'emoji 🚀 deploy', 'quote "inside" text', 'back\\slash path C:\\logs\\x.log']),
      'weird key with spaces': 1, 'dots.in.key': true, a: { b: { c: { d: { e: { f: { g: { h: 'too deep' } } } } } } },
      big: rnd() < 0.05 ? 'x'.repeat(5000) : 'small', tags: ['a', 'b'], nothing: null,
    }));
  }
  write('edge-cases.log', lines);
}

if (process.argv.includes('--big')) {
  const fd = fs.openSync(path.join(out, 'big.log'), 'w');
  const target = 120 * 1024 * 1024; let size = 0, n = 0;
  while (size < target) {
    let chunk = '';
    for (let i = 0; i < 5000; i++, n++) chunk += JSON.stringify({ '@timestamp': new Date(NOW - (target - size) / 10).toISOString(), level: pick(['INFO', 'WARN', 'ERROR']), message: `bulk line ${n}`, payload: hex(64) }) + '\n';
    fs.writeSync(fd, chunk); size += Buffer.byteLength(chunk);
  }
  fs.closeSync(fd);
  console.log(`${'big.log'.padEnd(24)} ${String(n).padStart(6)} lines (${(size / 1048576).toFixed(0)} MB)`);
}
console.log(`\nWritten to ${out}`);
