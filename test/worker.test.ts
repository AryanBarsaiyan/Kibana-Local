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
    assert.ok(r);
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
    assert.ok(bad?.error);
  } finally {
    c.dispose();
  }
});

const workerPath = path.join(__dirname, '..', 'src', 'engine', 'worker.js');
const all = { q: '', indexes: [] as string[], range: { kind: 'all' as const } };

test('cancellation: a superseded query returns null and the newer one wins', async () => {
  const c = new WorkerClient(workerPath, { maxRows: 1e6, maxBytes: 4e9 }, {});
  try {
    const lines = Array.from({ length: 150_000 }, (_, i) => JSON.stringify({ ts: 1_700_000_000_000 + i, level: i % 2 ? 'INFO' : 'ERROR', msg: 'message ' + i }));
    for (let i = 0; i < lines.length; i += 20_000) await c.ingest('w', '/w.log', lines.slice(i, i + 20_000));
    const g1 = c.supersede();
    const slow = c.query({ ...all, q: 'msg:*message* and not level:debug', sort: [{ field: 'msg', dir: 'asc' }] }, g1);
    const g2 = c.supersede();
    const fast = c.query({ ...all, q: 'level:ERROR' }, g2);
    assert.equal(await slow, null, 'older generation is abandoned');
    const r = await fast;
    assert.ok(r);
    assert.equal(r.total, 75_000);
    // a tick issued for an old generation is skipped too
    assert.equal(await c.tick(g1), null);
    // the session belongs to the query that finished
    const p = await c.page(0, 1);
    assert.equal(p[0].flat.level, 'ERROR');
  } finally {
    c.dispose();
  }
});

test('backpressure: ingest waits for an ack every window of batches', async () => {
  const c = new WorkerClient(workerPath, { maxRows: 1e6, maxBytes: 4e9 }, {}, 2);
  try {
    const batch = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ i }));
    let settled = 0;
    const track = (p: Promise<void>) => { void p.then(() => settled++); return p; };
    const a = track(c.ingest('w', '/w.log', batch));
    const b = track(c.ingest('w', '/w.log', batch));
    const d = track(c.ingest('w', '/w.log', batch));
    assert.equal(b, d, 'callers share the pending ack while the worker drains');
    await a;
    assert.notEqual(a, b);
    await Promise.all([b, d]);
    assert.equal(settled, 3);
    const r = await c.query(all);
    assert.equal(r?.total, 3000);
  } finally {
    c.dispose();
  }
});
