import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { SyncStore, validateOperation } from './sync-store.mjs';

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
      const validationError = validateOperation(body);
      const result = store.apply(body);
      const requestId = safeLogValue(body?.operation_id ?? 'missing');
      if (validationError) {
        console.warn(`[AlgoFlow] Sync push rejected. request_id=${requestId} status=rejected error=INVALID_REQUEST reason=${safeLogValue(validationError)}`);
      } else {
        console.log(`[AlgoFlow] Sync push handled. request_id=${requestId} status=${result.status} version=${result.version ?? 'none'}`);
      }
      response.statusCode = result.status === 'rejected' ? 400 : result.status === 'conflict' ? 409 : 200;
      response.end(JSON.stringify(result));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/sync/changes')) {
      const url = new URL(request.url, 'http://localhost');
      const after = url.searchParams.get('after') ?? '0';
      const result = store.pull(after);
      console.log(`[AlgoFlow] Sync pull handled. cursor=${safeLogValue(after)} changes=${result.changes.length} next_cursor=${safeLogValue(result.next_cursor)}`);
      response.end(JSON.stringify(result));
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

function safeLogValue(value) {
  return String(value).replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 96);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.SYNC_API_HOST ?? '0.0.0.0';
  const port = Number.parseInt(process.env.SYNC_API_PORT ?? '8787', 10);
  createSyncServer().listen(port, host, () => {
    console.log(`[AlgoFlow] Local sync skeleton: http://${host}:${port}`);
  });
}
