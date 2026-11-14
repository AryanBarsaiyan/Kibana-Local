/**
 * Runs the log store and query engine off the extension-host thread, so
 * scanning/sorting 200k rows never blocks other extensions.
 */
import { parentPort, workerData } from 'worker_threads';
import { FromWorker, ToWorker, WorkerInit } from './protocol';
import { Cancelled, LogStore } from './store';

if (!parentPort) throw new Error('worker.ts must run in a worker thread');
const port = parentPort;
const generation = new Int32Array((workerData as WorkerInit).generation);
let store = new LogStore({ maxRows: 200_000, maxBytes: 512 * 1024 * 1024 });

const send = (m: FromWorker) => port.postMessage(m);
/** true once the host has started a newer query generation than `gen` */
const supersededSince = (gen: number) => () => Atomics.load(generation, 0) !== gen;

port.on('message', (m: ToWorker) => {
  try {
    switch (m.type) {
      case 'init':
        store = new LogStore(m.limits, m.overrides);
        break;
      case 'config':
        store.setLimits(m.limits);
        store.setOverrides(m.overrides);
        break;
      case 'ingest':
        store.ingest(m.index, m.file, m.lines);
        break;
      case 'sync':
        send({ type: 'ack', reqId: m.reqId });
        break;
      case 'dropFile':
        store.dropFile(m.index, m.file);
        break;
      case 'dropIndex':
        store.dropIndex(m.index);
        break;
      case 'query': {
        const stale = supersededSince(m.gen);
        send({ type: 'result', reqId: m.reqId, result: stale() ? null : store.query(m.req, Date.now(), stale) });
        break;
      }
      case 'tick': {
        const stale = supersededSince(m.gen);
        send({ type: 'result', reqId: m.reqId, result: stale() ? null : store.tick(Date.now(), stale) });
        break;
      }
      case 'page':
        send({ type: 'page', reqId: m.reqId, hits: store.page(m.offset, m.count) });
        break;
      case 'context':
        send({ type: 'context', reqId: m.reqId, result: store.context(m.req) });
        break;
      case 'suggest':
        send({ type: 'suggest', reqId: m.reqId, result: store.suggest(m.req) });
        break;
    }
  } catch (e) {
    if (e instanceof Cancelled && 'reqId' in m) { send({ type: 'result', reqId: m.reqId, result: null }); return; }
    send({ type: 'error', reqId: 'reqId' in m ? m.reqId : undefined, message: e instanceof Error ? e.stack || e.message : String(e) });
  }
});
