// Appends log lines to samples/data/live.log to test live tailing.
//   node samples/live.mjs                 -> 2 lines/sec until Ctrl+C
//   node samples/live.mjs --rate 50       -> 50 lines/sec
//   node samples/live.mjs --rotate 30     -> every 30s rename live.log -> live.log.1 and start a new file
//   node samples/live.mjs --truncate 30   -> every 30s empty the file in place (copytruncate)
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const file = path.join(dir, 'live.log');
fs.mkdirSync(dir, { recursive: true });

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const rate = arg('--rate', 2), rotate = arg('--rotate', 0), truncate = arg('--truncate', 0);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

let n = 0;
setInterval(() => {
  const level = pick(['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR']);
  const rec = { '@timestamp': new Date().toISOString(), level, message: `live event #${++n}`, service: 'live-demo', latency_ms: Math.round(Math.random() * 500), user: { id: `u_${1000 + Math.floor(Math.random() * 10)}` } };
  fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  // occasionally write a multi-line plain-text error to exercise continuation handling
  if (level === 'ERROR' && Math.random() < 0.3) fs.appendFileSync(file, `${new Date().toISOString()} ERROR plain text failure\n    at live.mjs:1:1\n    at process.tick\n`);
}, 1000 / rate);

if (rotate) setInterval(() => { try { fs.renameSync(file, file + '.1'); } catch { /* no file yet */ } console.log(`rotated at #${n}`); }, rotate * 1000);
if (truncate) setInterval(() => { fs.truncateSync(file, 0); console.log(`truncated at #${n}`); }, truncate * 1000);

console.log(`Appending ${rate} line(s)/s to ${file}${rotate ? `, rotating every ${rotate}s` : ''}${truncate ? `, truncating every ${truncate}s` : ''}. Ctrl+C to stop.`);
