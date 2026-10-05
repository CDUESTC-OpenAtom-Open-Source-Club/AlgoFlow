import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAIResultConflict, synchronizeWorkspace } from '../src/sync-client.mjs';
import { buildReviewRequest, reviewResultFromGateway } from '../src/ai-client.mjs';
import { BrowserWorkspaceRepository, hasReviewSource, queueReviewResult } from '../src/storage.mjs';
import { createReviewResult } from '../src/review-use-case.mjs';

test('creates a review without changing the Draft and synchronizes only after persistence', async () => {
  const initial = makeWorkspace('web-a', makeDraft('draft-review-use-case', 'int main() {}', 'web-a'));
  initial.drafts[0].version = 4;
  initial.drafts[0].sync_status = 'synced';
  const repository = memoryRepository(initial);
  let syncCount = 0;
  const result = await createReviewResult({
    repository,
    aiClient: { async review(request) { return gatewayReview(request); } },
    draftId: 'draft-review-use-case',
    documents: { 'main.cpp': 'int main() {}', 'idea.md': '', 'cases.txt': '' },
    mode: 'faithful_transform',
    reviewKind: 'explanation',
    clientId: 'web-a',
    isOnline: () => true,
    synchronize: async () => { syncCount += 1; return 'synced'; },
    getEditorRevision: () => 0,
  });

  assert.equal(result.syncStatus, 'synced');
  assert.equal(syncCount, 1);
  assert.equal(result.state.drafts[0].version, 4);
  assert.equal(result.state.drafts[0].code, 'int main() {}');
  assert.deepEqual(result.state.operations.map((operation) => operation.entity_type), ['review_result']);
  assert.equal(result.state.review_results[0].source_draft_version, 4);
});

test('does not call the Gateway for an unsaved or unsynchronized Draft', async () => {
  const draft = makeDraft('draft-review-unsynced', 'saved code', 'web-a');
  draft.version = 2;
  draft.sync_status = 'local_only';
  const initial = makeWorkspace('web-a', draft);
  initial.operations.push({ entity_type: 'draft', entity_id: draft.id, operation_type: 'upsert' });
  const repository = memoryRepository(initial);
  let requestCount = 0;

  await assert.rejects(createReviewResult({
    repository,
    aiClient: { async review() { requestCount += 1; return {}; } },
    draftId: draft.id,
    documents: { 'main.cpp': 'unsaved code', 'idea.md': '', 'cases.txt': '' },
    mode: 'faithful_transform',
    reviewKind: 'risk',
    clientId: 'web-a',
    isOnline: () => true,
    synchronize: async () => 'synced',
    getEditorRevision: () => 0,
  }), /REVIEW_DRAFT_NOT_SYNCED/);

  assert.equal(requestCount, 0);
  assert.equal(repository.load().review_results.length, 0);
  assert.equal(repository.load().operations.length, 1);
});

test('keeps a persisted review queued when synchronization fails', async () => {
  const draft = makeDraft('draft-review-offline-recovery', 'int main() {}', 'web-a');
  draft.version = 1;
  draft.sync_status = 'synced';
  const repository = memoryRepository(makeWorkspace('web-a', draft));
  const result = await createReviewResult({
    repository,
    aiClient: { async review(request) { return gatewayReview(request); } },
    draftId: draft.id,
    documents: { 'main.cpp': draft.code, 'idea.md': '', 'cases.txt': '' },
    mode: 'faithful_transform',
    reviewKind: 'complexity',
    clientId: 'web-a',
    isOnline: () => true,
    synchronize: async () => { throw new Error('network unavailable'); },
    getEditorRevision: () => 0,
  });

  assert.equal(result.syncStatus, 'failed');
  assert.equal(result.state.review_results.length, 1);
  assert.equal(result.state.operations[0].entity_type, 'review_result');
});

test('builds review requests from the persisted source draft version', () => {
  const persistedDraft = { id: 'draft-1', version: 7, language: 'cpp', ai_mode: 'faithful_transform' };
  const request = buildReviewRequest(persistedDraft, { 'main.cpp': 'int main() {}', 'idea.md': 'Check the entry point.', 'cases.txt': '' }, 'faithful_transform', 'complexity');

  assert.equal(request.draft_id, persistedDraft.id);
  assert.equal(request.draft_version, persistedDraft.version);
  assert.equal(request.review_kind, 'complexity');
});

test('creates review provenance from a Gateway response', () => {
  const persistedDraft = { id: 'draft-1', version: 7, language: 'cpp', ai_mode: 'faithful_transform' };
  const review = reviewResultFromGateway({
    mode: 'faithful_transform', source_draft_version: 7, model_id: 'provider-review', rule_version: '1.0.0',
    review_kind: 'complexity', visibility: 'visible', diagnostics: []
  }, persistedDraft, 'web-a', 'faithful_transform', 'complexity');
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

test('resolves a review conflict by keeping the local copy without converting it to a Draft', () => {
  const draft = makeDraft('draft-1', 'int main() {}', 'web-a');
  draft.version = 1;
  const localCopy = makeReview('review-copy', 0, 'web-a', 'risk');
  const server = makeReview('review-1', 1, 'web-b', 'complexity');
  const state = makeWorkspace('web-a', draft);
  state.review_results = [localCopy];
  state.conflicts = [{ id: 'conflict-1', entity_type: 'review_result', entity_id: server.id,
    local_copy_id: localCopy.id, server_entity: server, created_at: server.created_at, resolved: false }];

  const next = resolveAIResultConflict(state, state.conflicts[0], 'keep_local', 'web-a');

  assert.equal(next.review_results.find((item) => item.id === localCopy.id)?.review_kind, 'risk');
  assert.equal(next.operations[0].entity_type, 'review_result');
  assert.equal(next.conflicts[0].resolved, true);
});

test('resolves a review conflict by adopting the server result and removing the local copy', () => {
  const draft = makeDraft('draft-1', 'int main() {}', 'web-a');
  draft.version = 1;
  const localCopy = makeReview('review-copy', 0, 'web-a', 'risk');
  const server = makeReview('review-1', 1, 'web-b', 'complexity');
  const state = makeWorkspace('web-a', draft);
  state.review_results = [localCopy];
  state.conflicts = [{ id: 'conflict-1', entity_type: 'review_result', entity_id: server.id,
    local_copy_id: localCopy.id, server_entity: server, created_at: server.created_at, resolved: false }];

  const next = resolveAIResultConflict(state, state.conflicts[0], 'use_server', 'web-a');

  assert.equal(next.review_results.length, 1);
  assert.equal(next.review_results[0].id, server.id);
  assert.equal(next.review_results[0].review_kind, 'complexity');
  assert.equal(next.conflicts[0].resolved, true);
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

test('does not apply a review result whose source Draft version is absent locally', async () => {
  const draft = makeDraft('draft-source-review', 'int main() {}', 'web-a');
  draft.version = 2;
  const state = makeWorkspace('web-a', draft);
  state.cursor = '4';
  const review = makeReview('review-missing-source', 0, 'web-b', 'risk');
  review.draft_id = draft.id;
  review.source_draft_version = 3;
  const result = await synchronizeWorkspace(state, {
    async push() { throw new Error('not expected'); },
    async pull() { return { changes: [{ cursor: '5', entity_type: 'review_result', entity: review }], next_cursor: '5' }; }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.state.cursor, '4');
  assert.equal(result.state.review_results.length, 0);
});

test('rejects a review source version that is not the locally available Draft version', async () => {
  const draft = makeDraft('draft-history-review', 'short', 'web-a');
  draft.version = 2;
  const state = makeWorkspace('web-a', draft);
  const review = makeReview('review-history', 0, 'web-b', 'risk');
  review.draft_id = draft.id;
  review.source_draft_version = 1;
  const result = await synchronizeWorkspace(state, {
    async push() { throw new Error('not expected'); },
    async pull() { return { changes: [{ cursor: '1', entity_type: 'review_result', entity: review }], next_cursor: '1' }; }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.state.cursor, '0');
  assert.equal(result.state.review_results.length, 0);
});

test('accepts a pulled review only when its historical source snapshot is locally available', async () => {
  const draft = makeDraft('draft-history-review-known', 'new source', 'web-a');
  draft.version = 2;
  const state = makeWorkspace('web-a', draft);
  state.draft_history = [{ draft_id: draft.id, version: 1, code: 'x' }];
  const review = makeReview('review-history-known', 0, 'web-b', 'risk');
  review.draft_id = draft.id;
  review.source_draft_version = 1;
  const result = await synchronizeWorkspace(state, {
    async push() { throw new Error('not expected'); },
    async pull() { return { changes: [{ cursor: '1', entity_type: 'review_result', entity: review }], next_cursor: '1' }; }
  });
  assert.equal(result.status, 'synced');
  assert.equal(result.state.cursor, '1');
  assert.equal(result.state.review_results[0].source_draft_version, 1);
});

test('keeps a structurally valid legacy review read-only when its source snapshot is unavailable', () => {
  const draft = makeDraft('draft-legacy-review', 'current source', 'web-a');
  draft.version = 2;
  const state = makeWorkspace('web-a', draft);
  const review = makeReview('review-legacy', 1, 'web-a', 'risk');
  review.draft_id = draft.id;
  review.source_draft_version = 1;

  assert.equal(hasReviewSource(state, review), false);
  assert.throws(() => queueReviewResult(state, review), /REVIEW_SOURCE_NOT_FOUND/);
  assert.equal(state.review_results.length, 0);
});

test('restores a structurally valid legacy review without inventing its source snapshot', () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
  try {
    const draft = makeDraft('draft-restored-legacy-review', 'current source', 'web-a');
    draft.version = 2;
    const review = makeReview('review-restored-legacy', 1, 'web-a', 'risk');
    review.draft_id = draft.id;
    review.source_draft_version = 1;
    const state = makeWorkspace('web-a', draft);
    state.review_results = [review];
    state.draft_history = [];

    const repository = new BrowserWorkspaceRepository('web-a');
    repository.save(state);
    const restored = repository.load();

    assert.equal(restored.review_results.length, 1);
    assert.equal(restored.review_results[0].id, review.id);
    assert.equal(hasReviewSource(restored, restored.review_results[0]), false);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('rejects an invalid review before it enters the local queue', () => {
  const draft = makeDraft('draft-queue-review', 'int main() {}', 'web-a');
  draft.version = 2;
  const state = makeWorkspace('web-a', draft);
  const review = makeReview('review-invalid-source', 0, 'web-a', 'risk');
  review.draft_id = draft.id;
  review.source_draft_version = 3;
  assert.throws(() => queueReviewResult(state, review), /REVIEW_SOURCE_NOT_FOUND/);
  assert.equal(state.review_results?.length ?? 0, 0);
  assert.equal(state.operations.length, 0);
});

test('rejects a diagnostic range outside the source code before queueing', () => {
  const draft = makeDraft('draft-range-review', 'x', 'web-a');
  const state = makeWorkspace('web-a', draft);
  const review = makeReview('review-range-invalid', 0, 'web-a', 'risk', {
    start_line: 1, start_char: 0, end_line: 1, end_char: 2
  });
  review.draft_id = draft.id;
  review.source_draft_version = draft.version;
  assert.throws(() => queueReviewResult(state, review), /INVALID_REVIEW_RESULT/);
  assert.equal(state.review_results.length, 0);
  assert.equal(state.operations.length, 0);
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

function makeDraft(id, code, clientId) {
  return {
    id, workspace_id: 'workspace-local', version: 0, created_at: '2026-09-15T00:00:00.000Z', updated_at: '2026-09-15T00:00:00.000Z',
    deleted: false, last_modified_client_id: clientId, title: 'Review', language: 'cpp', idea: '', idea_segments: [],
    code, rewrite: '', ai_mode: 'faithful_transform', artifact_hidden: false, sync_status: 'synced'
  };
}

function makeWorkspace(clientId, draft) {
  return {
    client_id: clientId, cursor: '0', online: true, selected_id: draft.id, drafts: [draft],
    ai_artifacts: [], review_results: [], operations: [], conflicts: []
  };
}

function memoryRepository(initialState) {
  let state = structuredClone(initialState);
  return {
    load() { return structuredClone(state); },
    save(next) { state = structuredClone(next); },
  };
}

function gatewayReview(request) {
  return {
    mode: request.mode,
    source_draft_version: request.draft_version,
    model_id: 'provider-review',
    rule_version: request.rule_version,
    review_kind: request.review_kind,
    diagnostics: [],
    visibility: 'visible',
  };
}
