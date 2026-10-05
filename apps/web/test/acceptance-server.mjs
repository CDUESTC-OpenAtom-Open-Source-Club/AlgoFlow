// Explicit local-only acceptance infrastructure. Never imported by the app.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createAIGateway } from '../../../services/ai-gateway/src/server.mjs';
import { createSyncServer } from '../../../services/sync-api/src/server.mjs';
import { SyncStore } from '../../../services/sync-api/src/sync-store.mjs';
import { newDraft } from '../src/storage.mjs';
import { reviewResult, completionResult } from './ai-fixtures.mjs';

const store = new SyncStore();
for (const [id, newline] of [['acceptance-a', '\r\n'], ['acceptance-b', '\n']]) {
  const draft = { ...newDraft('fixture'), id, title: `测试草稿 ${id}`, idea: '累加当前元素',
    code: ['// fixture', 'int count = 0;', 'count += 1;', '// done'].join(newline) };
  store.apply({ operation_id: `seed-${id}`, entity_type: 'draft', entity_id: id,
    operation_type: 'upsert', base_version: 0, client_id: 'fixture', occurred_at: new Date().toISOString(), payload: draft });
}
let delayMs = 0;
let mode = 'test';
let aborts = 0;
let syncOnline = true;
const provider = {
  async review({ request, signal }) { await delay(signal); return reviewResult(request); },
  async complete({ request, signal }) {
    await delay(signal);
    return completionResult(request, { source_refs: [request.idea_segments[0].id], suggestion_text: 'count += 2;\ncount += 3;\n' });
  },
};
function delay(signal) {
  return new Promise((yes, no) => {
    const timer = setTimeout(done, delayMs);
    function done() { signal.removeEventListener('abort', abort); yes(); }
    function abort() { clearTimeout(timer); aborts++; no(new Error('aborted')); }
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
const testGateway = createAIGateway({ aiProvider: provider, responseHeaders: { 'X-AlgoFlow-Test-Data': 'true' } });
const disabledGateway = createAIGateway();
const sync = createSyncServer(store);
const dist = resolve(import.meta.dirname, '../dist');
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/acceptance-control' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    delayMs = value.delayMs ?? delayMs; mode = value.mode ?? mode; syncOnline = value.syncOnline ?? syncOnline;
    res.end(JSON.stringify({ delayMs, mode, syncOnline, aborts })); return;
  }
  if (url.pathname === '/acceptance-status') { res.end(JSON.stringify({ delayMs, mode, syncOnline, aborts })); return; }
  if (url.pathname.startsWith('/ai-api/')) {
    req.url = req.url.slice('/ai-api'.length);
    (mode === 'disabled' ? disabledGateway : testGateway).emit('request', req, res); return;
  }
  if (url.pathname.startsWith('/v1/sync/')) {
    if (!syncOnline) { res.setHeader('Access-Control-Allow-Origin', '*'); res.statusCode = 503; res.end('{}'); return; }
    if (delayMs) await new Promise(done => setTimeout(done, delayMs));
    sync.emit('request', req, res); return;
  }
  const path = resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!path.startsWith(dist + sep)) { res.statusCode = 403; res.end(); return; }
  try {
    const data = await readFile(path);
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] ?? 'application/octet-stream');
    res.end(data);
  } catch { res.statusCode = 404; res.end('Not found'); }
});
server.listen(18790, '127.0.0.1', () => console.log('[AlgoFlow] acceptance fixture at http://127.0.0.1:18790 (测试数据)'));
