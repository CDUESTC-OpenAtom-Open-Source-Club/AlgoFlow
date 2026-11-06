import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PAIRING_TTL_MS, PairingStore } from '../src/pairing-store.mjs';
import { createSyncServer } from '../src/server.mjs';
import { MemoryBackend, WorkspaceDirectory } from '../src/workspace-directory.mjs';
import { validatePairingInvitation } from '../../../packages/contracts/validate.mjs';

// persistence.test.mjs imports this file again with ?backend=sqlite, so every
// test here also runs against SQLite.
const sqlite = new URL(import.meta.url).searchParams.get('backend') === 'sqlite' ? await import('../src/sqlite-backend.mjs') : null;
const newBackend = () => sqlite ? new sqlite.SqliteBackend(':memory:') : new MemoryBackend();

const sessionRequest = {
  desktop_client_id: 'web-desktop-1',
  computer_name: 'AlgoFlow-Desktop',
  route: 'lan',
  sync_api: 'http://192.168.1.20:8787/',
  ai_gateway: 'http://192.168.1.20:8788'
};

function clock(start = Date.parse('2026-10-22T00:00:00.000Z')) {
  const state = { now: start };
  return { state, now: () => state.now };
}

function setup(time = clock()) {
  const directory = new WorkspaceDirectory({ now: time.now, backend: newBackend() });
  const store = new PairingStore({ now: time.now, directory });
  const web = directory.create({ kind: 'web', name: null });
  return { time, directory, store, web };
}

test('shared pairing invitation vectors match the contract validator', async (t) => {
  const vectors = JSON.parse(await readFile(new URL('../../../packages/contracts/vectors/pairing-invitations.json', import.meta.url), 'utf8'));
  for (const vector of vectors.invitations) {
    await t.test(vector.name, () => {
      let parsed;
      try { parsed = JSON.parse(vector.text); } catch { parsed = undefined; }
      assert.equal(validatePairingInvitation(parsed).length === 0, vector.valid);
    });
  }
});

test('creates an 8-digit pending session and lets one phone join the workspace with a device token', () => {
  const { directory, store, web } = setup();
  const created = store.create(sessionRequest, web);
  assert.equal(created.status, 'created');
  assert.match(created.session.code, /^\d{8}$/);
  assert.equal(created.session.state, 'pending');
  assert.equal(created.session.sync_api, 'http://192.168.1.20:8787');

  const claimed = store.claim({ code: created.session.code, phone_client_id: 'phone-1' });
  const { device_token: token, ...endpoints } = claimed;
  assert.deepEqual(endpoints, {
    status: 'claimed', pairing_id: created.session.pairing_id, computer_name: 'AlgoFlow-Desktop', route: 'lan',
    sync_api: 'http://192.168.1.20:8787', ai_gateway: 'http://192.168.1.20:8788'
  });
  assert.equal(directory.authenticate(token).workspace_id, web.workspace_id);
  const status = store.get(created.session.pairing_id, web).session;
  assert.equal(status.state, 'claimed');
  assert.equal(status.phone_client_id, 'phone-1');
  assert.equal('code' in status, false, 'status polling must not echo the code');
  assert.equal(store.claim({ code: created.session.code, phone_client_id: 'phone-2' }).error_code, 'PAIRING_CODE_USED');
  assert.equal(directory.listDevices(web.workspace_id).length, 2, 'a rejected claim must not add a device');
});

test('ai_gateway is optional and is omitted from the session and the claim', () => {
  const { store, web } = setup();
  const { ai_gateway: _unused, ...request } = sessionRequest;
  const created = store.create(request, web);
  assert.equal(created.status, 'created');
  assert.equal('ai_gateway' in created.session, false);
  assert.equal('ai_gateway' in store.claim({ code: created.session.code, phone_client_id: 'phone-1' }), false);
});

test('rejects expired, unknown and malformed codes', () => {
  const { time, store, web } = setup();
  const created = store.create(sessionRequest, web);
  assert.equal(store.claim({ code: '1234567', phone_client_id: 'phone-1' }).error_code, 'INVALID_REQUEST');
  assert.equal(store.claim({ code: created.session.code, phone_client_id: ' ' }).error_code, 'INVALID_REQUEST');
  assert.equal(store.claim({ code: created.session.code, phone_client_id: 'x'.repeat(129) }).error_code, 'INVALID_REQUEST');
  assert.equal(store.claim({ code: created.session.code, phone_client_id: 'phone-1', device_name: 42 }).error_code, 'INVALID_REQUEST');
  const unknown = created.session.code === '00000000' ? '00000001' : '00000000';
  assert.equal(store.claim({ code: unknown, phone_client_id: 'phone-1' }).error_code, 'PAIRING_CODE_INVALID');

  time.state.now += PAIRING_TTL_MS;
  assert.equal(store.get(created.session.pairing_id, web).session.state, 'expired');
  assert.equal(store.claim({ code: created.session.code, phone_client_id: 'phone-1' }).error_code, 'PAIRING_CODE_EXPIRED');
});

test('refreshing the code revokes the previous pending session of the same desktop', () => {
  const { store, web } = setup();
  const first = store.create(sessionRequest, web).session;
  const second = store.create(sessionRequest, web).session;
  assert.equal(store.get(first.pairing_id, web).session.state, 'revoked');
  assert.notEqual(store.claim({ code: first.code, phone_client_id: 'phone-1' }).status, 'claimed');
  assert.equal(store.claim({ code: second.code, phone_client_id: 'phone-1' }).status, 'claimed');
});

test('another device using the same client id does not revoke the session', () => {
  const { directory, store, web } = setup();
  const first = store.create(sessionRequest, web).session;
  store.create(sessionRequest, directory.create({ kind: 'web', name: null }));
  assert.equal(store.get(first.pairing_id, web).session.state, 'pending');
});

test('a code whose creator was removed can no longer be claimed', () => {
  const { directory, store, web } = setup();
  const second = directory.addDevice(web.workspace_id, { kind: 'web', name: null });
  const { code } = store.create(sessionRequest, web).session;
  directory.removeDevice(web.workspace_id, web.device_id);
  assert.equal(store.claim({ code, phone_client_id: 'phone-1' }).error_code, 'PAIRING_CODE_INVALID');
  assert.deepEqual(directory.listDevices(web.workspace_id).map((device) => device.device_id), [second.device_id]);
});

test('rate-limits repeated failed claims per address within a minute', () => {
  const { time, store, web } = setup();
  const created = store.create(sessionRequest, web).session;
  const wrong = created.code === '00000000' ? '00000001' : '00000000';
  for (let i = 0; i < 10; i++) {
    assert.equal(store.claim({ code: wrong, phone_client_id: 'phone-x' }, { ip: '198.51.100.7' }).error_code, 'PAIRING_CODE_INVALID');
  }
  assert.equal(store.claim({ code: created.code, phone_client_id: 'phone-1' }, { ip: '198.51.100.7' }).error_code, 'PAIRING_RATE_LIMITED');
  // The guesser must not be able to lock everybody else out.
  assert.equal(store.claim({ code: created.code, phone_client_id: 'phone-1' }, { ip: '203.0.113.9' }).status, 'claimed');

  const next = store.create(sessionRequest, web).session;
  assert.equal(store.claim({ code: next.code, phone_client_id: 'phone-2' }, { ip: '198.51.100.7' }).error_code, 'PAIRING_RATE_LIMITED');
  time.state.now += 61 * 1000;
  assert.equal(store.claim({ code: next.code, phone_client_id: 'phone-2' }, { ip: '198.51.100.7' }).status, 'claimed');
});

test('rejects session requests with invalid route or endpoints', () => {
  const { store, web } = setup();
  for (const patch of [{ route: 'cloud' }, { sync_api: 'ftp://host' }, { ai_gateway: 'not a url' },
    { sync_api: 'http://user:pw@host:8787' }, { computer_name: '' }, { desktop_client_id: '' }, { desktop_client_id: 'x'.repeat(129) }]) {
    assert.equal(store.create({ ...sessionRequest, ...patch }, web).error_code, 'INVALID_REQUEST', JSON.stringify(patch));
  }
});

test('sync-api pairing routes create, claim and report status over HTTP', async () => {
  const server = createSyncServer({ directory: new WorkspaceDirectory({ backend: newBackend() }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    const { device_token: webToken } = await (await fetch(`${base}/v1/workspaces`, { method: 'POST', body: '{}' })).json();
    const authorization = { Authorization: `Bearer ${webToken}` };

    const anonymous = await fetch(`${base}/v1/pairing/sessions`, { method: 'POST', body: JSON.stringify(sessionRequest) });
    assert.equal(anonymous.status, 401);

    const createdResponse = await fetch(`${base}/v1/pairing/sessions`, { method: 'POST', headers: authorization, body: JSON.stringify(sessionRequest) });
    assert.equal(createdResponse.status, 201);
    const { session } = await createdResponse.json();

    const wrong = await fetch(`${base}/v1/pairing/claims`, { method: 'POST', body: JSON.stringify({ code: '1234', phone_client_id: 'p' }) });
    assert.equal(wrong.status, 400);

    const claimed = await fetch(`${base}/v1/pairing/claims`, { method: 'POST', body: JSON.stringify({ code: session.code, phone_client_id: 'phone-1' }) });
    assert.equal(claimed.status, 200);
    const claim = await claimed.json();
    assert.equal(claim.ai_gateway, 'http://192.168.1.20:8788');
    assert.match(claim.device_token, /^[A-Za-z0-9_-]{43}$/);

    const reused = await fetch(`${base}/v1/pairing/claims`, { method: 'POST', body: JSON.stringify({ code: session.code, phone_client_id: 'phone-2' }) });
    assert.equal(reused.status, 409);

    const status = await fetch(`${base}/v1/pairing/sessions/${encodeURIComponent(session.pairing_id)}`, { headers: authorization });
    assert.equal((await status.json()).session.state, 'claimed');
    assert.equal((await fetch(`${base}/v1/pairing/sessions/missing`, { headers: authorization })).status, 404);
    assert.equal(logs.some((line) => line.includes(session.code)), false, 'pairing code must not be logged');
    assert.equal(logs.some((line) => line.includes(webToken) || line.includes(claim.device_token)), false, 'device tokens must not be logged');
  } finally {
    console.log = original;
    await new Promise((resolve) => server.close(resolve));
  }
});
