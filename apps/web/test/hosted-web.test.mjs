import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_SYNC_API, resolveApiBase } from '../src/site-config.mjs';
import { createPairingSession, describeBrowser, pairingErrorText } from '../src/pairing-client.mjs';
import { LocalSyncClient, synchronizeWorkspace, syncNoticeFor, waitText } from '../src/sync-client.mjs';
import { markSyncedDraftsLocal } from '../src/storage.mjs';
import { createSyncServer } from '../../../services/sync-api/src/server.mjs';
import { WorkspaceDirectory } from '../../../services/sync-api/src/workspace-directory.mjs';

const NOW = '2026-11-06T00:00:00.000Z';

test('the hosted build syncs with its own origin; the local build keeps its configured endpoint', () => {
  assert.equal(resolveApiBase(true, 'http://127.0.0.1:9999', 'https://sync.example.test'), 'https://sync.example.test');
  assert.equal(resolveApiBase(false, 'http://192.168.1.20:8787', 'https://sync.example.test'), 'http://192.168.1.20:8787');
  assert.equal(resolveApiBase(false, undefined, 'http://localhost:5173'), LOCAL_SYNC_API);
  assert.equal(resolveApiBase(true, undefined, undefined), LOCAL_SYNC_API);
});

test('the device name keeps only the browser family and system', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Edge · Windows'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Safari · macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari · iOS'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox · Linux'],
    ['Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile', 'Chrome · HarmonyOS'],
    ['', '网页浏览器'],
    [undefined, '网页浏览器'],
  ];
  for (const [userAgent, name] of cases) {
    assert.equal(describeBrowser(userAgent), name, userAgent);
    assert.ok(name.length <= 64);
  }
});

test('pairing errors in the hosted build never point at sync-api settings', () => {
  const local = 'http://127.0.0.1:8787';
  for (const hosted of [false, true]) {
    assert.match(pairingErrorText(new Error('SERVER_AT_CAPACITY'), local, hosted), /1 小时后/);
    assert.match(pairingErrorText(Object.assign(new Error('RATE_LIMITED'), { retryAfter: 90 }), local, hosted), /2 分钟后/);
    assert.match(pairingErrorText(new Error('RATE_LIMITED'), local, hosted), /稍后/);
  }
  assert.match(pairingErrorText(new Error('INVALID_REQUEST'), local, false), /端点配置无效/);
  assert.match(pairingErrorText(new TypeError('fetch failed'), local, false), /127\.0\.0\.1:8787.*sync-api/);
  for (const error of [new Error('INVALID_REQUEST'), new TypeError('fetch failed'), new SyntaxError('Unexpected token <')]) {
    assert.doesNotMatch(pairingErrorText(error, local, true), /sync-api|Sync API|端点|127\.0\.0\.1/);
  }
});

test('sync notices say what to do next and stay quiet for ordinary failures', () => {
  assert.equal(syncNoticeFor({ auth_required: true }, true)?.kind, 'auth');
  assert.notEqual(syncNoticeFor({ auth_required: true }, true)?.message, syncNoticeFor({ auth_required: true }, false)?.message);
  assert.match(syncNoticeFor({ error_code: 'WORKSPACE_QUOTA_EXCEEDED' }, true)?.message ?? '', /删除不需要的草稿/);
  const limited = syncNoticeFor({ error_code: 'RATE_LIMITED', retry_after: 30 }, true);
  assert.equal(limited?.kind, 'rate_limited');
  assert.match(limited?.message ?? '', /30 秒后/);
  assert.equal(syncNoticeFor({}, true), null);
  assert.equal(syncNoticeFor({ error_code: 'SYNC_FAILED' }, true), null);

  assert.equal(waitText(undefined), '稍后');
  assert.equal(waitText(0), '稍后');
  assert.equal(waitText(30), ' 30 秒后');
  assert.equal(waitText(60), ' 1 分钟后');
  assert.equal(waitText(3600), ' 60 分钟后');
});

test('the device list shows both ends; removing a device retires its token, the last one takes the workspace', async () => {
  await withServer({}, async (base) => {
    const web = new LocalSyncClient(base, (await new LocalSyncClient(base).createWorkspace({ device_name: 'Edge · Windows' })).device_token);
    const session = await createPairingSession(base, { desktop_client_id: 'web-1', computer_name: 'Edge · Windows', route: 'lan', sync_api: base }, web.token);
    const claim = await (await fetch(`${base}/v1/pairing/claims`, {
      method: 'POST', body: JSON.stringify({ code: session.code, phone_client_id: 'phone-1', device_name: 'OpenHarmony 手机' })
    })).json();
    const phone = new LocalSyncClient(base, claim.device_token);

    const list = await web.listDevices();
    assert.equal(list.devices.length, 2);
    const current = list.devices.find((device) => device.device_id === list.current_device_id);
    assert.deepEqual([current?.kind, current?.name], ['web', 'Edge · Windows']);
    const phoneDevice = list.devices.find((device) => device.kind === 'phone');
    assert.equal(phoneDevice?.name, 'OpenHarmony 手机');

    assert.deepEqual(await web.removeDevice(phoneDevice?.device_id ?? ''), { status: 'deleted', workspace_deleted: false });
    await assert.rejects(web.removeDevice(phoneDevice?.device_id ?? ''), /DEVICE_NOT_FOUND/);
    await assert.rejects(phone.listDevices(), /AUTH_REQUIRED/);

    assert.deepEqual(await web.removeDevice(list.current_device_id), { status: 'deleted', workspace_deleted: true });
    await assert.rejects(web.listDevices(), /AUTH_REQUIRED/);
  });
});

test('deleting the cloud data retires every token of the workspace', async () => {
  await withServer({}, async (base) => {
    const web = new LocalSyncClient(base, (await new LocalSyncClient(base).createWorkspace()).device_token);
    const draft = makeDraft('draft-1', 'local_only', 0);
    const pushed = await web.push({ operation_id: 'op-1', entity_type: 'draft', entity_id: draft.id, operation_type: 'upsert', base_version: 0, client_id: 'web-a', occurred_at: NOW, payload: draft });
    assert.equal(pushed.status, 'applied');

    await web.deleteWorkspace();
    await assert.rejects(web.pull('0'), /AUTH_REQUIRED/);
    // App.deleteCloudData counts a second attempt with the old token as done.
    await assert.rejects(web.deleteWorkspace(), /AUTH_REQUIRED/);
  });
});

test('a rate-limited request carries Retry-After and stops the sync run', async () => {
  await withServer({ limits: { requestsPerMinute: 1 } }, async (base) => {
    const web = new LocalSyncClient(base, (await new LocalSyncClient(base).createWorkspace()).device_token);
    await web.listDevices();
    const state = makeWorkspace([makeDraft('draft-1', 'local_only', 0)]);
    state.operations = [upsert('op-1', state.drafts[0])];

    const error = await web.push(state.operations[0]).catch((failure) => failure);
    assert.equal(error.message, 'RATE_LIMITED');
    assert.ok(error.retryAfter > 0 && error.retryAfter <= 60);

    const result = await synchronizeWorkspace(state, web);
    assert.equal(result.status, 'failed');
    assert.equal(result.error_code, 'RATE_LIMITED');
    assert.ok((result.retry_after ?? 0) > 0);
    assert.deepEqual(result.state.operations.map((item) => item.operation_id), ['op-1']);
  });
});

test('workspace creation reports a full server and too many attempts with their wait', async () => {
  await withServer({ directory: new WorkspaceDirectory({ maxWorkspaces: 1 }) }, async (base) => {
    await new LocalSyncClient(base).createWorkspace();
    const error = await new LocalSyncClient(base).createWorkspace().catch((failure) => failure);
    assert.equal(error.message, 'SERVER_AT_CAPACITY');
    assert.equal(error.retryAfter, 3600);
  });
  await withServer({ limits: { workspacesPerHour: 1 } }, async (base) => {
    await new LocalSyncClient(base).createWorkspace();
    const error = await new LocalSyncClient(base).createWorkspace().catch((failure) => failure);
    assert.equal(error.message, 'RATE_LIMITED');
    assert.match(pairingErrorText(error, base, true), /分钟后/);
  });
});

test('a full workspace keeps that edit queued but still pushes the rest and pulls', async () => {
  const state = makeWorkspace([makeDraft('draft-a', 'local_only', 1), makeDraft('draft-b', 'local_only', 1), makeDraft('draft-c', 'synced', 1)]);
  state.operations = [upsert('op-a', state.drafts[0]), upsert('op-b', state.drafts[1])];
  const pushed = [];
  let pulled = false;
  const result = await synchronizeWorkspace(state, {
    async push(operation) {
      pushed.push(operation.operation_id);
      if (operation.operation_id === 'op-a') throw new Error('WORKSPACE_QUOTA_EXCEEDED');
      return { operation_id: operation.operation_id, status: 'applied', version: 2, server_entity: { ...operation.payload, version: 2 } };
    },
    async pull() {
      pulled = true;
      // The phone deleted draft-c to free space; draft-a's server copy must not replace the queued edit.
      return { changes: [
        { cursor: '4', entity_type: 'draft', entity: { ...makeDraft('draft-c', 'synced', 2), deleted: true, last_modified_client_id: 'phone-1' } },
        { cursor: '5', entity_type: 'draft', entity: { ...makeDraft('draft-a', 'synced', 3), title: 'server', last_modified_client_id: 'phone-1' } },
      ], next_cursor: '5', server_epoch: 'epoch-1', reset: false };
    },
  });
  assert.deepEqual(pushed, ['op-a', 'op-b']);
  assert.equal(pulled, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'WORKSPACE_QUOTA_EXCEEDED');
  assert.deepEqual(result.state.operations.map((item) => item.operation_id), ['op-a']);
  assert.equal(result.state.cursor, '5');
  assert.equal(result.state.drafts.find((draft) => draft.id === 'draft-a')?.title, 'draft-a');
  assert.equal(result.state.drafts.find((draft) => draft.id === 'draft-b')?.sync_status, 'synced');
  assert.equal(result.state.drafts.find((draft) => draft.id === 'draft-c')?.deleted, true);
  assert.equal(syncNoticeFor(result, true)?.kind, 'quota');
});

test('a rate limit stops pushing and skips the pull', async () => {
  const state = makeWorkspace([makeDraft('draft-a', 'local_only', 1), makeDraft('draft-b', 'local_only', 1)]);
  state.operations = [upsert('op-a', state.drafts[0]), upsert('op-b', state.drafts[1])];
  const pushed = [];
  const result = await synchronizeWorkspace(state, {
    async push(operation) {
      pushed.push(operation.operation_id);
      throw Object.assign(new Error('RATE_LIMITED'), { retryAfter: 30 });
    },
    async pull() { throw new Error('not expected'); },
  });
  assert.deepEqual(pushed, ['op-a']);
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'RATE_LIMITED');
  assert.equal(result.retry_after, 30);
  assert.deepEqual(result.state.operations.map((item) => item.operation_id), ['op-a', 'op-b']);
});

test('after the cloud data is deleted, synced drafts become local-only and nothing else changes', () => {
  const state = makeWorkspace([makeDraft('draft-a', 'synced', 2), makeDraft('draft-b', 'local_only', 0), makeDraft('draft-c', 'conflict', 1)]);
  state.operations = [upsert('op-b', state.drafts[1])];
  markSyncedDraftsLocal(state);
  assert.deepEqual(state.drafts.map((draft) => [draft.id, draft.sync_status, draft.version]),
    [['draft-a', 'local_only', 2], ['draft-b', 'local_only', 0], ['draft-c', 'conflict', 1]]);
  assert.deepEqual(state.operations.map((item) => item.operation_id), ['op-b']);
});

async function withServer(options, run) {
  const server = createSyncServer(options);
  const logs = [console.log, console.warn];
  console.log = () => {};
  console.warn = () => {};
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    [console.log, console.warn] = logs;
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeDraft(id, syncStatus, version) {
  return {
    id, workspace_id: 'workspace-local', version, created_at: NOW, updated_at: NOW, deleted: false,
    last_modified_client_id: 'web-a', title: id, language: 'cpp', idea: '', idea_segments: [], code: '', rewrite: '',
    ai_mode: 'faithful_transform', artifact_hidden: false, sync_status: syncStatus
  };
}

function makeWorkspace(drafts) {
  return { client_id: 'web-a', cursor: '3', server_epoch: 'epoch-1', online: true, selected_id: drafts[0].id, drafts,
    draft_history: [], ai_artifacts: [], review_results: [], operations: [], conflicts: [] };
}

function upsert(operationId, draft) {
  return { operation_id: operationId, entity_type: 'draft', entity_id: draft.id, operation_type: 'upsert',
    base_version: draft.version, client_id: 'web-a', occurred_at: NOW, payload: { ...draft, sync_status: 'synced' } };
}
