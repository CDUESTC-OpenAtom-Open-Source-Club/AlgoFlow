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
