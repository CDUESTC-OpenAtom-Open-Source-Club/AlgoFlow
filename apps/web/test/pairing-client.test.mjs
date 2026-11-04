import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPairingInvitation, createPairingSession, getPairingSession, isLoopbackEndpoint } from '../src/pairing-client.mjs';
import { LocalSyncClient } from '../src/sync-client.mjs';
import { createSyncServer } from '../../../services/sync-api/src/server.mjs';
import { validatePairingInvitation } from '../../../packages/contracts/validate.mjs';

test('Web pairing invitation satisfies the shared contract', () => {
  const text = buildPairingInvitation('http://192.168.1.20:8787/', '04829103');
  assert.deepEqual(JSON.parse(text), { type: 'algoflow-pair-v1', sync_api: 'http://192.168.1.20:8787', code: '04829103' });
  assert.deepEqual(validatePairingInvitation(JSON.parse(text)), []);
});

test('detects loopback endpoints that a phone cannot reach directly', () => {
  assert.equal(isLoopbackEndpoint('http://127.0.0.1:8787'), true);
  assert.equal(isLoopbackEndpoint('http://localhost:8787'), true);
  assert.equal(isLoopbackEndpoint('http://192.168.1.20:8787'), false);
  assert.equal(isLoopbackEndpoint('not a url'), false);
});

test('Web creates a session with its device token, sees the phone claim it, and the status never echoes the code', async () => {
  const server = createSyncServer();
  const logs = console.log;
  console.log = () => {};
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { device_token: token } = await new LocalSyncClient(base).createWorkspace();
    const request = { desktop_client_id: 'web-1', computer_name: 'AlgoFlow-Desktop', route: 'lan', sync_api: base };
    await assert.rejects(createPairingSession(base, request, ''), /AUTH_REQUIRED/);

    const session = await createPairingSession(base, request, token);
    assert.match(session.code, /^\d{8}$/);
    assert.equal((await getPairingSession(base, session.pairing_id, token)).state, 'pending');
    await assert.rejects(getPairingSession(base, session.pairing_id, 'A'.repeat(43)), /AUTH_REQUIRED/);

    const claim = await fetch(`${base}/v1/pairing/claims`, {
      method: 'POST', body: JSON.stringify({ code: session.code, phone_client_id: 'phone-1' })
    });
    assert.equal(claim.status, 200);
    const status = await getPairingSession(base, session.pairing_id, token);
    assert.equal(status.state, 'claimed');
    assert.equal(status.phone_client_id, 'phone-1');
    assert.equal(status.code, undefined);

    await assert.rejects(createPairingSession(base, { ...request, route: 'cloud' }, token), /INVALID_REQUEST/);
  } finally {
    console.log = logs;
    await new Promise((resolve) => server.close(resolve));
  }
});
