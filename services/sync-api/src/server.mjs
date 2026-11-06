import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { DEFAULT_WORKSPACE_QUOTA, validateOperation } from './sync-store.mjs';
import { FAILED_CLAIM_WINDOW_MS, MAX_FAILED_CLAIMS, PairingStore } from './pairing-store.mjs';
import { RateLimiter } from './rate-limiter.mjs';
import { DEFAULT_MAX_WORKSPACES, MemoryBackend, WorkspaceDirectory, isDeviceName } from './workspace-directory.mjs';

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
// Workspace creations per client address per hour, requests per device per minute.
export const DEFAULT_LIMITS = Object.freeze({ workspacesPerHour: 10, requestsPerMinute: 600 });
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const PAIRING_HTTP_STATUS = {
  INVALID_REQUEST: 400,
  PAIRING_CODE_INVALID: 404,
  PAIRING_CODE_USED: 409,
  PAIRING_CODE_EXPIRED: 410,
  PAIRING_RATE_LIMITED: 429
};

const PUSH_REJECTED_HTTP_STATUS = {
  INVALID_AI_ARTIFACT: 422,
  WORKSPACE_QUOTA_EXCEEDED: 507
};

class PayloadTooLargeError extends Error {
  name = 'PayloadTooLargeError';
}

/**
 * Every /v1 route except workspace creation and pairing claims requires a
 * device token. The token alone selects the workspace; no request field can.
 *
 * @param {{
 *   now?: () => number,
 *   directory?: WorkspaceDirectory,
 *   pairing?: PairingStore,
 *   maxBodyBytes?: number,
 *   limits?: { workspacesPerHour?: number, requestsPerMinute?: number },
 *   trustProxy?: boolean,
 *   corsOrigin?: string
 * }} [options] pass `pairing` together with the `directory` it was built on.
 */
export function createSyncServer({
  now,
  directory = new WorkspaceDirectory({ now }),
  pairing = new PairingStore({ now, directory }),
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  limits = {},
  trustProxy = false,
  corsOrigin = '*'
} = {}) {
  const { workspacesPerHour, requestsPerMinute } = { ...DEFAULT_LIMITS, ...limits };
  const workspaceLimiter = new RateLimiter({ limit: workspacesPerHour, windowMs: HOUR_MS, now });
  const requestLimiter = new RateLimiter({ limit: requestsPerMinute, windowMs: MINUTE_MS, now });
  const handle = async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', corsOrigin);
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const url = parseRequestUrl(request.url);
    if (!url) return send(response, 400, rejected('INVALID_REQUEST'));
    const path = url.pathname;
    const readBody = () => readJson(request, maxBodyBytes);

    if (request.method === 'GET' && path === '/healthz') return send(response, 200, { status: 'ok' });
    if (request.method === 'POST' && path === '/v1/workspaces') {
      // Every attempt counts, so malformed requests are not a free retry.
      const retryAfterMs = workspaceLimiter.take(clientAddress(request, trustProxy));
      if (retryAfterMs > 0) return sendRateLimited(response, retryAfterMs, 'workspace_create');
      const body = await readBody();
      if (!body || typeof body !== 'object' || Array.isArray(body) || (body.device_name !== undefined && !isDeviceName(body.device_name))) {
        return send(response, 400, rejected('INVALID_REQUEST'));
      }
      const created = directory.create({ kind: 'web', name: body.device_name?.trim() ?? null });
      if (!created) {
        console.warn('[AlgoFlow] Workspace creation refused. error=SERVER_AT_CAPACITY');
        response.setHeader('Retry-After', String(HOUR_MS / 1000));
        return send(response, 503, rejected('SERVER_AT_CAPACITY'));
      }
      console.log(`[AlgoFlow] Workspace created. workspace_id=${safeLogValue(created.workspace_id)}`);
      return send(response, 201, { status: 'created', ...created });
    }
    if (request.method === 'POST' && path === '/v1/pairing/claims') {
      // The code and the tokens are credentials; never log them.
      const body = await readBody();
      const phone = directory.authenticate(bearerToken(request));
      const result = pairing.claim(body, { ip: clientAddress(request, trustProxy), phone });
      console.log(`[AlgoFlow] Pairing claim handled. status=${result.status} error=${result.error_code ?? 'none'} pairing_id=${safeLogValue(result.pairing_id ?? 'none')}`);
      if (result.error_code === 'PAIRING_RATE_LIMITED') response.setHeader('Retry-After', String(FAILED_CLAIM_WINDOW_MS / 1000));
      return send(response, result.status === 'claimed' ? 200 : PAIRING_HTTP_STATUS[result.error_code] ?? 400, result);
    }

    if (!path.startsWith('/v1/')) return send(response, 404, rejected('NOT_FOUND'));
    const auth = directory.authenticate(bearerToken(request));
    if (!auth) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      return send(response, 401, rejected('AUTH_REQUIRED'));
    }
    const retryAfterMs = requestLimiter.take(auth.device_id);
    if (retryAfterMs > 0) return sendRateLimited(response, retryAfterMs, 'device_requests');

    if (request.method === 'POST' && path === '/v1/sync/operations') {
      const body = await readBody();
      const validationError = validateOperation(body);
      const result = auth.store.apply(body);
      const requestId = safeLogValue(body?.operation_id ?? 'missing');
      if (validationError) {
        console.warn(`[AlgoFlow] Sync push rejected. request_id=${requestId} status=rejected error=INVALID_REQUEST reason=${safeLogValue(validationError)}`);
      } else {
        console.log(`[AlgoFlow] Sync push handled. request_id=${requestId} status=${result.status} version=${result.version ?? 'none'}`);
      }
      return send(response, result.status === 'rejected' ? PUSH_REJECTED_HTTP_STATUS[result.error_code] ?? 400 :result.status === 'conflict' ? 409 : 200, result);
    }
    if (request.method === 'GET' && path === '/v1/sync/changes') {
      const after = url.searchParams.get('after') ?? '0';
      const result = auth.store.pull(after, url.searchParams.get('epoch') ?? undefined);
      console.log(`[AlgoFlow] Sync pull handled. cursor=${safeLogValue(after)} changes=${result.changes.length} next_cursor=${safeLogValue(result.next_cursor)} reset=${result.reset}`);
      return send(response, 200, result);
    }
    if (request.method === 'POST' && path === '/v1/pairing/sessions') {
      const result = pairing.create(await readBody(), auth);
      if (result.status === 'created') {
        console.log(`[AlgoFlow] Pairing session created. pairing_id=${safeLogValue(result.session.pairing_id)} route=${result.session.route}`);
      } else {
        console.warn(`[AlgoFlow] Pairing session rejected. error=${result.error_code} reason=${safeLogValue(result.reason)}`);
      }
      return send(response, result.status === 'created' ? 201 : 400, result);
    }
    if (request.method === 'GET' && path.startsWith('/v1/pairing/sessions/')) {
      const pairingId = decodeSegment(path.slice('/v1/pairing/sessions/'.length));
      const result = pairingId === null ? rejected('PAIRING_NOT_FOUND') : pairing.get(pairingId, auth);
      return send(response, result.status === 'ok' ? 200 : 404, result);
    }
    if (request.method === 'GET' && path === '/v1/devices') {
      return send(response, 200, { status: 'ok', current_device_id: auth.device_id, devices: directory.listDevices(auth.workspace_id) });
    }
    if (request.method === 'DELETE' && path.startsWith('/v1/devices/')) {
      const segment = decodeSegment(path.slice('/v1/devices/'.length));
      const deviceId = segment === 'current' ? auth.device_id : segment;
      const result = deviceId === null ? { removed: false } : directory.removeDevice(auth.workspace_id, deviceId);
      if (!result.removed) return send(response, 404, rejected('DEVICE_NOT_FOUND'));
      console.log(`[AlgoFlow] Device removed. workspace_id=${safeLogValue(auth.workspace_id)} workspace_deleted=${result.workspace_deleted}`);
      return send(response, 200, { status: 'deleted', workspace_deleted: result.workspace_deleted });
    }
    if (request.method === 'DELETE' && path === '/v1/workspaces/current') {
      directory.deleteWorkspace(auth.workspace_id);
      console.log(`[AlgoFlow] Workspace deleted. workspace_id=${safeLogValue(auth.workspace_id)}`);
      return send(response, 200, { status: 'deleted' });
    }
    return send(response, 404, rejected('NOT_FOUND'));
  };

  return createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        send(response, 413, rejected('PAYLOAD_TOO_LARGE'));
        return;
      }
      // Only the error class: messages may echo request content.
      console.error(`[AlgoFlow] Sync request failed. error=${safeLogValue(error?.name ?? 'Error')}`);
      if (!response.headersSent && !response.destroyed) send(response, 500, rejected('INTERNAL_ERROR'));
      else response.destroy();
    }
  });
}

function send(response, status, body) {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

function rejected(errorCode) {
  return { status: 'rejected', error_code: errorCode };
}

function sendRateLimited(response, retryAfterMs, rule) {
  console.warn(`[AlgoFlow] Request rate limited. rule=${rule}`);
  response.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  send(response, 429, rejected('RATE_LIMITED'));
}

function parseRequestUrl(raw) {
  try { return new URL(raw ?? '/', 'http://localhost'); }
  catch { return null; }
}

function decodeSegment(segment) {
  if (segment.length === 0 || segment.includes('/')) return null;
  try { return decodeURIComponent(segment); }
  catch { return null; }
}

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? '');
  return match ? match[1] : null;
}

// X-Real-IP is only trusted behind a reverse proxy that overwrites it.
function clientAddress(request, trustProxy) {
  const forwarded = request.headers['x-real-ip'];
  if (trustProxy && typeof forwarded === 'string' && forwarded.trim().length > 0) return forwarded.trim().slice(0, 64);
  return request.socket.remoteAddress ?? 'unknown';
}

// An oversized body is drained rather than cut off, so the client still reads
// the 413 instead of a connection reset.
async function readJson(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) throw new PayloadTooLargeError();
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

function safeLogValue(value) {
  return String(value).replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 96);
}

// An unset or invalid value falls back to the default.
function positiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.SYNC_API_HOST ?? '0.0.0.0';
  const port = Number.parseInt(process.env.SYNC_API_PORT ?? '8787', 10);
  // Without SYNC_DB_PATH everything stays in memory and is lost on restart.
  const dbPath = process.env.SYNC_DB_PATH;
  const backend = dbPath ? new (await import('./sqlite-backend.mjs')).SqliteBackend(dbPath) : new MemoryBackend();
  const directory = new WorkspaceDirectory({
    backend,
    maxWorkspaces: positiveIntegerEnv('SYNC_LIMIT_WORKSPACES', DEFAULT_MAX_WORKSPACES),
    quota: {
      entries: positiveIntegerEnv('SYNC_LIMIT_WORKSPACE_ENTRIES', DEFAULT_WORKSPACE_QUOTA.entries),
      bytes: positiveIntegerEnv('SYNC_LIMIT_WORKSPACE_BYTES', DEFAULT_WORKSPACE_QUOTA.bytes)
    }
  });
  const server = createSyncServer({
    directory,
    pairing: new PairingStore({ directory, maxFailedClaims: positiveIntegerEnv('SYNC_LIMIT_PAIRING_FAILURES_PER_MINUTE', MAX_FAILED_CLAIMS) }),
    maxBodyBytes: positiveIntegerEnv('SYNC_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
    limits: {
      workspacesPerHour: positiveIntegerEnv('SYNC_LIMIT_WORKSPACES_PER_HOUR', DEFAULT_LIMITS.workspacesPerHour),
      requestsPerMinute: positiveIntegerEnv('SYNC_LIMIT_REQUESTS_PER_MINUTE', DEFAULT_LIMITS.requestsPerMinute)
    },
    trustProxy: process.env.SYNC_TRUST_PROXY === '1',
    corsOrigin: process.env.SYNC_CORS_ORIGIN || '*'
  });
  server.listen(port, host, () => {
    console.log(`[AlgoFlow] Sync API: http://${host}:${server.address().port} storage=${dbPath ? 'sqlite' : 'memory'}`);
  });
  // Storage calls are synchronous, so no transaction is open when a signal runs.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close();
      backend.close?.();
      process.exit(0);
    });
  }
}
