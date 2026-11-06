import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { PairingStore } from '../src/pairing-store.mjs';
import { RateLimiter } from '../src/rate-limiter.mjs';
import { createSyncServer } from '../src/server.mjs';
import { SCHEMA_VERSION, SqliteBackend } from '../src/sqlite-backend.mjs';
import { MAX_DRAFT_HISTORY, MAX_OPERATION_RECORDS, SyncStore } from '../src/sync-store.mjs';
import { IDLE_EMPTY_WORKSPACE_MS, INACTIVE_WORKSPACE_MS, MemoryBackend, WorkspaceDirectory } from '../src/workspace-directory.mjs';

// The shared suites once more, on SQLite. Their own files run them in memory.
await import('./sync-store.test.mjs?backend=sqlite');
await import('./workspace-auth.test.mjs?backend=sqlite');
await import('./pairing.test.mjs?backend=sqlite');

const BACKENDS = [['memory', () => new MemoryBackend()], ['sqlite', () => new SqliteBackend(':memory:')]];
const WEB = { kind: 'web', name: null };

function draftOperation(operationId, baseVersion, payload = {}, entityId = 'draft-1') {
  return {
    operation_id: operationId, entity_type: 'draft', entity_id: entityId, operation_type: 'upsert', base_version: baseVersion,
    client_id: 'web-1', occurred_at: '2026-11-06T00:00:00.000Z', payload: { title: 'Draft', ...payload }
  };
}

function draftDelete(operationId, baseVersion, entityId = 'draft-1') {
  return { ...draftOperation(operationId, baseVersion, {}, entityId), operation_type: 'delete', payload: { deleted: true } };
}

function storeOn(backend, quota) {
  backend.createWorkspace({ workspace_id: 'workspace-1', epoch: 'epoch-1', created_at: '2026-11-06T00:00:00.000Z' });
  const storage = backend.storage('workspace-1');
  return { storage, store: new SyncStore(storage, quota) };
}

async function tempDatabase(context) {
  const directory = await mkdtemp(join(tmpdir(), 'algoflow-sync-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'sync.db');
}

async function listen(server, context) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, path, { token, body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: token ? { Authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
  };
}

function quietConsole(context) {
  const logs = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(originals)) console[level] = (...args) => { logs.push(args.join(' ')); };
  context.after(() => Object.assign(console, originals));
  return logs;
}

for (const [name, newBackend] of BACKENDS) {
  test(`${name}: a pull returns only the latest change of each entity, in cursor order`, () => {
    const { store } = storeOn(newBackend());
    store.apply(draftOperation('op-1', 0));
    store.apply(draftOperation('op-2', 0, {}, 'draft-2'));
    store.apply(draftOperation('op-3', 1, { title: 'v2' }));
    const all = store.pull('0');
    assert.deepEqual(all.changes.map((change) => [change.cursor, change.entity.id, change.entity.version]), [['2', 'draft-2', 1], ['3', 'draft-1', 2]]);
    assert.equal(all.next_cursor, '3');
    assert.deepEqual(store.pull('2').changes.map((change) => change.entity.title), ['v2']);
    assert.deepEqual(store.pull('3'), { changes: [], next_cursor: '3', server_epoch: 'epoch-1', reset: false });
  });

  test(`${name}: each Draft keeps its last ${MAX_DRAFT_HISTORY} versions and a delete drops them`, () => {
    const { storage, store } = storeOn(newBackend());
    for (let version = 0; version < 60; version += 1) assert.equal(store.apply(draftOperation(`op-${version + 1}`, version, { title: `v${version + 1}` })).status, 'applied');
    assert.equal(storage.draftSnapshot('draft-1', 10), undefined);
    assert.equal(storage.draftSnapshot('draft-1', 11).title, 'v11');
    assert.equal(storage.draftSnapshot('draft-1', 60).title, 'v60');

    // A retry gets the version it produced while that snapshot is kept, and
    // the current Draft once it is gone.
    assert.deepEqual(pick(store.apply(draftOperation('op-30', 29))), { status: 'duplicate', version: 30, entity_version: 30 });
    assert.deepEqual(pick(store.apply(draftOperation('op-2', 1))), { status: 'duplicate', version: 2, entity_version: 60 });

    const before = storage.usage().bytes;
    assert.equal(store.apply(draftDelete('op-delete', 60)).status, 'applied');
    assert.equal(storage.draftSnapshot('draft-1', 60), undefined);
    assert.ok(storage.usage().bytes < before / 10, 'the history no longer counts against the quota');
  });

  test(`${name}: only the last ${MAX_OPERATION_RECORDS} operations are remembered for retries`, () => {
    const { store } = storeOn(newBackend());
    const total = MAX_OPERATION_RECORDS + 5;
    for (let index = 0; index < total; index += 1) store.apply(draftOperation(`op-${index}`, 0, {}, `draft-${index}`));
    assert.equal(store.apply(draftOperation(`op-${total - 1}`, 0, {}, `draft-${total - 1}`)).status, 'duplicate');
    // A forgotten retry is checked like a new operation; the version tells it apart.
    assert.equal(store.apply(draftOperation('op-0', 0, {}, 'draft-0')).error_code, 'VERSION_CONFLICT');
  });

  test(`${name}: a full workspace refuses new data but still takes edits that fit and deletes`, () => {
    const { storage, store } = storeOn(newBackend(), { entries: 2, bytes: 4096 });
    assert.equal(store.apply(draftOperation('op-1', 0)).status, 'applied');
    assert.equal(store.apply(draftOperation('op-2', 0, {}, 'draft-2')).status, 'applied');
    const full = store.apply(draftOperation('op-3', 0, {}, 'draft-3'));
    assert.deepEqual({ status: full.status, error_code: full.error_code }, { status: 'rejected', error_code: 'WORKSPACE_QUOTA_EXCEEDED' });
    assert.equal(store.apply(draftOperation('op-edit', 1, { title: 'edited' })).status, 'applied');
    assert.equal(store.apply(draftOperation('op-big', 2, { code: 'x'.repeat(4096) })).error_code, 'WORKSPACE_QUOTA_EXCEEDED');
    assert.equal(store.apply(draftDelete('op-delete', 1, 'draft-2')).status, 'applied');
    // A refused operation was not recorded, so its retry is applied now.
    assert.equal(store.apply(draftOperation('op-3', 0, {}, 'draft-3')).status, 'applied');
    assert.equal(storage.usage().entries, 2);
  });

  test(`${name}: workspaces expire after 180 unused days, or after 24 hours if they never got data`, (context) => {
    const logs = quietConsole(context);
    const time = { now: Date.parse('2026-01-01T00:00:00.000Z') };
    const directory = new WorkspaceDirectory({ now: () => time.now, backend: newBackend() });
    const empty = directory.create(WEB);
    const used = directory.create(WEB);
    directory.authenticate(used.device_token).store.apply(draftOperation('op-1', 0));

    time.now += IDLE_EMPTY_WORKSPACE_MS + 60_000;
    assert.equal(directory.authenticate(empty.device_token), null, 'the expiry runs on the next request');
    assert.ok(directory.authenticate(used.device_token), 'using the workspace moves its deadline');
    assert.deepEqual(logs, ['[AlgoFlow] Expired workspaces deleted. count=1']);

    time.now += INACTIVE_WORKSPACE_MS - 60_000;
    assert.equal(directory.purgeExpired(), 0);
    time.now += 2 * 60_000;
    assert.equal(directory.purgeExpired(), 1);
    assert.equal(directory.size, 0);
  });
}

test('a SQLite file keeps workspaces, tokens, data and the epoch across a restart', async (context) => {
  const path = await tempDatabase(context);
  let backend = new SqliteBackend(path);
  const created = new WorkspaceDirectory({ backend }).create(WEB);
  const before = new WorkspaceDirectory({ backend }).authenticate(created.device_token).store;
  assert.equal(before.apply(draftOperation('op-1', 0)).status, 'applied');
  backend.close();

  backend = new SqliteBackend(path);
  const after = new WorkspaceDirectory({ backend }).authenticate(created.device_token);
  assert.equal(after.workspace_id, created.workspace_id);
  assert.equal(after.store.epoch, before.epoch);
  assert.deepEqual(after.store.pull('0').changes.map((change) => change.entity.title), ['Draft']);
  assert.equal(after.store.apply(draftOperation('op-1', 0)).status, 'duplicate');
  assert.equal(after.store.apply(draftOperation('op-2', 1)).version, 2);
  backend.close();

  const raw = new DatabaseSync(path);
  try {
    assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.match(raw.prepare('SELECT token_hash FROM devices').get().token_hash, /^[0-9a-f]{64}$/);
  } finally {
    raw.close();
  }
  for (const file of [path, `${path}-wal`]) {
    if (existsSync(file)) assert.equal((await readFile(file)).includes(created.device_token), false, `${file} holds only the token hash`);
  }
});

test('a database written by a newer server is refused instead of being modified', async (context) => {
  const path = await tempDatabase(context);
  new SqliteBackend(path).close();
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => new SqliteBackend(path), /SYNC_DB_SCHEMA_TOO_NEW/);
});

test('a failed apply rolls back every write of that operation', () => {
  const backend = new SqliteBackend(':memory:');
  const { storage, store } = storeOn(backend);
  store.apply(draftOperation('op-1', 0));
  const original = storage.commit;
  storage.commit = function (change) {
    original.call(this, change);
    throw new Error('disk full');
  };
  assert.throws(() => store.apply(draftOperation('op-2', 1, { title: 'lost' })), /disk full/);
  storage.commit = original;
  assert.equal(storage.lastCursor(), 1);
  assert.equal(storage.entity('draft', 'draft-1').title, 'Draft');
  assert.equal(storage.operation('op-2'), undefined);
  assert.equal(store.apply(draftOperation('op-2', 1, { title: 'kept' })).status, 'applied');
});

test('the rate limiter counts per key and resets after its window', () => {
  const time = { now: 0 };
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => time.now });
  assert.deepEqual([limiter.take('a'), limiter.take('a'), limiter.take('b')], [0, 0, 0]);
  time.now = 400;
  assert.equal(limiter.take('a'), 600);
  assert.equal(limiter.take('a'), 600, 'a refused request does not extend the window');
  time.now = 1000;
  assert.equal(limiter.take('a'), 0);
});

test('workspace creation and device requests answer 429 with Retry-After', async (context) => {
  const logs = quietConsole(context);
  const time = { now: Date.parse('2026-11-06T00:00:00.000Z') };
  const call = await listen(createSyncServer({ now: () => time.now, limits: { workspacesPerHour: 2, requestsPerMinute: 3 } }), context);
  const first = (await call('POST', '/v1/workspaces', { body: {} })).body;
  const second = (await call('POST', '/v1/workspaces', { body: {} })).body;
  assert.deepEqual(await call('POST', '/v1/workspaces', { body: {} }), { status: 429, retryAfter: '3600', body: { status: 'rejected', error_code: 'RATE_LIMITED' } });

  for (let index = 0; index < 3; index += 1) assert.equal((await call('GET', '/v1/sync/changes', { token: first.device_token })).status, 200);
  const limited = await call('GET', '/v1/sync/changes', { token: first.device_token });
  assert.deepEqual([limited.status, limited.retryAfter, limited.body.error_code], [429, '60', 'RATE_LIMITED']);
  assert.equal((await call('GET', '/v1/sync/changes', { token: second.device_token })).status, 200, 'each device has its own budget');

  time.now += 60_000;
  assert.equal((await call('GET', '/v1/sync/changes', { token: first.device_token })).status, 200);
  time.now += 60 * 60_000;
  assert.equal((await call('POST', '/v1/workspaces', { body: {} })).status, 201);
  assert.equal(logs.some((line) => line.includes(first.device_token) || line.includes(second.device_token)), false);
});

test('pairing guesses, a full server and a full workspace get their own status codes', async (context) => {
  quietConsole(context);
  const directory = new WorkspaceDirectory({ maxWorkspaces: 1, quota: { entries: 1, bytes: 1024 * 1024 } });
  const call = await listen(createSyncServer({ directory, pairing: new PairingStore({ directory, maxFailedClaims: 1 }) }), context);
  const { device_token: token } = (await call('POST', '/v1/workspaces', { body: {} })).body;
  assert.deepEqual(await call('POST', '/v1/workspaces', { body: {} }), { status: 503, retryAfter: '3600', body: { status: 'rejected', error_code: 'SERVER_AT_CAPACITY' } });

  const guess = { code: '00000000', phone_client_id: 'phone-1' };
  assert.equal((await call('POST', '/v1/pairing/claims', { body: guess })).status, 404);
  const limited = await call('POST', '/v1/pairing/claims', { body: guess });
  assert.deepEqual([limited.status, limited.retryAfter, limited.body.error_code], [429, '60', 'PAIRING_RATE_LIMITED']);

  assert.equal((await call('POST', '/v1/sync/operations', { token, body: draftOperation('op-1', 0) })).status, 200);
  const full = await call('POST', '/v1/sync/operations', { token, body: draftOperation('op-2', 0, {}, 'draft-2') });
  assert.deepEqual([full.status, full.body.error_code], [507, 'WORKSPACE_QUOTA_EXCEEDED']);
});

test('the sync-api process keeps data in SYNC_DB_PATH across a restart', async (context) => {
  const path = await tempDatabase(context);
  const start = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
      env: { ...process.env, SYNC_DB_PATH: path, SYNC_API_HOST: '127.0.0.1', SYNC_API_PORT: '0' }, stdio: ['ignore', 'pipe', 'ignore']
    });
    const base = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /Sync API: (http:\/\/\S+) storage=sqlite/.exec(output);
        if (match) resolve(match[1]);
      });
      child.once('exit', (code) => reject(new Error(`sync-api exited early: ${code}`)));
    });
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    context.after(() => { child.kill(); return stopped; });
    return { base, stop: () => { child.kill(); return stopped; } };
  };
  const request = async (base, method, path, token, body) => (await fetch(`${base}${path}`, {
    method, headers: token ? { Authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body)
  })).json();

  const first = await start();
  const { device_token: token } = await request(first.base, 'POST', '/v1/workspaces', null, {});
  assert.equal((await request(first.base, 'POST', '/v1/sync/operations', token, draftOperation('op-1', 0))).status, 'applied');
  const { server_epoch: epoch } = await request(first.base, 'GET', '/v1/sync/changes', token);
  // On Windows this is a hard kill: committed writes must survive without a clean close.
  await first.stop();

  const second = await start();
  const pulled = await request(second.base, 'GET', `/v1/sync/changes?after=0&epoch=${epoch}`, token);
  assert.deepEqual({ epoch: pulled.server_epoch, reset: pulled.reset, titles: pulled.changes.map((change) => change.entity.title) }, { epoch, reset: false, titles: ['Draft'] });
  await second.stop();
});

function pick(result) {
  return { status: result.status, version: result.version, entity_version: result.server_entity?.version };
}
