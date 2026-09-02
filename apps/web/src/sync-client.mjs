const API_BASE = import.meta.env?.VITE_SYNC_API_BASE ?? 'http://127.0.0.1:8787';

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
  let next = { ...state, drafts: [...state.drafts], operations: [...state.operations], conflicts: [...state.conflicts], online: true };
  let hadConflict = false;
  let hadFailure = false;

  for (const operation of [...next.operations]) {
    try {
      const result = await client.push(operation);
      if (result.status === 'conflict') {
        if (!result.server_entity) {
          hadFailure = true;
          continue;
        }
        const local = /** @type {import('./types').Draft} */ (/** @type {unknown} */ (operation.payload));
        const copy = createConflictCopy(local, next.client_id, createId());
        next = replaceDraft(next, { ...result.server_entity, sync_status: 'synced' });
        next = replaceDraft(next, copy);
        next.operations = next.operations.filter((item) => item.operation_id !== operation.operation_id);
        next.conflicts.push({
          id: createId(),
          entity_id: operation.entity_id,
          local_copy_id: copy.id,
          server_entity: result.server_entity,
          created_at: new Date().toISOString(),
          resolved: false,
        });
        hadConflict = true;
        continue;
      }

      if (result.status === 'applied' || result.status === 'duplicate') {
        const entity = result.server_entity ?? { ...operation.payload, version: result.version ?? operation.base_version };
        next = replaceDraft(next, { .../** @type {import('./types').Draft} */ (entity), sync_status: 'synced' });
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
    if (change.entity_type !== 'draft' || change.entity.last_modified_client_id === clientId) continue;
    const hasPendingOperation = next.operations.some((operation) => operation.entity_id === change.entity.id);
    const local = next.drafts.find((draft) => draft.id === change.entity.id);
    if (!hasPendingOperation && (!local || change.entity.version >= local.version)) {
      next = replaceDraft(next, { ...change.entity, sync_status: 'synced' });
    }
  }
  return next;
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
