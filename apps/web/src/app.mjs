import { BrowserWorkspaceRepository, newDraft, queueUpsert } from './storage.mjs';
import { LocalSyncClient } from './sync-client.mjs';

const repository = new BrowserWorkspaceRepository();
const syncClient = new LocalSyncClient();
let state = repository.load();
let saveTimer;
let toastTimer;

// Persist the first-run workspace so a new browser session starts from the same local copy.
repository.save(state);

const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
const statusNames = { local_only: '仅本地', syncing: '同步中', synced: '已同步', conflict: '有冲突', failed: '同步失败' };

function activeDraft() { return state.drafts.find((draft) => draft.id === state.selected_id && !draft.deleted); }

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

function lines(value) { return value.split('\n').map((line) => line.trim()).filter(Boolean); }

function updateDraft(field, value) {
  const draft = activeDraft();
  if (!draft) return;
  draft[field] = value;
  draft.updated_at = new Date().toISOString();
  draft.last_modified_client_id = state.client_id;
  draft.sync_status = 'local_only';
  queueUpsert(state, draft);
  clearTimeout(saveTimer);
  elements.saveStatus.textContent = '· 正在保存';
  saveTimer = setTimeout(() => { persist(); render(); }, 180);
}

function persist() { repository.save(state); }

function createDraft() {
  const draft = newDraft(state.client_id);
  state.drafts.unshift(draft);
  state.selected_id = draft.id;
  queueUpsert(state, draft);
  persist(); render(); elements.titleInput.select();
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
  try {
    for (const operation of pending) {
      const result = await syncClient.push(operation);
      const draft = state.drafts.find((item) => item.id === operation.entity_id);
      if (!draft) continue;
      if (result.status === 'conflict') {
        draft.sync_status = 'conflict';
        const conflictCopy = { ...draft, id: crypto.randomUUID(), title: `${draft.title}（本地冲突副本）`, version: 0, sync_status: 'local_only' };
        state.drafts.unshift(conflictCopy);
      } else {
        draft.version = result.version ?? draft.version;
        draft.sync_status = 'synced';
        state.operations = state.operations.filter((item) => item.operation_id !== operation.operation_id);
      }
    }
    const pulled = await syncClient.pull(state.cursor);
    state.cursor = pulled.next_cursor;
    showToast('本地同步完成。');
  } catch {
    state.drafts.filter((draft) => pending.some((item) => item.entity_id === draft.id)).forEach((draft) => { draft.sync_status = 'failed'; });
    showToast('同步服务不可用，更改仍保存在本机。');
  }
  persist(); render();
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
elements.deleteButton.addEventListener('click', () => {
  const draft = activeDraft();
  if (!draft || !confirm(`删除“${draft.title}”？删除记录会进入同步队列。`)) return;
  draft.deleted = true; draft.sync_status = 'local_only';
  state.operations = state.operations.filter((item) => item.entity_id !== draft.id);
  state.operations.push({ operation_id: crypto.randomUUID(), entity_type: 'draft', entity_id: draft.id, operation_type: 'delete', base_version: draft.version, client_id: state.client_id, occurred_at: new Date().toISOString(), payload: { deleted: true } });
  state.selected_id = state.drafts.find((item) => !item.deleted)?.id ?? '';
  persist(); render();
});
elements.networkToggle.addEventListener('click', () => { state.online = !state.online; persist(); render(); showToast(state.online ? '已切换为在线。' : '已切换为离线。'); });
elements.syncButton.addEventListener('click', synchronize);
elements.artifactToggle.addEventListener('click', () => { const draft = activeDraft(); if (draft) updateDraft('artifact_hidden', !draft.artifact_hidden); });
elements.modeTabs.addEventListener('click', (event) => { if (event.target.dataset.mode) updateDraft('ai_mode', event.target.dataset.mode); });
window.addEventListener('beforeunload', (event) => { if (state.operations.length) { event.preventDefault(); event.returnValue = ''; } });

render();
