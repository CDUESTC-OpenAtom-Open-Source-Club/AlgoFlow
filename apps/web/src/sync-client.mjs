const API_BASE = import.meta.env?.VITE_SYNC_API_BASE ?? 'http://127.0.0.1:8787';
import { createAIArtifactConflictCopy, queueAIArtifact } from './storage.mjs';

export class LocalSyncClient {
  /** @param {string} [apiBase] */
  constructor(apiBase = API_BASE) {
    this.apiBase = apiBase;
  }

  /** @param {import('./types').SyncOperation} operation @returns {Promise<import('./types').PushResult>} */
  async push(operation) {
    const response = await fetch(`${this.apiBase}/v1/sync/operations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation)
    });
    const result = await response.json();
    if (!response.ok && response.status !== 409) {
      throw new Error(result.error_code ?? result.code ?? 'SYNC_FAILED');
    }
    return result;
  }

  /** @param {string} cursor @returns {Promise<import('./types').PullResult>} */
  async pull(cursor) {
    const response = await fetch(`${this.apiBase}/v1/sync/changes?after=${encodeURIComponent(cursor)}`);
    if (!response.ok) throw new Error('SYNC_FAILED');
    return response.json();
  }
}

/**
 * Pushes the saved queue and then applies one complete pull batch. The cursor is
 * assigned only after every pulled change has been merged successfully.
 * @param {import('./types').WorkspaceState} state
 * @param {LocalSyncClient} client
 * @param {() => string} [createId]
 * @returns {Promise<import('./types').SyncRunResult>}
 */
export async function synchronizeWorkspace(state, client, createId = () => crypto.randomUUID()) {
  let next = { ...state, drafts: [...state.drafts], ai_artifacts: [...(state.ai_artifacts ?? [])], operations: [...state.operations], conflicts: [...state.conflicts], online: true };
  let hadConflict = false;
  let hadFailure = false;

  for (const operation of [...next.operations]) {
    try {
      const result = await client.push(operation);
      if (result.status === 'conflict') {
        if (operation.entity_type === 'ai_artifact') {
          if (!result.server_entity) { hadFailure = true; continue; }
          const local = /** @type {import('./types').AIArtifact} */ (/** @type {unknown} */ (operation.payload));
          const server = /** @type {import('./types').AIArtifact} */ (result.server_entity);
          assertAIArtifact(server);
          const copy = createAIArtifactConflictCopy(local, next.client_id, createId());
          next = replaceAIArtifact(next, server);
          next = replaceAIArtifact(next, copy);
          next.operations = next.operations.filter((item) => item.operation_id !== operation.operation_id);
          queueAIArtifact(next, copy);
          hadConflict = true;
          continue;
        }
        if (!result.server_entity) {
          hadFailure = true;
          continue;
        }
        const local = /** @type {import('./types').Draft} */ (/** @type {unknown} */ (operation.payload));
        const copy = createConflictCopy(local, next.client_id, createId());
        next = replaceDraft(next, { .../** @type {import('./types').Draft} */ (result.server_entity), sync_status: 'synced' });
        next = replaceDraft(next, copy);
        next.operations = next.operations.filter((item) => item.operation_id !== operation.operation_id);
        next.conflicts.push({
          id: createId(),
          entity_id: operation.entity_id,
          local_copy_id: copy.id,
          server_entity: /** @type {import('./types').Draft} */ (result.server_entity),
          created_at: new Date().toISOString(),
          resolved: false,
        });
        hadConflict = true;
        continue;
      }

      if (result.status === 'applied' || result.status === 'duplicate') {
        const entity = result.server_entity ?? { ...operation.payload, version: result.version ?? operation.base_version };
        if (operation.entity_type === 'ai_artifact') {
          assertAIArtifact(entity);
          next = replaceAIArtifact(next, /** @type {import('./types').AIArtifact} */ (entity));
        } else {
          next = replaceDraft(next, { .../** @type {import('./types').Draft} */ (entity), sync_status: 'synced' });
        }
        next.operations = next.operations.filter((item) => item.operation_id !== operation.operation_id);
        continue;
      }
      hadFailure = true;
    } catch {
      hadFailure = true;
    }
  }

  if (!hadFailure) {
    try {
      const pullCursor = shouldReplayForPlaceholder(next) ? '0' : next.cursor;
      const pull = await client.pull(pullCursor);
      const merged = applyPulledChanges(next, pull.changes, next.client_id);
      next = { ...merged, cursor: pull.next_cursor };
    } catch {
      hadFailure = true;
    }
  }

  // A fresh Web workspace starts on the local placeholder draft. If the phone
  // has already published another stable draft, make that draft visible after
  // pull instead of reporting success while the editor still shows blank data.
  next = selectRemoteDraftWhenPlaceholder(next);

  if (hadConflict || next.conflicts.some((conflict) => !conflict.resolved)) return { state: next, status: 'conflict' };
  if (hadFailure) return { state: next, status: 'failed' };
  return { state: next, status: next.operations.length ? 'local_only' : 'synced' };
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').Draft} draft */
function replaceDraft(state, draft) {
  const found = state.drafts.some((item) => item.id === draft.id);
  return {
    ...state,
    drafts: found ? state.drafts.map((item) => item.id === draft.id ? draft : item) : [...state.drafts, draft],
  };
}

/**
 * @param {import('./types').WorkspaceState} state
 * @param {import('./types').PullChange[]} changes
 * @param {string} clientId
 */
function applyPulledChanges(state, changes, clientId) {
  let next = state;
  for (const change of changes) {
    if (change.entity_type === 'ai_artifact') {
      assertAIArtifact(change.entity);
      if (change.entity.last_modified_client_id === clientId) continue;
      const local = next.ai_artifacts.find((artifact) => artifact.id === change.entity.id);
      const hasPendingOperation = next.operations.some((operation) => operation.entity_type === 'ai_artifact' && operation.entity_id === change.entity.id);
      if (!hasPendingOperation && (!local || change.entity.version >= local.version)) next = replaceAIArtifact(next, /** @type {import('./types').AIArtifact} */ (change.entity));
      continue;
    }
    if (change.entity_type !== 'draft') throw new Error('UNSUPPORTED_SYNC_ENTITY');
    if (change.entity.last_modified_client_id === clientId) continue;
    const hasPendingOperation = next.operations.some((operation) => operation.entity_type === 'draft' && operation.entity_id === change.entity.id);
    const local = next.drafts.find((draft) => draft.id === change.entity.id);
    if (!hasPendingOperation && (!local || change.entity.version >= local.version)) {
      next = replaceDraft(next, { .../** @type {import('./types').Draft} */ (change.entity), sync_status: 'synced' });
    }
  }
  return next;
}

/** @param {import('./types').WorkspaceState} state @param {import('./types').AIArtifact} artifact */
function replaceAIArtifact(state, artifact) {
  const found = state.ai_artifacts.some((item) => item.id === artifact.id);
  return { ...state, ai_artifacts: found ? state.ai_artifacts.map((item) => item.id === artifact.id ? artifact : item) : [...state.ai_artifacts, artifact] };
}

/** @param {unknown} value */
export function assertAIArtifact(value) {
  if (!value || typeof value !== 'object') throw new Error('INVALID_AI_ARTIFACT');
  const artifact = /** @type {Record<string, unknown>} */ (value);
  const required = ['id', 'version', 'server_sequence', 'created_at', 'updated_at', 'deleted', 'last_modified_client_id', 'draft_id', 'mode', 'pseudocode', 'code_snippet', 'code_mappings', 'assumptions', 'missing_information', 'risk_flags', 'added_algorithm_steps', 'source_draft_version', 'model_id', 'rule_version', 'output_kind', 'visibility', 'template_id'];
  if (required.some((field) => !(field in artifact)) || Object.keys(artifact).some((field) => !required.includes(field))) throw new Error('INVALID_AI_ARTIFACT');
  if (typeof artifact.id !== 'string' || artifact.id.length === 0 ||
    typeof artifact.version !== 'number' || !Number.isInteger(artifact.version) || artifact.version < 0 ||
    typeof artifact.server_sequence !== 'number' || !Number.isInteger(artifact.server_sequence) || artifact.server_sequence < 0 ||
    typeof artifact.created_at !== 'string' || !artifact.created_at.endsWith('Z') || Number.isNaN(Date.parse(artifact.created_at)) ||
    typeof artifact.updated_at !== 'string' || !artifact.updated_at.endsWith('Z') || Number.isNaN(Date.parse(artifact.updated_at)) ||
    typeof artifact.deleted !== 'boolean' || typeof artifact.last_modified_client_id !== 'string' || artifact.last_modified_client_id.length === 0 ||
    typeof artifact.draft_id !== 'string' || artifact.draft_id.length === 0 ||
    typeof artifact.source_draft_version !== 'number' || !Number.isInteger(artifact.source_draft_version) || artifact.source_draft_version < 0 ||
    typeof artifact.model_id !== 'string' || artifact.model_id.length === 0 || typeof artifact.rule_version !== 'string' || artifact.rule_version.length === 0 ||
    (artifact.template_id !== null && (typeof artifact.template_id !== 'string' || artifact.template_id.length === 0))) throw new Error('INVALID_AI_ARTIFACT');
  const mode = typeof artifact.mode === 'string' ? artifact.mode : '';
  const outputKind = typeof artifact.output_kind === 'string' ? artifact.output_kind : '';
  const visibility = typeof artifact.visibility === 'string' ? artifact.visibility : '';
  if (!['faithful_transform', 'feasibility_analysis', 'progressive_hint', 'full_solution'].includes(mode)) throw new Error('INVALID_AI_ARTIFACT');
  if (!['pseudocode', 'code_snippet'].includes(outputKind) || !['visible', 'hidden'].includes(visibility)) throw new Error('INVALID_AI_ARTIFACT');
  const pseudocode = artifact.pseudocode;
  const mappings = artifact.code_mappings;
  const addedSteps = artifact.added_algorithm_steps;
  if (!Array.isArray(pseudocode) || pseudocode.some((step) => {
    if (!step || typeof step !== 'object') return true;
    const item = /** @type {Record<string, unknown>} */ (step);
    const refs = item.source_refs;
    return Object.keys(item).some((field) => !['id', 'step', 'source_refs'].includes(field)) || typeof item.id !== 'string' || item.id.length === 0 || typeof item.step !== 'string' || item.step.length === 0 || !Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== 'string' || ref.length === 0);
  })) throw new Error('INVALID_AI_ARTIFACT');
  const ids = new Set(pseudocode.map((step) => step.id));
  if (ids.size !== pseudocode.length) throw new Error('INVALID_AI_ARTIFACT');
  if (!Array.isArray(mappings) || !Array.isArray(artifact.assumptions) || artifact.assumptions.some((item) => typeof item !== 'string') || !Array.isArray(artifact.missing_information) || artifact.missing_information.some((item) => typeof item !== 'string') || !Array.isArray(artifact.risk_flags) || artifact.risk_flags.some((item) => typeof item !== 'string') || !Array.isArray(addedSteps) || addedSteps.some((item) => typeof item !== 'string')) throw new Error('INVALID_AI_ARTIFACT');
  if (typeof artifact.code_snippet === 'string' && (artifact.code_snippet.length > 4000 || /\b(?:int|signed|auto|void)\s+main\s*\(/.test(artifact.code_snippet))) throw new Error('INVALID_AI_ARTIFACT');
  if (mappings.some((mapping) => !mapping || typeof mapping !== 'object' || Object.keys(/** @type {Record<string, unknown>} */ (mapping)).some((field) => !['step_id', 'start_line', 'end_line'].includes(field)) || typeof mapping.step_id !== 'string' || !ids.has(mapping.step_id) || !Number.isInteger(mapping.start_line) || mapping.start_line < 1 || !Number.isInteger(mapping.end_line) || mapping.end_line < mapping.start_line)) throw new Error('INVALID_AI_ARTIFACT');
  if (mode === 'faithful_transform' && addedSteps.length > 0) throw new Error('INVALID_AI_ARTIFACT');
  if (outputKind === 'pseudocode' && (artifact.code_snippet !== null || mappings.length > 0)) throw new Error('INVALID_AI_ARTIFACT');
  if (outputKind === 'code_snippet' && (typeof artifact.code_snippet !== 'string' || artifact.code_snippet.length === 0 || mappings.length === 0)) throw new Error('INVALID_AI_ARTIFACT');
}

/** @param {import('./types').WorkspaceState} state */
function selectRemoteDraftWhenPlaceholder(state) {
  const selected = state.drafts.find((draft) => draft.id === state.selected_id);
  if (!selected || selected.id !== 'draft-local' || selected.version > 0 || selected.code || selected.idea || selected.cases) {
    return state;
  }
  if (state.operations.some((operation) => operation.entity_id === selected.id)) return state;

  const remote = state.drafts
    .filter((draft) => draft.id !== selected.id && draft.sync_status === 'synced' && !draft.deleted)
    .filter((draft) => draft.version > 0 || draft.code || draft.idea || draft.cases)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
  return remote ? { ...state, selected_id: remote.id } : state;
}

/** @param {import('./types').WorkspaceState} state */
function shouldReplayForPlaceholder(state) {
  const selected = state.drafts.find((draft) => draft.id === state.selected_id);
  if (!selected || selected.id !== 'draft-local' || selected.version > 0 || selected.code || selected.idea || selected.cases) {
    return false;
  }
  if (state.operations.some((operation) => operation.entity_id === selected.id)) return false;
  return !state.drafts.some((draft) => draft.id !== selected.id && draft.sync_status === 'synced' && !draft.deleted &&
    (draft.version > 0 || draft.code || draft.idea || draft.cases));
}

/** @param {import('./types').Draft} draft @param {string} clientId @param {string} copyId */
function createConflictCopy(draft, clientId, copyId) {
  const now = new Date().toISOString();
  return {
    ...draft,
    id: `${draft.id}-conflict-${copyId}`,
    version: 0,
    created_at: now,
    updated_at: now,
    title: `${draft.title}（冲突副本）`,
    last_modified_client_id: clientId,
    sync_status: /** @type {const} */ ('conflict'),
  };
}
