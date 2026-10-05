import { buildReviewRequest, reviewResultFromGateway } from './ai-client.mjs';
import { getReviewFreshness, hasReviewSource, queueReviewResult } from './storage.mjs';

/**
 * @param {{ repository: import('./storage.mjs').BrowserWorkspaceRepository, aiClient: { review(request: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> }, draftId: string, documents: import('./types').Documents, mode: import('./types').Mode, reviewKind: import('./types').ReviewKind, clientId: string, isOnline: () => boolean, synchronize: () => Promise<import('./types').SyncStatus>, getEditorRevision: () => number, signal?: AbortSignal }} input
 * @returns {Promise<{state: import('./types').WorkspaceState, syncStatus: import('./types').SyncStatus, reviewId: string}>}
 */
export async function createReviewResult(input) {
  const state = input.repository.load();
  const sourceDraft = state.drafts.find((draft) => draft.id === input.draftId && !draft.deleted);
  if (!sourceDraft) throw new Error('DRAFT_NOT_FOUND');
  assertReviewSourceReady(state, sourceDraft, input.documents, input.mode);

  const revision = input.getEditorRevision();
  const request = buildReviewRequest(sourceDraft, {
    'main.cpp': sourceDraft.code,
    'idea.md': sourceDraft.idea,
    'cases.txt': sourceDraft.cases ?? '',
  }, input.mode, input.reviewKind);
  const response = await input.aiClient.review(request, { signal: input.signal });
  if (input.signal?.aborted) throw new Error('AI_REQUEST_CANCELLED');

  const latestState = input.repository.load();
  const latestDraft = latestState.drafts.find((draft) => draft.id === sourceDraft.id && !draft.deleted);
  if (!latestDraft || latestState.selected_id !== sourceDraft.id || input.getEditorRevision() !== revision ||
    !sameReviewSource(latestDraft, sourceDraft) || hasPendingDraftWrite(latestState, sourceDraft.id)) {
    throw new Error('DRAFT_CHANGED_RETRY_REVIEW');
  }

  const result = reviewResultFromGateway(response, sourceDraft, input.clientId, input.mode, input.reviewKind, request.rule_version);
  queueReviewResult(latestState, result);
  input.repository.save(latestState);

  /** @type {import('./types').SyncStatus} */
  let syncStatus = 'local_only';
  if (input.isOnline()) {
    try {
      syncStatus = await input.synchronize();
    } catch {
      syncStatus = 'failed';
    }
  }
  return { state: input.repository.load(), syncStatus, reviewId: result.id };
}

/**
 * @param {{ repository: import('./storage.mjs').BrowserWorkspaceRepository, reviewId: string, clientId: string, isOnline: () => boolean, synchronize: () => Promise<import('./types').SyncStatus> }} input
 * @returns {Promise<{state: import('./types').WorkspaceState, syncStatus: import('./types').SyncStatus}>}
 */
export async function toggleReviewVisibility(input) {
  const state = input.repository.load();
  const review = state.review_results.find((item) => item.id === input.reviewId && !item.deleted);
  if (!review) throw new Error('REVIEW_NOT_FOUND');
  if (!hasReviewSource(state, review)) throw new Error('REVIEW_SOURCE_NOT_FOUND');
  if (getReviewFreshness(state, review) !== 'current') throw new Error('REVIEW_RESULT_STALE');
  queueReviewResult(state, {
    ...review,
    visibility: review.visibility === 'hidden' ? 'visible' : 'hidden',
    updated_at: new Date().toISOString(),
    last_modified_client_id: input.clientId,
  });
  input.repository.save(state);

  /** @type {import('./types').SyncStatus} */
  let syncStatus = 'local_only';
  if (input.isOnline()) {
    try {
      syncStatus = await input.synchronize();
    } catch {
      syncStatus = 'failed';
    }
  }
  return { state: input.repository.load(), syncStatus };
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').Draft} draft @param {import('./types').Documents} documents @param {import('./types').Mode} mode */
function assertReviewSourceReady(state, draft, documents, mode) {
  if (draft.version < 1 || draft.sync_status !== 'synced' || hasPendingDraftWrite(state, draft.id)) {
    throw new Error('REVIEW_DRAFT_NOT_SYNCED');
  }
  if (draft.code !== documents['main.cpp'] || draft.idea !== documents['idea.md'] ||
    (draft.cases ?? '') !== documents['cases.txt'] || draft.ai_mode !== mode) {
    throw new Error('DRAFT_NEEDS_SAVE');
  }
}

/** @param {import('./types').WorkspaceState} state @param {string} draftId */
function hasPendingDraftWrite(state, draftId) {
  return state.operations.some((operation) => operation.entity_type === 'draft' && operation.entity_id === draftId);
}

/** @param {import('./types').Draft} left @param {import('./types').Draft} right */
function sameReviewSource(left, right) {
  return left.version === right.version && left.code === right.code && left.idea === right.idea &&
    (left.cases ?? '') === (right.cases ?? '') && left.ai_mode === right.ai_mode &&
    left.sync_status === 'synced';
}
