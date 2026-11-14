import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

export const LOG_EXT = /\.(log|jsonl|ndjson|ldjson|json|txt|out)$/i;
const SIG_BYTES = 64;
/** Longer lines are cut to this many characters; the rest, up to the next newline, is dropped. */
export const MAX_LINE_CHARS = 1 << 20;
export const TRUNCATED_MARK = ' …[line truncated]';
/** a batch is emitted once it holds this many lines or characters */
const BATCH_LINES = 20_000;
const BATCH_CHARS = 8 << 20;

/**
 * Poll backoff for idle files of a folder index: after this many polls without growth a file is
 * polled every 2nd time, then every 4th, then every 8th (16 s at the default 2 s interval).
 * fs.watch events still read immediately, and any growth resets the file to every poll.
 */
const IDLE_STEPS: readonly [idlePolls: number, every: number][] = [[30, 8], [15, 4], [5, 2]];
export function pollEvery(idlePolls: number): number {
  for (const [n, every] of IDLE_STEPS) if (idlePolls >= n) return every;
  return 1;
}

export interface TailerEvents {
  /**
   * New complete lines. When this returns a promise, the tailer stops reading until it settles
   * (backpressure from the engine).
   */
  onLines(file: string, lines: string[]): void | Promise<unknown>;
  /** file was truncated in place (e.g. `> app.log`) — previous rows are gone */
  onTruncate(file: string): void;
  /** file was replaced by a new one (logrotate rename+create) — previous rows stay as history */
  onRotate(file: string): void;
  onError(file: string, err: Error): void;
}

export interface Tailer {
  start(): void;
  /** re-check now; cheap when nothing changed (one stat) */
  poke(): void;
  dispose(): void;
}

/**
 * Tails one file by byte offset; only new bytes are read.
 *  - fs.watch gives low-latency change events.
 *  - poke() is called by a single shared poll timer as a fallback for filesystems
 *    where fs.watch is unreliable (Docker mounts, NFS, WSL) and to re-attach after rotation.
 *  - Rotation is detected by inode change; in-place truncation by size shrink OR a
 *    changed head signature (catches copytruncate where the file regrew past our offset).
 */
export class FileTailer implements Tailer {
  private offset = 0;
  private partial = '';
  /**
   * Kept across reads, so a multi-byte UTF-8 character split by a read boundary (a writer mid-line,
   * or a read error) is completed by the next read instead of becoming U+FFFD.
   */
  private decoder = new StringDecoder('utf8');
  private ino: number | null = null;
  private headSig: string | null = null;
  private skipFirstPartial = false;
  private stream: fs.ReadStream | null = null;
  private reading = false;
  private again = false;
  private watcher: fs.FSWatcher | null = null;
  private disposed = false;
  private missingReported = false;
  /** consecutive polls that found the file unchanged */
  private idlePolls = 0;
  /** polls still to skip before the next stat (backoff) */
  private skip = 0;

  /**
   * @param backoff poll idle files less often (folder indexes, where every file is stat'ed on
   *   every poll); a single-file index keeps polling every time
   */
  constructor(readonly file: string, private ev: TailerEvents, private initialBytes: number, private maxLineChars = MAX_LINE_CHARS, private backoff = false) {}

  start() {
    try {
      const st = fs.statSync(this.file);
      this.ino = st.ino || null;
      if (st.size > this.initialBytes) {
        this.offset = st.size - this.initialBytes;
        this.skipFirstPartial = true;
      }
    } catch {
      /* may not exist yet; poke() will pick it up */
    }
    this.watch();
    this.read();
  }

  private watch() {
    this.watcher?.close();
    this.watcher = null;
    try {
      this.watcher = fs.watch(this.file, () => this.read());
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch {
      this.watcher = null;
    }
  }

  poke() {
    if (!this.watcher && !this.disposed) this.watch();
    if (this.skip > 0) { this.skip--; return; }
    this.read();
  }

  private readSig(size: number): string | null {
    if (size < SIG_BYTES) return null;
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.file, 'r');
      const b = Buffer.alloc(SIG_BYTES);
      fs.readSync(fd, b, 0, SIG_BYTES, 0);
      return b.toString('latin1');
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private reset() {
    this.offset = 0;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
    this.headSig = null;
    this.skipFirstPartial = false;
  }

  private read() {
    if (this.disposed) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    fs.stat(this.file, (err, st) => {
      if (this.disposed) { this.reading = false; return; }
      if (err) {
        if (!this.missingReported && this.ino === null && this.offset === 0) {
          this.missingReported = true;
          this.ev.onError(this.file, new Error('file not found yet — waiting for it to be created'));
        }
        this.finish();
        return;
      }
      this.missingReported = false;
      const ino = st.ino || null;
      if (this.ino !== null && ino !== null && ino !== this.ino) {
        this.ino = ino;
        this.reset();
        this.watch(); // old watcher follows the renamed inode
        this.ev.onRotate(this.file);
      } else {
        if (this.ino === null) this.ino = ino;
        if (st.size < this.offset) {
          this.reset();
          this.ev.onTruncate(this.file);
        } else if (this.headSig !== null && st.size !== this.offset && this.readSig(st.size) !== this.headSig) {
          this.reset();
          this.ev.onTruncate(this.file);
        }
      }
      if (st.size === this.offset) {
        if (this.backoff) this.skip = pollEvery(++this.idlePolls) - 1;
        this.finish();
        return;
      }
      this.idlePolls = 0;
      this.skip = 0;
      this.readRange(st.size);
    });
  }

  private readRange(end: number) {
    const start = this.offset;
    const startedAtZero = start === 0;
    const stream = fs.createReadStream(this.file, { start, end: end - 1, highWaterMark: 1 << 20 });
    this.stream = stream;
    const decoder = this.decoder;
    /** bytes received so far; every one of them is in `lines`, `buf` or the decoder */
    let got = 0;
    const max = this.maxLineChars;
    const cut = (l: string) => (l.length > max ? l.slice(0, max) + TRUNCATED_MARK : l);
    let lines: string[] = [];
    let chars = 0;
    let buf = this.partial;
    const push = (l: string) => { lines.push(l); chars += l.length; };
    /** hand the batch over; resolves when the consumer is ready for more */
    const flush = (): Promise<unknown> | undefined => {
      if (!lines.length) return undefined;
      const batch = lines;
      lines = [];
      chars = 0;
      const r = this.ev.onLines(this.file, batch);
      return r instanceof Promise ? r : undefined;
    };
    stream.on('close', () => { if (this.stream === stream) this.stream = null; });
    stream.on('data', (chunk) => {
      if (this.disposed) return; // never emit lines after dispose (index removed / reloaded)
      got += (chunk as Buffer).length;
      buf += decoder.write(chunk as Buffer);
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? '';
      if (this.skipFirstPartial && parts.length) { parts.shift(); this.skipFirstPartial = false; }
      for (const l of parts) if (l.length) push(cut(l));
      if (buf.length > max) {
        // A line with no newline in sight: keep its head once, then drop the rest of it instead of
        // buffering (and re-splitting) an ever-growing string.
        if (!this.skipFirstPartial) push(cut(buf));
        this.skipFirstPartial = true;
        buf = '';
      }
      if (lines.length >= BATCH_LINES || chars >= BATCH_CHARS) {
        const wait = flush();
        if (wait) {
          stream.pause();
          const resume = () => { if (!this.disposed) stream.resume(); };
          wait.then(resume, resume);
        }
      }
    });
    /** commit what was read: batches already handed over must never be read (and sent) again */
    const settle = () => {
      this.partial = buf;
      const wait = flush();
      if (!wait) { this.finish(); return; }
      const done = () => { if (this.disposed) this.reading = false; else this.finish(); };
      wait.then(done, done);
    };
    stream.on('error', (e) => {
      if (this.disposed) { this.reading = false; return; }
      this.offset = start + got;
      this.ev.onError(this.file, e);
      settle();
    });
    stream.on('end', () => {
      if (this.disposed) { this.reading = false; return; }
      this.offset = end;
      if (startedAtZero || this.headSig === null) this.headSig = this.readSig(end);
      settle();
    });
  }

  private finish() {
    this.reading = false;
    if (this.again) { this.again = false; this.read(); }
  }

  dispose() {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = null;
    this.stream?.destroy();
    this.stream = null;
  }
}

/** whether `target` is `dir` or below it (both already resolved with realpath) */
export function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * Every log-looking file in a folder is tailed as part of one index. Symbolic links are followed
 * only when they point to a file inside the folder.
 */
export class FolderTailer implements Tailer {
  private tailers = new Map<string, FileTailer>();
  private watcher: fs.FSWatcher | null = null;
  private first = true;

  constructor(readonly dir: string, private ev: TailerEvents, private initialBytes: number) {}

  start() {
    this.scan();
    try {
      this.watcher = fs.watch(this.dir, () => this.scan());
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    } catch { /* poll covers it */ }
  }

  poke() {
    this.scan();
    for (const t of this.tailers.values()) t.poke();
  }

  private scan() {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch (e) { this.ev.onError(this.dir, e as Error); return; }
    const seen = new Set<string>();
    let realDir: string | null = null;
    for (const d of entries) {
      if (!LOG_EXT.test(d.name)) continue;
      const full = path.join(this.dir, d.name);
      // the directory entry already says regular file vs directory; only links need a stat
      if (!d.isFile()) {
        if (!d.isSymbolicLink()) continue;
        // follow a link only to a file inside the folder (e.g. current.log -> app-2026-11-14.log),
        // never out of it: the user chose this folder, not wherever its links point
        try {
          realDir ??= fs.realpathSync.native(this.dir);
          if (!isInside(realDir, fs.realpathSync.native(full)) || !fs.statSync(full).isFile()) continue;
        } catch { continue; }
      }
      seen.add(full);
      if (!this.tailers.has(full)) {
        // files that appear after start are read from the beginning
        const t = new FileTailer(full, this.ev, this.first ? this.initialBytes : Number.MAX_SAFE_INTEGER, MAX_LINE_CHARS, true);
        this.tailers.set(full, t);
        t.start();
      }
    }
    this.first = false;
    for (const [f, t] of this.tailers) if (!seen.has(f)) { t.dispose(); this.tailers.delete(f); }
  }

  dispose() {
    this.watcher?.close();
    for (const t of this.tailers.values()) t.dispose();
    this.tailers.clear();
  }
}
