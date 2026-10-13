const STORAGE_KEY = 'algoflow.workspace.v1';
const QUEUE_KEY_PREFIX = 'algoflow.sync.queue.v1.';
const CURSOR_KEY_PREFIX = 'algoflow.sync.cursor.v1.';

export class BrowserWorkspaceRepository {
  /** @param {string | null} [clientId] */
  constructor(clientId = null) {
    this.clientId = clientId;
  }

  /** @returns {import('./types').WorkspaceState} */
  load() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (value && Array.isArray(value.drafts)) {
        const clientId = this.clientId ?? value.client_id ?? `web-${crypto.randomUUID()}`;
        const state = {
          ...value,
          client_id: clientId,
          cursor: localStorage.getItem(`${CURSOR_KEY_PREFIX}${clientId}`) ?? value.cursor ?? '0',
          operations: readOperations(clientId, value.operations),
          conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
          ai_artifacts: Array.isArray(value.ai_artifacts) ? value.ai_artifacts : [],
          review_results: Array.isArray(value.review_results) ? value.review_results : [],
          draft_history: normalizeDraftHistory(value.draft_history, value.drafts),
        };
        recomputeReviewFreshness(state);
        state.review_results = /** @type {import('./types').ReviewResult[]} */ (state.review_results).filter((review) => {
          try {
            assertReviewResult(review);
            return true;
          } catch {
            return false;
          }
        });
        return state;
      }
      return initialState(this.clientId);
    } catch {
      return initialState(this.clientId);
    }
  }

  /** @param {import('./types').WorkspaceState} state */
  save(state) {
    recomputeReviewFreshness(state);
    const { operations, client_id: clientId, cursor, ...sharedState } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...sharedState, operations: [] }));
    localStorage.setItem(`${QUEUE_KEY_PREFIX}${clientId}`, JSON.stringify(operations));
    localStorage.setItem(`${CURSOR_KEY_PREFIX}${clientId}`, cursor);
  }
}

/** @param {string} clientId @returns {import('./types').Draft} */
export function newDraft(clientId) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    id, workspace_id: 'workspace-local', version: 0, created_at: now, updated_at: now,
    deleted: false, last_modified_client_id: clientId, title: '未命名思路', language: 'cpp',
    idea: '', idea_segments: [], code: '', rewrite: '', ai_mode: 'faithful_transform', artifact_hidden: false,
    sync_status: 'local_only'
  };
}

/** @param {import('./types').AIArtifact} artifact @returns {import('./types').AIArtifact} */
export function cloneAIArtifact(artifact) {
  return JSON.parse(JSON.stringify(artifact));
}

/** @param {import('./types').ReviewResult} result */
export function cloneReviewResult(result) { return JSON.parse(JSON.stringify(result)); }

/**
 * @param {unknown} value
 * @param {import('./types').WorkspaceState} [state]
 */
export function assertReviewResult(value, state = undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REVIEW_RESULT');
  /** @type {Record<string, unknown>} */
  const result = /** @type {Record<string, unknown>} */ (value);
  const required = ['id', 'version', 'server_sequence', 'created_at', 'updated_at', 'deleted', 'last_modified_client_id', 'draft_id', 'mode', 'source_draft_version', 'model_id', 'rule_version', 'review_kind', 'diagnostics', 'visibility', 'freshness'];
  if (required.some((field) => !(field in result)) || Object.keys(result).some((field) => !required.includes(field))) throw new Error('INVALID_REVIEW_RESULT');
  if (typeof result.id !== 'string' || result.id.trim().length === 0 ||
    typeof result.version !== 'number' || !Number.isInteger(result.version) || result.version < 0 ||
    typeof result.server_sequence !== 'number' || !Number.isInteger(result.server_sequence) || result.server_sequence < 0 ||
    !isUtcTimestamp(result.created_at) || !isUtcTimestamp(result.updated_at) ||
    typeof result.deleted !== 'boolean' || typeof result.last_modified_client_id !== 'string' || result.last_modified_client_id.trim().length === 0 ||
    typeof result.draft_id !== 'string' || result.draft_id.trim().length === 0 ||
    typeof result.mode !== 'string' || !['faithful_transform', 'feasibility_analysis', 'progressive_hint', 'full_solution'].includes(result.mode) ||
    typeof result.source_draft_version !== 'number' || !Number.isInteger(result.source_draft_version) || result.source_draft_version < 0 ||
    typeof result.model_id !== 'string' || result.model_id.trim().length === 0 ||
    typeof result.rule_version !== 'string' || result.rule_version.trim().length === 0 ||
    typeof result.review_kind !== 'string' || !['explanation', 'risk', 'complexity'].includes(result.review_kind) ||
    typeof result.visibility !== 'string' || !['visible', 'hidden'].includes(result.visibility) ||
    typeof result.freshness !== 'string' || !['current', 'stale'].includes(result.freshness) ||
    !Array.isArray(result.diagnostics)) throw new Error('INVALID_REVIEW_RESULT');
  const diagnostics = /** @type {unknown[]} */ (result.diagnostics);
  const ids = new Set();
  for (const diagnosticValue of diagnostics) {
    if (!diagnosticValue || typeof diagnosticValue !== 'object' || Array.isArray(diagnosticValue)) throw new Error('INVALID_REVIEW_RESULT');
    const diagnostic = /** @type {Record<string, unknown>} */ (diagnosticValue);
    if (
      Object.keys(diagnostic).some((field) => !['id', 'level', 'range', 'problem', 'basis', 'suggestion'].includes(field)) ||
      typeof diagnostic.id !== 'string' || diagnostic.id.trim().length === 0 || ids.has(diagnostic.id) ||
      typeof diagnostic.level !== 'string' || !['error', 'warning', 'info', 'hint'].includes(diagnostic.level) ||
      typeof diagnostic.problem !== 'string' || diagnostic.problem.trim().length === 0 ||
      typeof diagnostic.basis !== 'string' || diagnostic.basis.trim().length === 0 ||
      typeof diagnostic.suggestion !== 'string' || diagnostic.suggestion.trim().length === 0 ||
      !isValidSourceRange(diagnostic.range)) throw new Error('INVALID_REVIEW_RESULT');
    ids.add(diagnostic.id);
  }
  if (state !== undefined) assertReviewSource(state, /** @type {import('./types').ReviewResult} */ (value));
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').ReviewResult} result */
export function assertReviewSource(state, result) {
  const sourceCode = reviewSourceCode(state, result);
  if (sourceCode === undefined) throw new Error('REVIEW_SOURCE_NOT_FOUND');
  const lines = sourceCode.split('\n');
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.range === null) continue;
    const { start_line: startLine, start_char: startChar, end_line: endLine, end_char: endChar } = diagnostic.range;
    const startText = lines[startLine - 1];
    const endText = lines[endLine - 1];
    if (startLine > lines.length || endLine > lines.length || typeof startText !== 'string' ||
      typeof endText !== 'string' || startChar > startText.length || endChar > endText.length) {
      throw new Error('INVALID_REVIEW_RESULT');
    }
  }
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').ReviewResult} result */
export function hasReviewSource(state, result) {
  return reviewSourceCode(state, result) !== undefined;
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').ReviewResult} result @param {string} [editorCode] */
export function getReviewFreshness(state, result, editorCode = undefined) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'stale';
  const candidate = editorCode === undefined ? result : { ...result, __editorCode: editorCode };
  const results = [...(state.review_results ?? []).filter((item) => item.id !== result.id), result];
  const withCandidate = { ...state, review_results: results };
  const fresh = baseReviewFreshness(withCandidate, candidate);
  if (fresh !== 'current') return 'stale';
  const winner = currentReviewForSlot(withCandidate, reviewSlot(result));
  return winner?.id === result.id ? 'current' : 'stale';
}

/**
 * Recomputes the display freshness of every independent review result. The
 * source draft must be synchronized and the result must win its deterministic
 * display slot; older results remain readable history.
 * @param {import('./types').WorkspaceState} state
 */
export function recomputeReviewFreshness(state) {
  const results = state.review_results ?? [];
  const winners = new Map();
  for (const result of results) {
    if (result.deleted || baseReviewFreshness(state, result) !== 'current') continue;
    const slot = reviewSlot(result);
    const current = winners.get(slot);
    if (!current || compareReviewResults(result, current) > 0) winners.set(slot, result);
  }
  state.review_results = results.map((result) => ({
    ...result,
    freshness: winners.get(reviewSlot(result))?.id === result.id && baseReviewFreshness(state, result) === 'current' ? 'current' : 'stale',
  }));
  return state.review_results;
}

/** @param {import('./types').ReviewResult[]} results */
export function sortReviewResultsNewestFirst(results) {
  return [...results].sort((left, right) => Number(right.freshness === 'current') - Number(left.freshness === 'current') ||
    compareReviewResults(right, left));
}

/** @param {import('./types').ReviewResult} result */
function reviewSlot(result) {
  return `${result.draft_id}/${result.mode}/${result.review_kind}`;
}

/** @param {import('./types').ReviewResult} left @param {import('./types').ReviewResult} right */
function compareReviewResults(left, right) {
  return left.source_draft_version - right.source_draft_version ||
    left.created_at.localeCompare(right.created_at) ||
    left.server_sequence - right.server_sequence ||
    left.version - right.version ||
    left.updated_at.localeCompare(right.updated_at) ||
    left.id.localeCompare(right.id);
}

/** @param {import('./types').WorkspaceState} state @param {string} slot */
function currentReviewForSlot(state, slot) {
  return (state.review_results ?? []).filter((result) => !result.deleted && reviewSlot(result) === slot &&
    baseReviewFreshness(state, result) === 'current').sort((left, right) => compareReviewResults(right, left))[0];
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').ReviewResult & {__editorCode?: string}} result */
function baseReviewFreshness(state, result) {
  const draft = state.drafts.find((item) => item.id === result.draft_id && !item.deleted);
  if (!draft || draft.sync_status !== 'synced' || draft.version !== result.source_draft_version ||
    state.operations?.some((operation) => operation.entity_type === 'draft' && operation.entity_id === result.draft_id)) return 'stale';
  const sourceCode = reviewSourceCode(state, result);
  if (sourceCode === undefined || sourceCode !== draft.code ||
    (result.__editorCode !== undefined && result.__editorCode !== sourceCode)) return 'stale';
  return 'current';
}

/**
 * Computes whether an AI artifact belongs to the synchronized current source.
 * The artifact stays in the state array when stale so it can be inspected from
 * history; callers must check this value before offering any write action.
 * @param {import('./types').WorkspaceState} state
 * @param {import('./types').AIArtifact} artifact
 * @returns {'current' | 'stale'}
 */
export function getAIArtifactFreshness(state, artifact) {
  const draft = state.drafts.find((item) => item.id === artifact?.draft_id && !item.deleted);
  if (!draft || draft.sync_status !== 'synced' || draft.version !== artifact.source_draft_version ||
    state.operations?.some((operation) => operation.entity_type === 'draft' && operation.entity_id === artifact.draft_id)) return 'stale';
  const snapshot = (state.draft_history ?? []).find((item) => item.draft_id === artifact.draft_id && item.version === artifact.source_draft_version);
  const sourceIds = snapshot?.idea_segments?.map((segment) => segment.id) ?? (draft.idea_segments ?? []).map((segment) => segment.id);
  const references = (artifact.pseudocode ?? []).flatMap((step) => step.source_refs ?? []);
  return references.every((reference) => sourceIds.includes(reference)) ? 'current' : 'stale';
}

/** @param {import('./types').AIArtifact[]} artifacts */
export function sortAIArtifactsNewestFirst(artifacts) {
  return [...artifacts].sort((left, right) => left.source_draft_version - right.source_draft_version ||
    left.created_at.localeCompare(right.created_at) || left.server_sequence - right.server_sequence ||
    left.version - right.version || left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id)).reverse();
}

/** @param {import('./types').WorkspaceState} state @param {string} draftId @param {import('./types').Mode} mode */
export function selectCurrentAIArtifact(state, draftId, mode) {
  return sortAIArtifactsNewestFirst((state.ai_artifacts ?? []).filter((artifact) =>
    !artifact.deleted && artifact.draft_id === draftId && artifact.mode === mode && getAIArtifactFreshness(state, artifact) === 'current'))[0];
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').ReviewResult} result */
function reviewSourceCode(state, result) {
  const draft = state.drafts.find((item) => item.id === result.draft_id && !item.deleted);
  if (!draft || draft.version < result.source_draft_version) return undefined;
  const snapshot = (state.draft_history ?? []).find((item) => item.draft_id === result.draft_id && item.version === result.source_draft_version);
  return snapshot?.code ?? (draft.version === result.source_draft_version && draft.sync_status === 'synced' ? draft.code : undefined);
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').Draft} draft */
export function recordDraftSnapshot(state, draft) {
  if (draft.deleted || !Number.isInteger(draft.version) || draft.version < 1) return;
  const history = state.draft_history ?? (state.draft_history = []);
  if (history.some((item) => item.draft_id === draft.id && item.version === draft.version)) return;
  history.push({ draft_id: draft.id, version: draft.version, code: draft.code,
    idea_segments: (draft.idea_segments ?? []).map((segment) => ({ ...segment })) });
}


/** @param {unknown} value */
function isUtcTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && value.endsWith('Z') && !Number.isNaN(Date.parse(value));
}

/** @param {unknown} value */
function isValidSourceRange(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const range = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(range).some((field) => !['start_line', 'start_char', 'end_line', 'end_char'].includes(field))) return false;
  if (typeof range.start_line !== 'number' || !Number.isInteger(range.start_line) || range.start_line < 1 ||
    typeof range.start_char !== 'number' || !Number.isInteger(range.start_char) || range.start_char < 0 ||
    typeof range.end_line !== 'number' || !Number.isInteger(range.end_line) || range.end_line < 1 ||
    typeof range.end_char !== 'number' || !Number.isInteger(range.end_char) || range.end_char < 0) return false;
  return range.end_line > range.start_line || (range.end_line === range.start_line && range.end_char >= range.start_char);
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').ReviewResult} result */
export function queueReviewResult(state, result) {
  const nextResult = { ...cloneReviewResult(result), freshness: getReviewFreshness(state, result) };
  assertReviewResult(nextResult, state);
  state.review_results = (state.review_results ?? []).filter((item) => item.id !== nextResult.id).concat(nextResult);
  recomputeReviewFreshness(state);
  result = state.review_results.find((item) => item.id === nextResult.id) ?? nextResult;
  const existing = state.operations.find((item) => item.entity_type === 'review_result' && item.entity_id === result.id && item.operation_type === 'upsert');
  /** @type {import('./types').SyncOperation} */
  const operation = {
    operation_id: existing?.operation_id ?? crypto.randomUUID(), entity_type: 'review_result', entity_id: result.id,
    operation_type: 'upsert', base_version: existing?.base_version ?? result.version, client_id: state.client_id,
    occurred_at: new Date().toISOString(), payload: cloneReviewResult(result),
  };
  state.operations = state.operations.filter((item) => !(item.entity_type === 'review_result' && item.entity_id === result.id));
  state.operations.push(operation);
  state.review_results = state.review_results.map((item) => item.id === result.id ? cloneReviewResult(result) : item);
}

/** @param {import('./types').ReviewResult} result @param {string} clientId @param {string} id @returns {import('./types').ReviewResult} */
export function createReviewResultConflictCopy(result, clientId, id) {
  const copy = cloneReviewResult(result);
  copy.id = id;
  copy.version = 0;
  copy.server_sequence = 0;
  copy.created_at = new Date().toISOString();
  copy.updated_at = copy.created_at;
  copy.last_modified_client_id = clientId;
  copy.visibility = 'visible';
  return copy;
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').AIArtifact} artifact */
export function queueAIArtifact(state, artifact) {
  const existing = state.operations.find((item) => item.entity_type === 'ai_artifact' && item.entity_id === artifact.id && item.operation_type === 'upsert');
  /** @type {import('./types').SyncOperation} */
  const operation = {
    operation_id: existing?.operation_id ?? crypto.randomUUID(), entity_type: 'ai_artifact', entity_id: artifact.id,
    operation_type: 'upsert', base_version: existing?.base_version ?? artifact.version, client_id: state.client_id,
    occurred_at: new Date().toISOString(), payload: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (cloneAIArtifact(artifact))),
  };
  state.operations = state.operations.filter((item) => !(item.entity_type === 'ai_artifact' && item.entity_id === artifact.id));
  state.operations.push(operation);
  state.ai_artifacts = (state.ai_artifacts ?? []).filter((item) => item.id !== artifact.id).concat(cloneAIArtifact(artifact));
}

/** @param {import('./types').AIArtifact} artifact @param {string} clientId @param {string} id @returns {import('./types').AIArtifact} */
export function createAIArtifactConflictCopy(artifact, clientId, id) {
  const copy = cloneAIArtifact(artifact);
  copy.id = id;
  copy.version = 0;
  copy.server_sequence = 0;
  copy.created_at = new Date().toISOString();
  copy.updated_at = copy.created_at;
  copy.last_modified_client_id = clientId;
  copy.visibility = 'visible';
  return copy;
}

/**
 * @param {import('./types').WorkspaceState} state
 * @param {import('./types').Draft} draft
 */
export function queueUpsert(state, draft) {
  const existing = state.operations.find((item) => item.entity_type === 'draft' && item.entity_id === draft.id && item.operation_type === 'upsert');
  /** @type {import('./types').SyncOperation} */
  const operation = {
    operation_id: existing?.operation_id ?? crypto.randomUUID(), entity_type: 'draft', entity_id: draft.id,
    operation_type: 'upsert', base_version: existing?.base_version ?? draft.version, client_id: state.client_id,
    occurred_at: new Date().toISOString(), payload: { ...draft, sync_status: 'synced' }
  };
  state.operations = state.operations.filter((item) => !(item.entity_type === 'draft' && item.entity_id === draft.id));
  state.operations.push(operation);
}

/** @param {string | null} [clientId] @returns {import('./types').WorkspaceState} */
function initialState(clientId = null) {
  const resolvedClientId = clientId ?? `web-${crypto.randomUUID()}`;
  const draft = newDraft(resolvedClientId);
  // Keep the first local demo draft addressable from multiple browser tabs.
  draft.id = 'draft-local';
  return { client_id: resolvedClientId, cursor: '0', online: true, selected_id: draft.id, drafts: [draft], draft_history: [], ai_artifacts: [], review_results: [], operations: [], conflicts: [] };
}

/** @param {unknown} value @param {import('./types').Draft[]} drafts @returns {import('./types').DraftVersionSnapshot[]} */
function normalizeDraftHistory(value, drafts) {
  const history = Array.isArray(value) ? value.filter((item) => item && typeof item.draft_id === 'string' &&
    Number.isInteger(item.version) && item.version >= 1 && typeof item.code === 'string' &&
    (item.idea_segments === undefined || validIdeaSegments(item.idea_segments))) : [];
  for (const draft of drafts) {
    if (!draft.deleted && draft.sync_status === 'synced' && draft.version >= 1 &&
      !history.some((item) => item.draft_id === draft.id && item.version === draft.version)) {
      history.push({ draft_id: draft.id, version: draft.version, code: draft.code,
        idea_segments: (draft.idea_segments ?? []).map((segment) => ({ ...segment })) });
    }
  }
  return history;
}

/** @param {unknown} value */
function validIdeaSegments(value) {
  if (!Array.isArray(value)) return false;
  const ids = new Set();
  return value.every((segment) => segment && typeof segment.id === 'string' && segment.id.length > 0 &&
    typeof segment.content === 'string' && !ids.has(segment.id) && (segment.position === undefined || Number.isInteger(segment.position)) &&
    (ids.add(segment.id), true));
}

/**
 * @param {string} clientId
 * @param {unknown} legacyOperations
 * @returns {import('./types').SyncOperation[]}
 */
function readOperations(clientId, legacyOperations) {
  try {
    const value = JSON.parse(localStorage.getItem(`${QUEUE_KEY_PREFIX}${clientId}`) ?? 'null');
    if (Array.isArray(value)) {
      return /** @type {import('./types').SyncOperation[]} */ (value.filter((item) => !isEmptyPlaceholderOperation(item)));
    }
  } catch {
    // Fall through to a one-time migration from the original shared queue.
  }
  if (Array.isArray(legacyOperations) && legacyOperations.every((item) => item?.client_id === clientId)) {
    return /** @type {import('./types').SyncOperation[]} */ (legacyOperations.filter((item) => !isEmptyPlaceholderOperation(item)));
  }
  return [];
}

/** @param {unknown} operation */
function isEmptyPlaceholderOperation(operation) {
  const item = /** @type {import('./types').SyncOperation | null} */ (operation && typeof operation === 'object' ? operation : null);
  if (!item || item.operation_type !== 'upsert' || item.base_version !== 0) return false;
  const payload = item.payload;
  if (!payload || typeof payload !== 'object') return false;
  const value = /** @type {Record<string, unknown>} */ (payload);
  return value.title === '未命名思路' && value.idea === '' && value.code === '' &&
    value.short_code === '' && value.rewrite === '';
}
