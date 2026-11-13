import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { WorkerClient } from '../src/engine/workerClient';

test('worker protocol: ingest → query → tick → page', async () => {
  const c = new WorkerClient(path.join(__dirname, '..', 'src', 'engine', 'worker.js'), { maxRows: 1000, maxBytes: 1e9 }, {});
  try {
    const lines = Array.from({ length: 450 }, (_, i) => JSON.stringify({ ts: 1_700_000_000_000 + i, level: 'INFO', msg: 'm' + i }));
    c.ingest('w', '/w.log', lines.slice(0, 400));
    const r = await c.query({ q: '', indexes: [], range: { kind: 'all' } });
    assert.equal(r.total, 400);
    assert.equal(r.hits.length, 200);
    c.ingest('w', '/w.log', lines.slice(400));
    const t = await c.tick();
    assert.ok(t);
    if (!t) return;
    assert.equal(t.total, 450);
    assert.equal(t.prepended, 50);
    const p = await c.page(400, 200);
    assert.equal(p.length, 50);
    assert.equal(p[49].flat.msg, 'm0');
    const bad = await c.query({ q: 'level:(', indexes: [], range: { kind: 'all' } });
    assert.ok(bad.error);
  } finally {
    c.dispose();
  }
});
