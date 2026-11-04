import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createSyncServer } from '../src/server.mjs';
import { DEVICE_TOKEN_PATTERN, WorkspaceDirectory } from '../src/workspace-directory.mjs';

const sessionRequest = (base, id = 'web-1') => ({ desktop_client_id: id, computer_name: 'AlgoFlow-Desktop', route: 'relay', sync_api: base });

function draftOperation(id = 'op-1', title = '草稿') {
  return {
    operation_id: id, entity_type: 'draft', entity_id: 'draft-local', operation_type: 'upsert', base_version: 0, client_id: 'client-1',
    occurred_at: '2026-11-04T00:00:00.000Z',
    payload: { id: 'draft-local', title, idea: '', code: '', language: 'cpp', tags: [], status: 'draft', revision: 1, updated_at: '2026-11-04T00:00:00.000Z' }
  };
}

async function withServer(options, run) {
  const logs = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(originals)) console[level] = (...args) => { logs.push(args.join(' ')); };
  const server = createSyncServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  const createWorkspace = async () => (await call('POST', '/v1/workspaces', { body: {} })).body;
  try {
    await run({ base, call, createWorkspace, logs });
  } finally {
    Object.assign(console, originals);
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a new workspace issues a well-formed token that the device list never repeats', async () => {
  const directory = new WorkspaceDirectory();
  await withServer({ directory }, async ({ call }) => {
    const created = await call('POST', '/v1/workspaces', { body: { device_name: '  我的电脑 ' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'created');
    assert.match(created.body.device_token, DEVICE_TOKEN_PATTERN);
    const devices = await call('GET', '/v1/devices', { token: created.body.device_token });
    assert.equal(devices.body.current_device_id, created.body.device_id);
    assert.deepEqual(devices.body.devices.map(({ kind, name }) => ({ kind, name })), [{ kind: 'web', name: '我的电脑' }]);
    assert.equal(JSON.stringify(devices.body).includes(created.body.device_token), false);
    assert.equal('token_hash' in devices.body.devices[0], false);

    for (const body of ['not json', '[]', { device_name: '' }, { device_name: 'x'.repeat(65) }, { device_name: 1 }]) {
      const rejected = await call('POST', '/v1/workspaces', { body });
      assert.equal(rejected.status, 400, JSON.stringify(body));
      assert.equal(rejected.body.error_code, 'INVALID_REQUEST');
    }
    assert.equal(directory.size, 1, 'a rejected request must not create a workspace');
  });
});

test('every data route answers 401 without a valid token', async () => {
  await withServer({}, async ({ call, createWorkspace }) => {
    const { device_token: token } = await createWorkspace();
    const routes = [
      ['GET', '/v1/sync/changes?after=0'], ['POST', '/v1/sync/operations'], ['POST', '/v1/pairing/sessions'], ['GET', '/v1/pairing/sessions/any'],
      ['GET', '/v1/devices'], ['DELETE', '/v1/devices/current'], ['DELETE', '/v1/workspaces/current']
    ];
    for (const [method, path] of routes) {
      for (const candidate of [undefined, 'A'.repeat(43), 'short']) {
        const result = await call(method, path, { token: candidate });
        assert.equal(result.status, 401, `${method} ${path}`);
        assert.equal(result.body.error_code, 'AUTH_REQUIRED');
        assert.equal(result.headers.get('www-authenticate'), 'Bearer');
      }
      const wrongScheme = await call(method, path, { headers: { Authorization: `Basic ${token}` } });
      assert.equal(wrongScheme.status, 401, `Basic ${method} ${path}`);
    }
  });
});

test('workspaces cannot read each other and may reuse the same draft and operation ids', async () => {
  await withServer({}, async ({ call, createWorkspace }) => {
    const [first, second] = [await createWorkspace(), await createWorkspace()];
    const pushed = await call('POST', '/v1/sync/operations', { token: first.device_token, body: draftOperation('op-1', '第一个工作区') });
    assert.equal(pushed.body.status, 'applied');

    const secondView = (await call('GET', '/v1/sync/changes?after=0', { token: second.device_token })).body;
    assert.deepEqual(secondView.changes, [], 'another workspace must see nothing');

    // Same operation_id: a duplicate only within one workspace.
    const reused = await call('POST', '/v1/sync/operations', { token: second.device_token, body: draftOperation('op-1', '第二个工作区') });
    assert.equal(reused.body.status, 'applied');
    assert.equal(reused.body.version, 1);
    const firstView = (await call('GET', '/v1/sync/changes?after=0', { token: first.device_token })).body;
    assert.equal(firstView.changes[0].entity.title, '第一个工作区');
    assert.notEqual(firstView.server_epoch, secondView.server_epoch, 'each workspace is its own lineage');

    // A workspace_id in the request does not select anything.
    const smuggled = await call('GET', `/v1/sync/changes?after=0&workspace_id=${first.workspace_id}`, { token: second.device_token });
    assert.equal(smuggled.body.changes[0].entity.title, '第二个工作区');
    await call('POST', '/v1/sync/operations', { token: second.device_token, body: { ...draftOperation('op-2'), entity_id: 'draft-other', workspace_id: first.workspace_id } });
    assert.equal((await call('GET', '/v1/sync/changes?after=0', { token: first.device_token })).body.changes.length, 1);
  });
});

test('a phone without a token joins the session workspace and sees its drafts', async () => {
  await withServer({}, async ({ base, call, createWorkspace }) => {
    const web = await createWorkspace();
    await call('POST', '/v1/sync/operations', { token: web.device_token, body: draftOperation() });
    const { session } = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body;

    const claim = await call('POST', '/v1/pairing/claims', { body: { code: session.code, phone_client_id: 'phone-1', device_name: '手机' } });
    assert.equal(claim.status, 200);
    assert.match(claim.body.device_token, DEVICE_TOKEN_PATTERN);
    assert.equal((await call('GET', '/v1/sync/changes?after=0', { token: claim.body.device_token })).body.changes.length, 1);

    const devices = (await call('GET', '/v1/devices', { token: web.device_token })).body.devices;
    assert.deepEqual(devices.map(({ kind, name }) => [kind, name]).sort(), [['phone', '手机'], ['web', null]]);
    const status = (await call('GET', `/v1/pairing/sessions/${session.pairing_id}`, { token: web.device_token })).body.session;
    assert.equal(status.state, 'claimed');
    assert.equal('transfer_token' in status, false);
  });
});

test('a phone with an invalid token is treated as having none', async () => {
  await withServer({}, async ({ base, call, createWorkspace }) => {
    const web = await createWorkspace();
    const { session } = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body;
    const claim = await call('POST', '/v1/pairing/claims', { token: 'A'.repeat(43), body: { code: session.code, phone_client_id: 'phone-1' } });
    assert.equal(claim.status, 200);
    assert.match(claim.body.device_token, DEVICE_TOKEN_PATTERN);
  });
});

test('a phone already in the session workspace changes nothing', async () => {
  await withServer({}, async ({ base, call, createWorkspace }) => {
    const web = await createWorkspace();
    const first = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body.session;
    const phoneToken = (await call('POST', '/v1/pairing/claims', { body: { code: first.code, phone_client_id: 'phone-1' } })).body.device_token;

    const second = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body.session;
    const claim = await call('POST', '/v1/pairing/claims', { token: phoneToken, body: { code: second.code, phone_client_id: 'phone-1' } });
    assert.equal(claim.status, 200);
    assert.equal('device_token' in claim.body, false);
    assert.equal((await call('GET', '/v1/devices', { token: web.device_token })).body.devices.length, 2);
    const status = (await call('GET', `/v1/pairing/sessions/${second.pairing_id}`, { token: web.device_token })).body.session;
    assert.equal('transfer_token' in status, false);
  });
});

test('a phone from another workspace keeps it and only the creator can read the transfer token', async () => {
  await withServer({}, async ({ base, call, createWorkspace }) => {
    const phoneOwner = await createWorkspace();
    await call('POST', '/v1/sync/operations', { token: phoneOwner.device_token, body: draftOperation('op-phone', '手机的草稿') });
    const web = await createWorkspace();
    const bystander = await createWorkspace();
    const { session } = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body;
    assert.equal('transfer_token' in session, false);

    const claim = await call('POST', '/v1/pairing/claims', { token: phoneOwner.device_token, body: { code: session.code, phone_client_id: 'phone-1' } });
    assert.equal(claim.status, 200);
    assert.equal('device_token' in claim.body, false, 'the phone keeps its own token');
    assert.equal(JSON.stringify(claim.body).includes('transfer_token'), false);

    for (const token of [bystander.device_token, phoneOwner.device_token]) {
      const foreign = await call('GET', `/v1/pairing/sessions/${session.pairing_id}`, { token });
      assert.equal(foreign.status, 404);
      assert.equal(foreign.body.error_code, 'PAIRING_NOT_FOUND');
    }

    const status = (await call('GET', `/v1/pairing/sessions/${session.pairing_id}`, { token: web.device_token })).body.session;
    assert.match(status.transfer_token, DEVICE_TOKEN_PATTERN);
    const switched = (await call('GET', '/v1/sync/changes?after=0', { token: status.transfer_token })).body;
    assert.equal(switched.changes[0].entity.title, '手机的草稿');
    const devices = (await call('GET', '/v1/devices', { token: phoneOwner.device_token })).body.devices;
    assert.deepEqual(devices.map(({ kind, name }) => [kind, name]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [['web', 'AlgoFlow-Desktop'], ['web', null]]);

    // The creator then retires its old device, which removes the old workspace.
    const retired = await call('DELETE', '/v1/devices/current', { token: web.device_token });
    assert.deepEqual(retired.body, { status: 'deleted', workspace_deleted: true });
    assert.equal((await call('GET', '/v1/devices', { token: web.device_token })).status, 401);
  });
});

test('a pairing session is not visible to another device of the same workspace', async () => {
  await withServer({}, async ({ base, call, createWorkspace }) => {
    const web = await createWorkspace();
    const first = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body.session;
    const phoneToken = (await call('POST', '/v1/pairing/claims', { body: { code: first.code, phone_client_id: 'phone-1' } })).body.device_token;
    const second = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body.session;
    assert.equal((await call('GET', `/v1/pairing/sessions/${second.pairing_id}`, { token: phoneToken })).status, 404);
  });
});

test('removing a device revokes only that token and removing the last one deletes the workspace', async () => {
  const directory = new WorkspaceDirectory();
  await withServer({ directory }, async ({ base, call, createWorkspace }) => {
    const web = await createWorkspace();
    const other = await createWorkspace();
    const { session } = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body;
    const phone = (await call('POST', '/v1/pairing/claims', { body: { code: session.code, phone_client_id: 'phone-1' } })).body;
    const phoneId = (await call('GET', '/v1/devices', { token: phone.device_token })).body.current_device_id;

    assert.equal((await call('DELETE', `/v1/devices/${phoneId}`, { token: other.device_token })).status, 404, 'another workspace cannot remove it');
    assert.equal((await call('DELETE', '/v1/devices/missing', { token: web.device_token })).body.error_code, 'DEVICE_NOT_FOUND');
    assert.equal((await call('DELETE', '/v1/devices/%zz', { token: web.device_token })).status, 404);

    const removed = await call('DELETE', `/v1/devices/${phoneId}`, { token: web.device_token });
    assert.deepEqual(removed.body, { status: 'deleted', workspace_deleted: false });
    assert.equal((await call('GET', '/v1/devices', { token: phone.device_token })).status, 401);
    assert.equal((await call('GET', '/v1/devices', { token: web.device_token })).status, 200);

    assert.equal(directory.size, 2);
    const last = await call('DELETE', '/v1/devices/current', { token: web.device_token });
    assert.deepEqual(last.body, { status: 'deleted', workspace_deleted: true });
    assert.equal(directory.size, 1);
  });
});

test('deleting a workspace removes its data and invalidates every token', async () => {
  await withServer({}, async ({ base, call, createWorkspace }) => {
    const web = await createWorkspace();
    await call('POST', '/v1/sync/operations', { token: web.device_token, body: draftOperation() });
    const { session } = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body;
    const phoneToken = (await call('POST', '/v1/pairing/claims', { body: { code: session.code, phone_client_id: 'phone-1' } })).body.device_token;

    const deleted = await call('DELETE', '/v1/workspaces/current', { token: phoneToken });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { status: 'deleted' });
    for (const token of [web.device_token, phoneToken]) {
      assert.equal((await call('GET', '/v1/sync/changes?after=0', { token })).status, 401);
    }
  });
});

test('malformed requests are answered instead of crashing the process', async () => {
  await withServer({}, async ({ base, call, createWorkspace }) => {
    const { device_token: token } = await createWorkspace();
    assert.equal((await call('GET', '/v1/pairing/sessions/%zz', { token })).status, 404);
    assert.equal((await call('GET', '/v1/pairing/sessions/a/b', { token })).status, 404);
    assert.equal((await call('POST', '/v1/sync/operations', { token, body: 'not json' })).status, 400);
    assert.equal((await call('POST', '/v1/pairing/sessions', { token, body: 'not json' })).status, 400);
    assert.equal((await call('POST', '/v1/pairing/claims', { body: 'null' })).status, 400);
    assert.equal((await call('POST', '/v1/pairing/claims', { body: '[1]' })).status, 400);

    for (const patch of [{ operation_id: 'x'.repeat(129) }, { operation_id: 7 }, { entity_id: { nested: true } }, { client_id: ['a'] }, { client_id: '' }]) {
      const result = await call('POST', '/v1/sync/operations', { token, body: { ...draftOperation(), ...patch } });
      assert.equal(result.status, 400, JSON.stringify(patch));
      assert.equal(result.body.status, 'rejected');
    }

    // fetch() normalizes the path, so send the broken request line by hand.
    const { port } = new URL(base);
    const raw = await new Promise((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => socket.write('GET http://[bad/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let received = '';
      socket.on('data', (chunk) => { received += chunk; });
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400 /);

    assert.equal((await call('GET', '/healthz')).status, 200, 'the process must survive all of the above');
  });
});

test('a client disconnecting mid-body does not take the server down', async () => {
  await withServer({}, async ({ base, call }) => {
    const { port } = new URL(base);
    await new Promise((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write('POST /v1/workspaces HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n{"device_na');
        setTimeout(() => socket.destroy(), 20);
      });
      socket.on('close', resolve);
      socket.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await call('GET', '/healthz')).status, 200);
  });
});

test('oversized bodies are refused with 413', async () => {
  await withServer({ maxBodyBytes: 256 }, async ({ call, createWorkspace }) => {
    const { device_token: token } = await createWorkspace();
    const big = JSON.stringify({ pad: 'x'.repeat(1024) });
    for (const [path, options] of [['/v1/workspaces', {}], ['/v1/pairing/claims', {}], ['/v1/sync/operations', { token }], ['/v1/pairing/sessions', { token }]]) {
      const result = await call('POST', path, { ...options, body: big });
      assert.equal(result.status, 413, path);
      assert.equal(result.body.error_code, 'PAYLOAD_TOO_LARGE');
    }
  });
});

test('healthz, unknown paths and CORS headers', async () => {
  await withServer({ corsOrigin: 'https://example.test' }, async ({ base, call, createWorkspace }) => {
    const health = await call('GET', '/healthz');
    assert.deepEqual(health.body, { status: 'ok' });
    assert.equal(health.headers.get('access-control-allow-origin'), 'https://example.test');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal((await call('GET', '/nope')).body.error_code, 'NOT_FOUND');
    const { device_token: token } = await createWorkspace();
    assert.equal((await call('GET', '/v1/nope', { token })).body.error_code, 'NOT_FOUND');

    const preflight = await fetch(`${base}/v1/devices/current`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
    assert.match(preflight.headers.get('access-control-allow-methods'), /DELETE/);
  });
});

test('X-Real-IP selects the rate-limit bucket only behind a trusted proxy', async () => {
  const guess = async (call, ip) => (await call('POST', '/v1/pairing/claims', { headers: { 'X-Real-IP': ip }, body: { code: '00000000', phone_client_id: 'p' } })).status;
  const exhaust = async (call, ip) => { for (let i = 0; i < 10; i++) assert.equal(await guess(call, ip), 404); };

  await withServer({ trustProxy: true }, async ({ call }) => {
    await exhaust(call, '198.51.100.7');
    assert.equal(await guess(call, '198.51.100.7'), 429);
    assert.equal(await guess(call, '203.0.113.9'), 404);
  });
  // Without a proxy the header is attacker-controlled, so rotating it must not help.
  await withServer({}, async ({ call }) => {
    for (let i = 0; i < 10; i++) assert.equal(await guess(call, `198.51.100.${i}`), 404);
    assert.equal(await guess(call, '198.51.100.200'), 429);
  });
});

test('logs never contain device tokens, transfer tokens or pairing codes', async () => {
  await withServer({}, async ({ base, call, createWorkspace, logs }) => {
    const phoneOwner = await createWorkspace();
    const web = await createWorkspace();
    await call('POST', '/v1/sync/operations', { token: web.device_token, body: draftOperation() });
    const { session } = (await call('POST', '/v1/pairing/sessions', { token: web.device_token, body: sessionRequest(base) })).body;
    await call('POST', '/v1/pairing/claims', { token: phoneOwner.device_token, body: { code: session.code, phone_client_id: 'phone-1' } });
    const { transfer_token: transfer } = (await call('GET', `/v1/pairing/sessions/${session.pairing_id}`, { token: web.device_token })).body.session;
    await call('POST', '/v1/pairing/claims', { body: { code: session.code, phone_client_id: 'phone-2' } });
    await call('GET', '/v1/devices', { token: 'B'.repeat(43) });

    assert.ok(logs.length > 0);
    const joined = logs.join('\n');
    for (const secret of [web.device_token, phoneOwner.device_token, transfer, session.code, 'B'.repeat(43)]) {
      assert.equal(joined.includes(secret), false);
    }
  });
});
