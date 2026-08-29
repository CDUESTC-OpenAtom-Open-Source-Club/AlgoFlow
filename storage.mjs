const STORAGE_KEY = 'algoflow.workspace.v1';

export class BrowserWorkspaceRepository {
  load() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return value && Array.isArray(value.drafts) ? normalizeState(value) : initialState();
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
    deleted: false, deleted_at: null, last_modified_client_id: clientId, title: '未命名思路', language: 'cpp',
    idea: '', code: '', rewrite: '', ai_mode: 'faithful_transform', artifact_hidden: false,
    sync_status: 'local_only'
  };
}

/**
 * 结构化同步载荷：只传输契约字段，不夹带 UI 状态（rewrite / ai_mode / artifact_hidden / sync_status）。
 * 思路以 idea_segments 结构化数组传输，避免裸文本大段明文本地覆盖。
 */
export function draftPayload(draft) {
  return {
    workspace_id: draft.workspace_id ?? 'workspace-local',
    title: draft.title,
    language: draft.language ?? 'cpp',
    idea_segments: ideaSegments(draft.idea),
    code: draft.code ?? '',
    deleted: false
  };
}

/** 入队一次草稿 upsert；同一草稿重试复用原 operation_id（幂等）。 */
export function queueUpsert(state, draft) {
  const existing = state.operations.find((item) => item.entity_id === draft.id && item.operation_type === 'upsert');
  const operation = {
    operation_id: existing?.operation_id ?? crypto.randomUUID(),
    entity_type: 'draft', entity_id: draft.id, operation_type: 'upsert',
    base_version: draft.version, client_id: state.client_id,
    occurred_at: new Date().toISOString(), payload: draftPayload(draft)
  };
  state.operations = state.operations.filter((item) => item.entity_id !== draft.id);
  state.operations.push(operation);
}

/** 入队一次删除（墓碑）：deleted_at 非空，参与同步游标推进。 */
export function queueDelete(state, draft) {
  state.operations = state.operations.filter((item) => item.entity_id !== draft.id);
  state.operations.push({
    operation_id: crypto.randomUUID(),
    entity_type: 'draft', entity_id: draft.id, operation_type: 'delete',
    base_version: draft.version, client_id: state.client_id,
    occurred_at: new Date().toISOString(),
    payload: { deleted: true, deleted_at: new Date().toISOString() }
  });
}

export function ideaSegments(idea) {
  return idea.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((content, index) => ({ id: `idea_segment_${index + 1}`, position: index, content }));
}

export function joinSegments(segments) {
  if (!Array.isArray(segments)) return '';
  return [...segments].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((segment) => segment.content ?? '').filter((content) => content.length > 0).join('\n');
}

function normalizeState(state) {
  state.conflicts = state.conflicts ?? [];
  state.online = state.online ?? true;
  state.cursor = state.cursor ?? '0';
  state.operations = state.operations ?? [];
  state.selected_id = state.selected_id ?? (state.drafts.find((item) => !item.deleted)?.id ?? '');
  return state;
}

function initialState() {
  const clientId = `web-${crypto.randomUUID()}`;
  const draft = newDraft(clientId);
  return { client_id: clientId, cursor: '0', online: true, selected_id: draft.id, drafts: [draft], operations: [], conflicts: [] };
}
