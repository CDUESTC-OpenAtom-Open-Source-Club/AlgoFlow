const STORAGE_KEY = 'algoflow.workspace.v1';

export class BrowserWorkspaceRepository {
  load() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return value && Array.isArray(value.drafts) ? value : initialState();
    } catch {
      return initialState();
    }
  }

  save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

export function newDraft(clientId) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    id, workspace_id: 'workspace-local', version: 0, created_at: now, updated_at: now,
    deleted: false, last_modified_client_id: clientId, title: '未命名思路', language: 'cpp',
    idea: '', code: '', rewrite: '', ai_mode: 'faithful_transform', artifact_hidden: false,
    sync_status: 'local_only'
  };
}

export function queueUpsert(state, draft) {
  const existing = state.operations.find((item) => item.entity_id === draft.id && item.operation_type === 'upsert');
  const operation = {
    operation_id: existing?.operation_id ?? crypto.randomUUID(), entity_type: 'draft', entity_id: draft.id,
    operation_type: 'upsert', base_version: draft.version, client_id: state.client_id,
    occurred_at: new Date().toISOString(), payload: { ...draft, sync_status: 'synced' }
  };
  state.operations = state.operations.filter((item) => item.entity_id !== draft.id);
  state.operations.push(operation);
}

function initialState() {
  const clientId = `web-${crypto.randomUUID()}`;
  const draft = newDraft(clientId);
  return { client_id: clientId, cursor: '0', online: true, selected_id: draft.id, drafts: [draft], operations: [] };
}
