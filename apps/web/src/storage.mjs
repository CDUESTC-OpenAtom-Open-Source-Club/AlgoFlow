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
        return {
          ...value,
          client_id: clientId,
          cursor: localStorage.getItem(`${CURSOR_KEY_PREFIX}${clientId}`) ?? value.cursor ?? '0',
          operations: readOperations(clientId, value.operations),
          conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
        };
      }
      return initialState(this.clientId);
    } catch {
      return initialState(this.clientId);
    }
  }

  /** @param {import('./types').WorkspaceState} state */
  save(state) {
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
    idea: '', code: '', rewrite: '', ai_mode: 'faithful_transform', artifact_hidden: false,
    sync_status: 'local_only', archived: false, archived_at: ''
  };
}

/**
 * @param {import('./types').WorkspaceState} state
 * @param {import('./types').Draft} draft
 */
export function queueUpsert(state, draft) {
  const existing = state.operations.find((item) => item.entity_id === draft.id && item.operation_type === 'upsert');
  /** @type {import('./types').SyncOperation} */
  const operation = {
    operation_id: existing?.operation_id ?? crypto.randomUUID(), entity_type: 'draft', entity_id: draft.id,
    operation_type: 'upsert', base_version: existing?.base_version ?? draft.version, client_id: state.client_id,
    occurred_at: new Date().toISOString(), payload: { ...draft, sync_status: 'synced' }
  };
  state.operations = state.operations.filter((item) => item.entity_id !== draft.id);
  state.operations.push(operation);
}

/** @param {string | null} [clientId] @returns {import('./types').WorkspaceState} */
function initialState(clientId = null) {
  const resolvedClientId = clientId ?? `web-${crypto.randomUUID()}`;
  const draft = newDraft(resolvedClientId);
  // Keep the first local demo draft addressable from multiple browser tabs.
  draft.id = 'draft-local';
  return { client_id: resolvedClientId, cursor: '0', online: true, selected_id: draft.id, drafts: [draft], operations: [], conflicts: [] };
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
