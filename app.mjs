import { BrowserWorkspaceRepository, newDraft, queueUpsert, queueDelete, joinSegments } from './storage.mjs';
import { LocalSyncClient } from './sync-client.mjs';

const repository = new BrowserWorkspaceRepository();
const syncClient = new LocalSyncClient();
let state = repository.load();
let saveTimer;
let toastTimer;
let undoStack = [];
let redoStack = [];

// 首次运行持久化，保证新会话从同一份本地副本继续。
repository.save(state);

const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
const statusNames = { local_only: '仅本地', syncing: '同步中', synced: '已同步', conflict: '有冲突', failed: '同步失败' };
const UNDO_FIELDS = ['title', 'idea', 'code', 'rewrite'];

function activeDraft() { return state.drafts.find((draft) => draft.id === state.selected_id && !draft.deleted); }
function activeConflict() { return state.conflicts.find((conflict) => conflict.entity_id === state.selected_id); }

function render() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const drafts = state.drafts.filter((draft) => !draft.deleted && `${draft.title} ${draft.idea}`.toLowerCase().includes(query));
  elements.draftList.replaceChildren(...drafts.map(draftListItem));
  const draft = activeDraft();
  elements.emptyState.hidden = Boolean(draft);
  elements.editorContent.hidden = !draft;
  if (!draft) return;
  elements.titleInput.value = draft.title;
  elements.ideaInput.value = draft.idea;
  elements.codeInput.value = draft.code;
  elements.rewriteInput.value = draft.rewrite;
  elements.syncStatus.textContent = statusNames[draft.sync_status] ?? '未知状态';
  elements.saveStatus.textContent = '· 已保存到本机';
  elements.syncDot.className = `status-dot ${draft.sync_status === 'conflict' ? 'conflict' : ''}`;
  elements.artifactSection.hidden = draft.artifact_hidden;
  elements.artifactToggle.textContent = draft.artifact_hidden ? '显示 AI 区域' : '隐藏 AI 区域';
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === draft.ai_mode));
  renderSources(draft);
  renderConflictBanner(draft);
  elements.undoButton.disabled = undoStack.length === 0;
  elements.redoButton.disabled = redoStack.length === 0;
  const ideaLines = lines(draft.idea).length;
  const rewriteLines = lines(draft.rewrite).length;
  elements.differenceSummary.textContent = rewriteLines ? `原思路 ${ideaLines} 个片段 · 独立复写 ${rewriteLines} 行` : '复写将作为独立内容保存，不覆盖原思路。';
  elements.networkToggle.style.color = state.online ? 'var(--signal)' : 'var(--danger)';
  elements.networkToggle.title = state.online ? '本地联网状态：在线' : '本地联网状态：离线';
}

function draftListItem(draft) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `draft-item ${draft.id === state.selected_id ? 'active' : ''}`;
  const title = document.createElement('strong');
  const meta = document.createElement('span');
  title.textContent = draft.title || '未命名思路';
  meta.textContent = `${statusNames[draft.sync_status]} · ${new Date(draft.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  button.append(title, meta);
  button.addEventListener('click', () => { state.selected_id = draft.id; persist(); render(); });
  return button;
}

function renderSources(draft) {
  const segments = lines(draft.idea);
  elements.segmentCount.textContent = `${segments.length} 个片段`;
  elements.sourceMap.replaceChildren(...segments.map((content, index) => {
    const item = document.createElement('li');
    item.textContent = `${content} · idea_segment_${index + 1}`;
    return item;
  }));
}

function renderConflictBanner(draft) {
  const conflict = activeConflict();
  const banner = elements.conflictBanner;
  if (!conflict) { banner.hidden = true; return; }
  banner.hidden = false;
  const server = conflict.server_entity ?? {};
  elements.conflictLocalTitle.textContent = draft.title || '未命名思路';
  elements.conflictServerTitle.textContent = server.title ?? '（服务器版本）';
  elements.conflictServerMeta.textContent = `服务器版本 v${server.version ?? '?'} · 本机版本 v${draft.version}`;
}

function lines(value) { return value.split('\n').map((line) => line.trim()).filter(Boolean); }

function snapshotDraft(draft) {
  return { id: draft.id, title: draft.title, idea: draft.idea, code: draft.code, rewrite: draft.rewrite };
}

function applySnapshot(draft, snapshot) {
  draft.title = snapshot.title;
  draft.idea = snapshot.idea;
  draft.code = snapshot.code;
  draft.rewrite = snapshot.rewrite;
  draft.updated_at = new Date().toISOString();
  draft.last_modified_client_id = state.client_id;
  draft.sync_status = 'local_only';
  queueUpsert(state, draft);
}

function updateDraft(field, value) {
  const draft = activeDraft();
  if (!draft) return;
  if (UNDO_FIELDS.includes(field) && !saveTimer) {
    undoStack.push(snapshotDraft(draft));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  draft[field] = value;
  draft.updated_at = new Date().toISOString();
  draft.last_modified_client_id = state.client_id;
  draft.sync_status = 'local_only';
  queueUpsert(state, draft);
  clearTimeout(saveTimer);
  elements.saveStatus.textContent = '· 正在保存';
  saveTimer = setTimeout(() => { persist(); render(); }, 180);
}

function undo() {
  const draft = activeDraft();
  if (!draft || undoStack.length === 0) return;
  clearTimeout(saveTimer); saveTimer = undefined;
  redoStack.push(snapshotDraft(draft));
  applySnapshot(draft, undoStack.pop());
  persist(); render();
}

function redo() {
  const draft = activeDraft();
  if (!draft || redoStack.length === 0) return;
  clearTimeout(saveTimer); saveTimer = undefined;
  undoStack.push(snapshotDraft(draft));
  applySnapshot(draft, redoStack.pop());
  persist(); render();
}

function persist() { repository.save(state); }

function createDraft() {
  const draft = newDraft(state.client_id);
  state.drafts.unshift(draft);
  state.selected_id = draft.id;
  queueUpsert(state, draft);
  persist(); render(); elements.titleInput.select();
}

function resolveConflict(keepServer) {
  const draft = activeDraft();
  const conflict = activeConflict();
  if (!draft || !conflict) return;
  if (keepServer) {
    draft.title = conflict.server_entity.title ?? draft.title;
    draft.idea = joinSegments(conflict.server_entity.idea_segments);
    draft.code = conflict.server_entity.code ?? '';
    draft.version = conflict.server_entity.version ?? draft.version;
    draft.updated_at = conflict.server_entity.updated_at ?? draft.updated_at;
    draft.sync_status = 'synced';
    state.operations = state.operations.filter((item) => item.entity_id !== draft.id);
  } else {
    // 保留本地：以服务器版本为基准重新入队，下次同步显式覆盖（经用户选择，非静默）
    draft.version = conflict.server_entity.version ?? draft.version;
    draft.sync_status = 'local_only';
    queueUpsert(state, draft);
  }
  state.conflicts = state.conflicts.filter((item) => item.entity_id !== draft.id);
  persist(); render();
  showToast(keepServer ? '已采用服务器版本' : '已保留本地版本，将在下次同步时提交');
}

async function synchronize() {
  if (!state.online) return showToast('当前为离线状态，操作已留在本地队列。');
  const pending = [...state.operations];
  if (!pending.length) return showToast('没有待同步的更改。');
  for (const operation of pending) {
    const draft = state.drafts.find((item) => item.id === operation.entity_id);
    if (draft) draft.sync_status = 'syncing';
  }
  render();
  let allApplied = true;
  try {
    for (const operation of pending) {
      const result = await syncClient.push(operation);
      const draft = state.drafts.find((item) => item.id === operation.entity_id);
      if (!draft) continue;
      if (result.status === 'conflict') {
        allApplied = false;
        draft.sync_status = 'conflict';
        // 服务器版本保存为“远程副本”，本地修改保留为“冲突副本”，不静默覆盖
        state.conflicts.push({
          entity_id: operation.entity_id,
          server_entity: result.server_entity,
          local_snapshot: snapshotDraft(draft),
          created_at: new Date().toISOString()
        });
      } else if (result.status === 'rejected') {
        allApplied = false;
        draft.sync_status = 'failed';
      } else {
        draft.version = result.version ?? draft.version;
        draft.sync_status = 'synced';
        state.operations = state.operations.filter((item) => item.operation_id !== operation.operation_id);
      }
    }
    // 整批成功后才推进游标；有冲突/失败时保留游标，待解决后重试
    if (allApplied) {
      const pulled = await syncClient.pull(state.cursor);
      applyServerChanges(pulled.changes);
      state.cursor = pulled.next_cursor;
      showToast('本地同步完成。');
    } else {
      showToast('部分更改存在冲突或失败，已保留本地副本，请处理后再同步。');
    }
  } catch {
    state.drafts.filter((draft) => pending.some((item) => item.entity_id === draft.id)).forEach((draft) => { draft.sync_status = 'failed'; });
    showToast('同步服务不可用，更改仍保存在本机。');
  }
  persist(); render();
}

function applyServerChanges(changes) {
  for (const change of changes) {
    const entity = change.entity;
    if (!entity) continue;
    const draft = state.drafts.find((item) => item.id === entity.id);
    if (entity.deleted) {
      if (draft) { draft.deleted = true; draft.deleted_at = entity.deleted_at ?? new Date().toISOString(); }
      continue;
    }
    if (!draft) {
      state.drafts.unshift({
        id: entity.id, workspace_id: entity.workspace_id, version: entity.version,
        created_at: entity.created_at, updated_at: entity.updated_at, deleted: false, deleted_at: null,
        last_modified_client_id: entity.last_modified_client_id, title: entity.title, language: entity.language,
        idea: joinSegments(entity.idea_segments), code: entity.code ?? '', rewrite: '',
        ai_mode: 'faithful_transform', artifact_hidden: false, sync_status: 'synced'
      });
      continue;
    }
    draft.title = entity.title ?? draft.title;
    draft.idea = joinSegments(entity.idea_segments);
    draft.code = entity.code ?? '';
    draft.version = entity.version;
    draft.updated_at = entity.updated_at;
    draft.last_modified_client_id = entity.last_modified_client_id;
    draft.sync_status = 'synced';
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2600);
}

elements.newDraftButton.addEventListener('click', createDraft);
elements.emptyCreateButton.addEventListener('click', createDraft);
elements.searchInput.addEventListener('input', render);
elements.titleInput.addEventListener('input', (event) => updateDraft('title', event.target.value));
elements.ideaInput.addEventListener('input', (event) => updateDraft('idea', event.target.value));
elements.codeInput.addEventListener('input', (event) => updateDraft('code', event.target.value));
elements.rewriteInput.addEventListener('input', (event) => updateDraft('rewrite', event.target.value));
elements.undoButton.addEventListener('click', undo);
elements.redoButton.addEventListener('click', redo);
elements.deleteButton.addEventListener('click', () => {
  const draft = activeDraft();
  if (!draft || !confirm(`删除“${draft.title}”？删除记录会进入同步队列。`)) return;
  draft.deleted = true;
  draft.deleted_at = new Date().toISOString();
  draft.sync_status = 'local_only';
  queueDelete(state, draft);
  state.selected_id = state.drafts.find((item) => !item.deleted)?.id ?? '';
  persist(); render();
});
elements.keepServerButton.addEventListener('click', () => resolveConflict(true));
elements.keepLocalButton.addEventListener('click', () => resolveConflict(false));
elements.networkToggle.addEventListener('click', () => { state.online = !state.online; persist(); render(); showToast(state.online ? '已切换为在线。' : '已切换为离线。'); });
elements.syncButton.addEventListener('click', synchronize);
elements.artifactToggle.addEventListener('click', () => { const draft = activeDraft(); if (draft) updateDraft('artifact_hidden', !draft.artifact_hidden); });
elements.modeTabs.addEventListener('click', (event) => { if (event.target.dataset.mode) updateDraft('ai_mode', event.target.dataset.mode); });
window.addEventListener('beforeunload', (event) => {
  persist();
  if (state.operations.length) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  else if (key === 'y') { event.preventDefault(); redo(); }
});

render();
