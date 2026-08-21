import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { validateAIArtifact, validateAIRequest } from './contracts.mjs';

export function createAIGateway() {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && request.url === '/status') {
      response.end(JSON.stringify({ enabled: false, code: 'AI_NOT_ENABLED' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/requests') {
      const body = await readJson(request);
      const errors = validateAIRequest(body);
      response.statusCode = errors.length ? 400 : 503;
      response.end(JSON.stringify(errors.length ? { code: 'INVALID_REQUEST', errors } : { code: 'AI_NOT_ENABLED' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/artifacts/validate') {
      const errors = validateAIArtifact(await readJson(request));
      response.statusCode = errors.length ? 422 : 200;
      response.end(JSON.stringify({ valid: errors.length === 0, errors }));
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
  createAIGateway().listen(8788, '127.0.0.1', () => console.log('[AlgoFlow] AI gateway skeleton: http://127.0.0.1:8788'));
}
