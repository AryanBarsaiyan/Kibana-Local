/**
 * Runs the log store and query engine off the extension-host thread, so
 * scanning/sorting 200k rows never blocks other extensions.
 */
import { parentPort } from 'worker_threads';
import { FromWorker, ToWorker } from './protocol';
import { LogStore } from './store';

if (!parentPort) throw new Error('worker.ts must run in a worker thread');
const port = parentPort;
let store = new LogStore({ maxRows: 200_000, maxBytes: 512 * 1024 * 1024 });

const send = (m: FromWorker) => port.postMessage(m);

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
      case 'dropFile':
        store.dropFile(m.index, m.file);
        break;
      case 'dropIndex':
        store.dropIndex(m.index);
        break;
      case 'query':
        send({ type: 'result', reqId: m.reqId, result: store.query(m.req) });
        break;
      case 'tick':
        send({ type: 'result', reqId: m.reqId, result: store.tick() });
        break;
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
    send({ type: 'error', reqId: 'reqId' in m ? m.reqId : undefined, message: e instanceof Error ? e.stack || e.message : String(e) });
  }
});
