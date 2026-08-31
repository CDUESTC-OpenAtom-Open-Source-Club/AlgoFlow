import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncStore } from '../src/sync-store.mjs';
import { createSyncServer } from '../src/server.mjs';
import { queueUpsert } from '../../../apps/web/src/storage.mjs';
import { LocalSyncClient, synchronizeWorkspace } from '../../../apps/web/src/sync-client.mjs';

const operation = {
  operation_id: 'op-1', entity_type: 'draft', entity_id: 'draft-1', operation_type: 'upsert',
  base_version: 0, client_id: 'web-local', occurred_at: '2026-08-21T00:00:00.000Z', payload: { title: 'Draft' }
};

test('applies once and treats a retry as duplicate', () => {
  const store = new SyncStore();
  assert.equal(store.apply(operation).status, 'applied');
  assert.equal(store.apply(operation).status, 'duplicate');
  assert.equal(store.pull('0').changes.length, 1);
});

test('returns the server entity on version conflict', () => {
  const store = new SyncStore();
  store.apply(operation);
  const result = store.apply({ ...operation, operation_id: 'op-2', client_id: 'phone-local' });
  assert.equal(result.status, 'conflict');
  assert.equal(result.server_entity.version, 1);
});

test('keeps a deletion tombstone in the change stream', () => {
  const store = new SyncStore();
  store.apply(operation);
  const result = store.apply({ ...operation, operation_id: 'op-3', operation_type: 'delete', base_version: 1, payload: { deleted: true } });
  assert.equal(result.server_entity.deleted, true);
  assert.equal(store.pull('1').changes.length, 1);
});

test('accepts independent operations that arrive out of order and preserves cursor order', () => {
  const store = new SyncStore();
  const firstEntity = { ...operation, operation_id: 'op-a', entity_id: 'draft-a' };
  const secondEntity = { ...operation, operation_id: 'op-b', entity_id: 'draft-b' };

  assert.equal(store.apply(secondEntity).status, 'applied');
  assert.equal(store.apply(firstEntity).status, 'applied');

  const changes = store.pull('0').changes;
  assert.deepEqual(changes.map((change) => change.entity.id), ['draft-b', 'draft-a']);
  assert.equal(store.pull('1').changes[0].entity.id, 'draft-a');
});

test('rejects a stale concurrent update without overwriting the server version', () => {
  const store = new SyncStore();
  assert.equal(store.apply(operation).status, 'applied');

  const concurrentUpdate = {
    ...operation,
    operation_id: 'op-concurrent',
    client_id: 'phone-local',
    base_version: 0,
    payload: { title: 'Phone edit' }
  };
  const result = store.apply(concurrentUpdate);
  assert.equal(result.status, 'conflict');
  assert.equal(result.error_code, 'VERSION_CONFLICT');
  assert.equal(result.server_entity.title, 'Draft');
  assert.equal(store.pull('0').changes.length, 1);
});

test('supports cursor recovery after consuming a batch and later changes', () => {
  const store = new SyncStore();
  assert.equal(store.apply(operation).status, 'applied');
  const firstPull = store.pull('0');
  assert.equal(firstPull.changes.length, 1);
  assert.equal(firstPull.next_cursor, '1');

  assert.equal(store.apply({
    ...operation,
    operation_id: 'op-2',
    entity_id: 'draft-2',
    occurred_at: '2026-08-21T00:02:00.000Z'
  }).status, 'applied');
  const recovered = store.pull(firstPull.next_cursor);
  assert.equal(recovered.changes.length, 1);
  assert.equal(recovered.changes[0].entity.id, 'draft-2');
  assert.equal(recovered.next_cursor, '2');
});

test('rejects malformed operations as a negative contract case', () => {
  const store = new SyncStore();
  const result = store.apply({
    ...operation,
    operation_id: '',
    entity_type: 'unknown_entity'
  });
  assert.deepEqual(result, {
    operation_id: '',
    status: 'rejected',
    error_code: 'INVALID_REQUEST'
  });
});

test('two Web clients preserve a stale concurrent edit as a conflict copy', async (context) => {
  const server = createSyncServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new LocalSyncClient(`http://127.0.0.1:${address.port}`);
  const baseDraft = makeDraft('draft-shared', 'seed', 'web-a');
  const clientA = makeWorkspace('web-a', baseDraft);
  const clientB = makeWorkspace('web-b', { ...baseDraft, last_modified_client_id: 'web-b' });

  const editA = { ...clientA.drafts[0], code: 'client A', updated_at: '2026-08-31T01:00:00.000Z' };
  const editB = { ...clientB.drafts[0], code: 'client B', updated_at: '2026-08-31T01:00:01.000Z' };
  queueUpsert(clientA, editA);
  queueUpsert(clientB, editB);

  const first = await synchronizeWorkspace(clientA, client, () => 'first');
  const second = await synchronizeWorkspace(clientB, client, (() => {
    const ids = ['copy', 'record'];
    return () => ids.shift() ?? 'fallback';
  })());

  assert.equal(first.status, 'synced');
  assert.equal(first.state.drafts[0].version, 1);
  assert.equal(second.status, 'conflict');
  assert.equal(second.state.drafts.find((draft) => draft.id === 'draft-shared').code, 'client A');
  assert.equal(second.state.drafts.find((draft) => draft.id === 'draft-shared-conflict-copy').code, 'client B');
  assert.equal(second.state.conflicts[0].resolved, false);
  assert.equal(second.state.operations.length, 0);
});

test('an offline Web queue reuses its operation id and submits after recovery', async (context) => {
  const server = createSyncServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new LocalSyncClient(`http://127.0.0.1:${address.port}`);
  const state = makeWorkspace('web-offline', makeDraft('draft-offline', 'seed', 'web-offline'));

  queueUpsert(state, { ...state.drafts[0], code: 'offline edit one' });
  const operationId = state.operations[0].operation_id;
  queueUpsert(state, { ...state.drafts[0], code: 'offline edit two' });

  assert.equal(state.operations.length, 1);
  assert.equal(state.operations[0].operation_id, operationId);
  assert.equal(state.operations[0].base_version, 0);

  const recovered = await synchronizeWorkspace(state, client);
  assert.equal(recovered.status, 'synced');
  assert.equal(recovered.state.operations.length, 0);
  assert.equal(recovered.state.cursor, '1');
  assert.equal(recovered.state.drafts[0].code, 'offline edit two');
  assert.equal(recovered.state.drafts[0].version, 1);
});

test('Web sync does not advance its cursor when pull fails', async () => {
  const state = makeWorkspace('web-failed', makeDraft('draft-failed', 'seed', 'web-failed'));
  state.cursor = '7';
  const failingClient = {
    async push() { throw new Error('not expected'); },
    async pull() { throw new Error('network unavailable'); }
  };

  const result = await synchronizeWorkspace(state, failingClient);
  assert.equal(result.status, 'failed');
  assert.equal(result.state.cursor, '7');
});

function makeDraft(id, code, clientId) {
  return {
    id,
    workspace_id: 'workspace-local',
    version: 0,
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:00:00.000Z',
    deleted: false,
    last_modified_client_id: clientId,
    title: '同步草稿',
    language: 'cpp',
    idea: '',
    code,
    rewrite: '',
    ai_mode: 'faithful_transform',
    artifact_hidden: false,
    sync_status: 'local_only'
  };
}

function makeWorkspace(clientId, draft) {
  return {
    client_id: clientId,
    cursor: '0',
    online: true,
    selected_id: draft.id,
    drafts: [draft],
    operations: [],
    conflicts: []
  };
}
