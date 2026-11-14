import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileTailer, FolderTailer, TailerEvents, TRUNCATED_MARK } from '../src/engine/tailer';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logscope-'));
  const got: string[] = [];
  const events: string[] = [];
  const ev: TailerEvents = {
    onLines: (_f, lines) => { got.push(...lines); },
    onTruncate: () => { events.push('truncate'); got.length = 0; },
    onRotate: () => events.push('rotate'),
    onError: () => events.push('error'),
  };
  return { dir, got, events, ev };
}

/** poll + settle, as the panel's shared poll timer would */
async function settle(t: { poke(): void }, ms = 250) {
  for (let i = 0; i < 4; i++) { t.poke(); await wait(ms / 4); }
}

test('appends, partial lines, utf-8 across chunk boundary', async () => {
  const { dir, got, ev } = harness();
  const f = path.join(dir, 'a.log');
  fs.writeFileSync(f, '{"a":1}\n');
  const t = new FileTailer(f, ev, 1 << 20);
  t.start();
  await settle(t);
  fs.appendFileSync(f, '{"a":2}\n{"a":');
  await settle(t);
  assert.deepEqual(got, ['{"a":1}', '{"a":2}']);
  fs.appendFileSync(f, '3}\n');
  // large line with multi-byte chars spanning the 1 MiB read chunk
  const big = JSON.stringify({ m: 'é'.repeat(700_000) });
  fs.appendFileSync(f, big + '\n');
  await settle(t, 600);
  assert.equal(got[2], '{"a":3}');
  assert.equal(got[3], big);
  t.dispose();
});

test('in-place truncation (size shrink)', async () => {
  const { dir, got, events, ev } = harness();
  const f = path.join(dir, 'a.log');
  fs.writeFileSync(f, Array.from({ length: 10 }, (_, i) => `{"i":${i},"pad":"${'x'.repeat(50)}"}`).join('\n') + '\n');
  const t = new FileTailer(f, ev, 1 << 20);
  t.start();
  await settle(t);
  fs.writeFileSync(f, '{"new":1}\n');
  await settle(t);
  assert.ok(events.includes('truncate'));
  assert.deepEqual(got, ['{"new":1}']);
  t.dispose();
});

test('copytruncate where the file regrew past the old offset (head signature)', async () => {
  const { dir, got, events, ev } = harness();
  const f = path.join(dir, 'a.log');
  fs.writeFileSync(f, `{"gen":1,"pad":"${'a'.repeat(80)}"}\n`);
  const t = new FileTailer(f, ev, 1 << 20);
  t.start();
  await settle(t);
  t.dispose(); // simulate missing events while the file is replaced and regrows
  const t2 = t as any;
  t2.disposed = false;
  fs.writeFileSync(f, Array.from({ length: 5 }, (_, i) => `{"gen":2,"i":${i},"pad":"${'b'.repeat(80)}"}`).join('\n') + '\n');
  await settle(t);
  assert.ok(events.includes('truncate'), 'detected via head signature');
  assert.equal(got.length, 5);
  assert.ok(got.every((l) => l.includes('"gen":2')));
  t.dispose();
});

test('rotation: rename + create new file (inode change)', async (tt) => {
  if (process.platform === 'win32') { tt.skip('inode semantics differ on Windows'); return; }
  const { dir, got, events, ev } = harness();
  const f = path.join(dir, 'a.log');
  fs.writeFileSync(f, '{"old":1}\n');
  const t = new FileTailer(f, ev, 1 << 20);
  t.start();
  await settle(t);
  fs.renameSync(f, f + '.1');
  fs.writeFileSync(f, '{"rotated":1}\n{"rotated":2}\n{"rotated":3}\n');
  await settle(t);
  assert.ok(events.includes('rotate'));
  assert.deepEqual(got, ['{"old":1}', '{"rotated":1}', '{"rotated":2}', '{"rotated":3}']);
  fs.appendFileSync(f, '{"rotated":4}\n');
  await settle(t);
  assert.equal(got[got.length - 1], '{"rotated":4}', 'keeps following the new file');
  t.dispose();
});

test('file that does not exist yet is picked up when created', async () => {
  const { dir, got, events, ev } = harness();
  const f = path.join(dir, 'later.log');
  const t = new FileTailer(f, ev, 1 << 20);
  t.start();
  await settle(t);
  assert.ok(events.includes('error'));
  fs.writeFileSync(f, '{"hi":1}\n');
  await settle(t);
  assert.deepEqual(got, ['{"hi":1}']);
  t.dispose();
});

test('initial tail of a large file skips the partial first line', async () => {
  const { dir, got, ev } = harness();
  const f = path.join(dir, 'big.log');
  fs.writeFileSync(f, Array.from({ length: 100 }, (_, i) => `{"i":${i}}`).join('\n') + '\n');
  const t = new FileTailer(f, ev, 100);
  t.start();
  await settle(t);
  assert.ok(got.length > 0 && got.length < 100);
  assert.ok(got.every((l) => /^\{"i":\d+\}$/.test(l)));
  assert.equal(got[got.length - 1], '{"i":99}');
  t.dispose();
});

test('folder index picks up new files from the start', async () => {
  const { dir, got, ev } = harness();
  fs.writeFileSync(path.join(dir, 'a.log'), '{"f":"a"}\n');
  fs.writeFileSync(path.join(dir, 'ignore.bin'), 'nope\n');
  const t = new FolderTailer(dir, ev, 1 << 20);
  t.start();
  await settle(t);
  fs.writeFileSync(path.join(dir, 'b.jsonl'), '{"f":"b"}\n');
  await settle(t);
  assert.deepEqual(got.sort(), ['{"f":"a"}', '{"f":"b"}']);
  t.dispose();
});

test('no lines are emitted after dispose, even mid-read', async () => {
  const { dir, got, ev } = harness();
  const f = path.join(dir, 'big.log');
  // ~40 MB so the read spans many 1 MiB chunks
  const line = JSON.stringify({ msg: 'x'.repeat(200) });
  fs.writeFileSync(f, (line + '\n').repeat(200_000));
  const t = new FileTailer(f, ev, Number.MAX_SAFE_INTEGER);
  t.start();
  await wait(5);
  t.dispose();
  const atDispose = got.length;
  await wait(1500);
  assert.equal(got.length, atDispose);
  assert.ok(atDispose < 200_000, 'expected dispose to interrupt the read');
});

test('overlong lines are cut, and a newline-less giant line is not buffered whole', async () => {
  const { dir, got, ev } = harness();
  const f = path.join(dir, 'long.log');
  const t = new FileTailer(f, ev, Number.MAX_SAFE_INTEGER, 1000);
  fs.writeFileSync(f, 'a'.repeat(5000) + '\n{"ok":1}\n');
  t.start();
  await settle(t);
  assert.deepEqual(got, ['a'.repeat(1000) + TRUNCATED_MARK, '{"ok":1}']);
  // a line still being written, far past the cap, across several reads
  fs.appendFileSync(f, 'b'.repeat(3000));
  await settle(t);
  fs.appendFileSync(f, 'b'.repeat(3000));
  await settle(t);
  assert.ok((t as any).partial.length <= 1000, 'partial line buffer stays bounded');
  fs.appendFileSync(f, 'bbb\n{"ok":2}\n');
  await settle(t);
  assert.deepEqual(got.slice(2), ['b'.repeat(1000) + TRUNCATED_MARK, '{"ok":2}']);
  t.dispose();
});

test('backpressure: reading pauses until onLines settles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logscope-'));
  const f = path.join(dir, 'bp.log');
  fs.writeFileSync(f, Array.from({ length: 70_000 }, (_, i) => `{"i":${i}}`).join('\n') + '\n');
  const batches: number[] = [];
  let release: () => void = () => {};
  const ev: TailerEvents = {
    onLines: (_f, lines) => { batches.push(lines.length); return new Promise<void>((r) => { release = r; }); },
    onTruncate: () => {}, onRotate: () => {}, onError: () => {},
  };
  const t = new FileTailer(f, ev, Number.MAX_SAFE_INTEGER);
  t.start();
  await wait(300);
  assert.equal(batches.length, 1, 'only one batch while the consumer is busy');
  for (let i = 0; i < 10 && batches.reduce((a, b) => a + b, 0) < 70_000; i++) { release(); await wait(150); }
  assert.equal(batches.reduce((a, b) => a + b, 0), 70_000);
  release();
  t.dispose();
});
