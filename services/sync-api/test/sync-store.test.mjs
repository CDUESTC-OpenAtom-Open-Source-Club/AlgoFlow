import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncStore } from '../src/sync-store.mjs';

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
