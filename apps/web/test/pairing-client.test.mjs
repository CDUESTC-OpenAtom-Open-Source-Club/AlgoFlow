import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPairingInvitation, createPairingSession, getPairingSession, isLoopbackEndpoint } from '../src/pairing-client.mjs';
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

test('Web creates a session, sees the phone claim it, and the status never echoes the code', async () => {
  const server = createSyncServer();
  const logs = console.log;
  console.log = () => {};
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await createPairingSession(base, {
      desktop_client_id: 'web-1', computer_name: 'AlgoFlow-Desktop', route: 'lan', sync_api: base, ai_gateway: 'http://127.0.0.1:8788'
    });
    assert.match(session.code, /^\d{8}$/);
    assert.equal((await getPairingSession(base, session.pairing_id)).state, 'pending');

    const claim = await fetch(`${base}/v1/pairing/claims`, {
      method: 'POST', body: JSON.stringify({ code: session.code, phone_client_id: 'phone-1' })
    });
    assert.equal(claim.status, 200);
    const status = await getPairingSession(base, session.pairing_id);
    assert.equal(status.state, 'claimed');
    assert.equal(status.phone_client_id, 'phone-1');
    assert.equal(status.code, undefined);

    await assert.rejects(createPairingSession(base, {
      desktop_client_id: 'web-1', computer_name: 'AlgoFlow-Desktop', route: 'cloud', sync_api: base, ai_gateway: base
    }), /INVALID_REQUEST/);
  } finally {
    console.log = logs;
    await new Promise((resolve) => server.close(resolve));
  }
});
