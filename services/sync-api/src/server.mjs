import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { SyncStore } from './sync-store.mjs';

export function createSyncServer(store = new SyncStore()) {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/sync/operations') {
      const body = await readJson(request);
      const result = store.apply(body);
      response.statusCode = result.status === 'rejected' ? 400 : result.status === 'conflict' ? 409 : 200;
      response.end(JSON.stringify(result));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/sync/changes')) {
      const url = new URL(request.url, 'http://localhost');
      response.end(JSON.stringify(store.pull(url.searchParams.get('after') ?? '0')));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createSyncServer().listen(8787, '127.0.0.1', () => console.log('[AlgoFlow] Local sync skeleton: http://127.0.0.1:8787'));
}
