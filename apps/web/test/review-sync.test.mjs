import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeWorkspace } from '../src/sync-client.mjs';
import { createLocalReviewResult } from '../src/storage.mjs';

test('creates review provenance from the persisted source draft version', () => {
  const persistedDraft = { id: 'draft-1', version: 7 };
  const review = createLocalReviewResult(persistedDraft, 'web-a', 'faithful_transform', 'complexity', []);

  assert.equal(review.draft_id, persistedDraft.id);
  assert.equal(review.source_draft_version, persistedDraft.version);
  assert.equal(review.review_kind, 'complexity');
});

test('preserves a review_result conflict as a review copy', async () => {
  const localReview = makeReview('review-1', 0, 'web-a', 'risk');
  const serverReview = makeReview('review-1', 1, 'web-b', 'complexity');
  const state = {
    client_id: 'web-a', cursor: '0', online: true, selected_id: 'draft-1',
    drafts: [{ id: 'draft-1', workspace_id: 'workspace-local', version: 1, created_at: localReview.created_at, updated_at: localReview.updated_at,
      deleted: false, last_modified_client_id: 'web-a', title: 'Review', language: 'cpp', idea: '', idea_segments: [], code: 'int main() {}',
      rewrite: '', ai_mode: 'faithful_transform', artifact_hidden: false, sync_status: 'synced' }],
    ai_artifacts: [], review_results: [localReview], conflicts: [],
    operations: [{ operation_id: 'review-op', entity_type: 'review_result', entity_id: localReview.id, operation_type: 'upsert', base_version: 0,
      client_id: 'web-a', occurred_at: localReview.updated_at, payload: localReview }],
  };
  const client = {
    push: async () => ({ status: 'conflict', server_entity: serverReview }),
    pull: async () => ({ changes: [], next_cursor: '0' }),
  };

  const result = await synchronizeWorkspace(state, client, () => 'review-copy');

  assert.equal(result.status, 'conflict');
  assert.equal(result.state.operations.length, 0);
  assert.equal(result.state.review_results.find((item) => item.id === 'review-1')?.review_kind, 'complexity');
  assert.equal(result.state.review_results.find((item) => item.id === 'review-copy')?.review_kind, 'risk');
  assert.equal(result.state.conflicts[0].entity_type, 'review_result');
  assert.equal(result.state.conflicts[0].local_copy_id, 'review-copy');
});

test('does not advance the cursor when a pulled review result is invalid', async () => {
  const state = {
    client_id: 'web-a', cursor: '4', online: true, selected_id: 'draft-1',
    drafts: [{ id: 'draft-1', workspace_id: 'workspace-local', version: 1, created_at: '2026-09-15T00:00:00.000Z', updated_at: '2026-09-15T00:00:00.000Z',
      deleted: false, last_modified_client_id: 'web-a', title: 'Review', language: 'cpp', idea: '', idea_segments: [], code: 'int main() {}',
      rewrite: '', ai_mode: 'faithful_transform', artifact_hidden: false, sync_status: 'synced' }],
    ai_artifacts: [], review_results: [], operations: [], conflicts: [],
  };
  const client = {
    push: async () => ({ status: 'applied' }),
    pull: async () => ({ changes: [{ cursor: '5', entity_type: 'review_result', entity: makeReview('review-invalid', 1, 'web-b', 'risk', { start_line: 0, start_char: 0, end_line: 1, end_char: 0 }) }], next_cursor: '5' }),
  };

  const result = await synchronizeWorkspace(state, client);

  assert.equal(result.status, 'failed');
  assert.equal(result.state.cursor, '4');
  assert.equal(result.state.review_results.length, 0);
});

function makeReview(id, version, clientId, reviewKind, range = { start_line: 1, start_char: 0, end_line: 1, end_char: 1 }) {
  const now = '2026-09-15T00:00:00.000Z';
  return {
    id, version, server_sequence: version, created_at: now, updated_at: now, deleted: false, last_modified_client_id: clientId,
    draft_id: 'draft-1', mode: 'faithful_transform', source_draft_version: 1, model_id: 'local-review-rules', rule_version: '1.0.0',
    review_kind: reviewKind, visibility: 'visible',
    diagnostics: [{ id: `${id}-diagnostic`, level: 'warning', range, problem: 'Potential issue', basis: 'Rule matched', suggestion: 'Review this line' }],
  };
}
