import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PAIRING_TTL_MS, PairingStore } from '../src/pairing-store.mjs';
import { createSyncServer } from '../src/server.mjs';
import { SyncStore } from '../src/sync-store.mjs';
import { validatePairingInvitation } from '../../../packages/contracts/validate.mjs';

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

test('creates an 8-digit pending session and hands endpoints to the claiming phone once', () => {
  const store = new PairingStore(clock().now);
  const created = store.create(sessionRequest);
  assert.equal(created.status, 'created');
  assert.match(created.session.code, /^\d{8}$/);
  assert.equal(created.session.state, 'pending');
  assert.equal(created.session.sync_api, 'http://192.168.1.20:8787');

  const claimed = store.claim({ code: created.session.code, phone_client_id: 'phone-1' });
  assert.deepEqual(claimed, {
    status: 'claimed', pairing_id: created.session.pairing_id, computer_name: 'AlgoFlow-Desktop', route: 'lan',
    sync_api: 'http://192.168.1.20:8787', ai_gateway: 'http://192.168.1.20:8788'
  });
  const status = store.get(created.session.pairing_id).session;
  assert.equal(status.state, 'claimed');
  assert.equal(status.phone_client_id, 'phone-1');
  assert.equal('code' in status, false, 'status polling must not echo the code');
  assert.equal(store.claim({ code: created.session.code, phone_client_id: 'phone-2' }).error_code, 'PAIRING_CODE_USED');
});

test('rejects expired, unknown and malformed codes', () => {
  const time = clock();
  const store = new PairingStore(time.now);
  const created = store.create(sessionRequest);
  assert.equal(store.claim({ code: '1234567', phone_client_id: 'phone-1' }).error_code, 'INVALID_REQUEST');
  assert.equal(store.claim({ code: created.session.code, phone_client_id: ' ' }).error_code, 'INVALID_REQUEST');
  const unknown = created.session.code === '00000000' ? '00000001' : '00000000';
  assert.equal(store.claim({ code: unknown, phone_client_id: 'phone-1' }).error_code, 'PAIRING_CODE_INVALID');

  time.state.now += PAIRING_TTL_MS;
  assert.equal(store.get(created.session.pairing_id).session.state, 'expired');
  assert.equal(store.claim({ code: created.session.code, phone_client_id: 'phone-1' }).error_code, 'PAIRING_CODE_EXPIRED');
});

test('refreshing the code revokes the previous pending session of the same desktop', () => {
  const store = new PairingStore(clock().now);
  const first = store.create(sessionRequest).session;
  const second = store.create(sessionRequest).session;
  assert.equal(store.get(first.pairing_id).session.state, 'revoked');
  assert.notEqual(store.claim({ code: first.code, phone_client_id: 'phone-1' }).status, 'claimed');
  assert.equal(store.claim({ code: second.code, phone_client_id: 'phone-1' }).status, 'claimed');
});

test('rate-limits repeated failed claims within a minute', () => {
  const time = clock();
  const store = new PairingStore(time.now);
  const created = store.create(sessionRequest).session;
  const wrong = created.code === '00000000' ? '00000001' : '00000000';
  for (let i = 0; i < 10; i++) assert.equal(store.claim({ code: wrong, phone_client_id: 'phone-x' }).error_code, 'PAIRING_CODE_INVALID');
  assert.equal(store.claim({ code: created.code, phone_client_id: 'phone-1' }).error_code, 'PAIRING_RATE_LIMITED');
  time.state.now += 61 * 1000;
  assert.equal(store.claim({ code: created.code, phone_client_id: 'phone-1' }).status, 'claimed');
});

test('rejects session requests with invalid route or endpoints', () => {
  const store = new PairingStore(clock().now);
  for (const patch of [{ route: 'cloud' }, { sync_api: 'ftp://host' }, { ai_gateway: 'not a url' },
    { sync_api: 'http://user:pw@host:8787' }, { computer_name: '' }, { desktop_client_id: '' }]) {
    assert.equal(store.create({ ...sessionRequest, ...patch }).error_code, 'INVALID_REQUEST', JSON.stringify(patch));
  }
});

test('sync-api pairing routes create, claim and report status over HTTP', async () => {
  const server = createSyncServer(new SyncStore(), new PairingStore());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    const createdResponse = await fetch(`${base}/v1/pairing/sessions`, { method: 'POST', body: JSON.stringify(sessionRequest) });
    assert.equal(createdResponse.status, 201);
    const { session } = await createdResponse.json();

    const wrong = await fetch(`${base}/v1/pairing/claims`, { method: 'POST', body: JSON.stringify({ code: '1234', phone_client_id: 'p' }) });
    assert.equal(wrong.status, 400);

    const claimed = await fetch(`${base}/v1/pairing/claims`, { method: 'POST', body: JSON.stringify({ code: session.code, phone_client_id: 'phone-1' }) });
    assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).ai_gateway, 'http://192.168.1.20:8788');

    const reused = await fetch(`${base}/v1/pairing/claims`, { method: 'POST', body: JSON.stringify({ code: session.code, phone_client_id: 'phone-2' }) });
    assert.equal(reused.status, 409);

    const status = await fetch(`${base}/v1/pairing/sessions/${encodeURIComponent(session.pairing_id)}`);
    assert.equal((await status.json()).session.state, 'claimed');
    assert.equal((await fetch(`${base}/v1/pairing/sessions/missing`)).status, 404);
    assert.equal(logs.some((line) => line.includes(session.code)), false, 'pairing code must not be logged');
  } finally {
    console.log = original;
    await new Promise((resolve) => server.close(resolve));
  }
});
