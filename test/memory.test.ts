import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogStore } from '../src/engine/store';

/**
 * Calibrates the per-row byte estimate used by the memory cap against real heap usage.
 * Requires --expose-gc (set in the npm test script).
 */
test('memory estimate tracks real heap usage', (t) => {
  const gc = (globalThis as any).gc as (() => void) | undefined;
  if (!gc) { t.skip('run with --expose-gc'); return; }
  const N = 200_000;
  // realistic service log line, ~330 bytes
  const line = (i: number) => JSON.stringify({
    '@timestamp': new Date(1_763_000_000_000 + i * 37).toISOString(), level: i % 20 ? 'INFO' : 'ERROR',
    message: `processed payment step ${i % 9} for order`, txn_id: `txn_${(i * 7919).toString(36)}`,
    request_id: `req-${i.toString(16).padStart(8, '0')}`, ctx: { merchant_id: `m${i % 300}`, gateway: ['PAYU', 'RAZORPAY', 'STRIPE'][i % 3], latency_ms: i % 1200, amount: (i % 10000) / 100 },
    service: 'frm', host: 'dev-box',
  });
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const s = new LogStore({ maxRows: N, maxBytes: 8e9 });
  // lines are created after the baseline, as the tailer would, so the raw text is measured too
  let rawBytes = 0;
  for (let b = 0; b < N; b += 10_000) {
    const lines = Array.from({ length: 10_000 }, (_, i) => line(b + i));
    for (const l of lines) rawBytes += l.length;
    s.ingest('m', '/m.log', lines);
  }
  gc(); gc();
  const actual = process.memoryUsage().heapUsed - before;
  const est = s.memoryBytes;
  const ratio = est / actual;
  console.log(`    ${N.toLocaleString()} rows · file ${(rawBytes / 1048576).toFixed(0)} MB · heap ${(actual / 1048576).toFixed(0)} MB (${(actual / rawBytes).toFixed(1)}× file) · estimate ${(est / 1048576).toFixed(0)} MB (ratio ${ratio.toFixed(2)})`);
  assert.ok(s.size === N);
  // the estimate must not under-count badly (cap would overshoot) nor over-count wildly
  assert.ok(ratio > 0.9 && ratio < 1.25, `estimate ratio ${ratio}`);
  // regression guard: was 5.6x before dictionary encoding and the flat free-text string
  assert.ok(actual / rawBytes < 4, `heap is ${(actual / rawBytes).toFixed(1)}x the file size`);
});
