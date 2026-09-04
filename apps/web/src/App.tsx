import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityBar } from './components/ActivityBar';
import { EditorStage } from './components/EditorStage';
import { InspectorPanel } from './components/InspectorPanel';
import { TopBar } from './components/TopBar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { initialDocuments } from './data';
import { BrowserWorkspaceRepository, queueUpsert } from './storage.mjs';
import { LocalSyncClient, synchronizeWorkspace } from './sync-client.mjs';
import type { ConflictRecord, Documents, Draft, FileId, Mode, Panel, SyncStatus, WorkspaceState } from './types';
import { reviewCpp } from './code-review';

interface ConflictChoice {
  copy: Draft;
  server: Draft;
}

const syncClient = new LocalSyncClient();

export function App() {
  const [clientId] = useState(getClientId);
  const [repository] = useState(() => new BrowserWorkspaceRepository(clientId));
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => repository.load());
  const currentDraft = useMemo(
    () => workspace.drafts.find((draft) => draft.id === workspace.selected_id) ?? workspace.drafts[0],
    [workspace.drafts, workspace.selected_id],
  );
  const [documents, setDocuments] = useState<Documents>(() => draftToDocuments(currentDraft));
  const [activeFile, setActiveFile] = useState<FileId>('main.cpp');
  const [activePanel, setActivePanel] = useState<Panel>('files');
  const [mode, setMode] = useState<Mode>(currentDraft?.ai_mode ?? 'faithful_transform');
  const [bottomOpen, setBottomOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [query, setQuery] = useState('');
  const [syncState, setSyncState] = useState<SyncStatus>(
    workspace.conflicts.some((item) => !item.resolved) ? 'conflict' : currentDraft?.sync_status ?? 'local_only',
  );
  const [conflict, setConflict] = useState<ConflictChoice | null>(() => unresolvedConflict(workspace));
  const [jumpToLine, setJumpToLine] = useState(0);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const handleCursorChange = useCallback((line: number, column: number) => {
    setCursorPosition({ line, column });
  }, []);

  const flushQueue = useCallback(async () => {
    const state = repository.load();
    if (!navigator.onLine) {
      setSyncState('local_only');
      setWorkspace(state);
      return;
    }
    setSyncState('syncing');
    const result = await synchronizeWorkspace(state, syncClient);
    repository.save(result.state);
    setWorkspace(result.state);
    const draft = result.state.drafts.find((item) => item.id === result.state.selected_id) ?? result.state.drafts[0];
    if (draft) setDocuments(draftToDocuments(draft));
    setSyncState(result.status);
    const pendingConflict = unresolvedConflict(result.state);
    if (pendingConflict) setConflict(pendingConflict);
  }, [clientId, repository]);

  useEffect(() => {
    void flushQueue();
    const onOnline = () => void flushQueue();
    const onOffline = () => setSyncState('local_only');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [flushQueue]);

  function updateActiveDocument(value: string) {
    setDocuments((current) => ({ ...current, [activeFile]: value }));
    setSaved(false);
  }

  function saveWorkspace() {
    const base = repository.load();
    const draft = currentDraft;
    if (!draft) return;
    const updated: Draft = {
      ...draft,
      code: documents['main.cpp'],
      idea: documents['idea.md'],
      cases: documents['cases.txt'],
      ai_mode: mode,
      updated_at: new Date().toISOString(),
      last_modified_client_id: clientId,
      sync_status: navigator.onLine ? 'syncing' : 'local_only',
    };
    const next = replaceDraft({ ...base, online: navigator.onLine }, updated);
    queueUpsert(next, updated);
    repository.save(next);
    setWorkspace(next);
    setSaved(true);
    setSyncState(navigator.onLine ? 'syncing' : 'local_only');
    if (navigator.onLine) void flushQueue();
  }

  function syncNow() {
    if (!saved) {
      saveWorkspace();
      return;
    }
    void flushQueue();
  }

  function selectDraft(draftId: string) {
    if (!saved) saveWorkspace();
    const state = repository.load();
    const draft = state.drafts.find((item) => item.id === draftId);
    if (!draft) return;
    const next = { ...state, selected_id: draftId };
    repository.save(next);
    setWorkspace(next);
    setDocuments(draftToDocuments(draft));
    setMode(draft.ai_mode);
    setSaved(true);
    setSyncState(draft.sync_status);
  }

  function keepConflictCopy() {
    if (!conflict) return;
    const state = repository.load();
    const copy: Draft = {
      ...conflict.copy,
      sync_status: navigator.onLine ? 'syncing' : 'local_only',
    };
    const next = replaceDraft({ ...state, selected_id: copy.id }, copy);
    next.conflicts = state.conflicts.map((record) => record.local_copy_id === copy.id ? { ...record, resolved: true } : record);
    queueUpsert(next, copy);
    repository.save(next);
    setWorkspace(next);
    setDocuments(draftToDocuments(copy));
    setConflict(null);
    setSyncState(navigator.onLine ? 'syncing' : 'local_only');
    if (navigator.onLine) void flushQueue();
  }

  function useServerVersion() {
    if (!conflict) return;
    const state = repository.load();
    let next = replaceDraft(
      { ...state, selected_id: conflict.server.id, drafts: state.drafts.filter((draft) => draft.id !== conflict.copy.id) },
      { ...conflict.server, sync_status: 'synced' },
    );
    next.conflicts = state.conflicts.map((record) => record.local_copy_id === conflict.copy.id ? { ...record, resolved: true } : record);
    repository.save(next);
    setWorkspace(next);
    setDocuments(draftToDocuments(conflict.server));
    setConflict(null);
    setSaved(true);
    setSyncState('synced');
  }

  const bodyClassName = inspectorHidden ? 'ide-body inspector-collapsed' : 'ide-body';
  const reviewIssues = activeFile.endsWith('.cpp') ? reviewCpp(documents[activeFile]) : [];

  return (
    <div className={conflict ? 'ide-shell has-conflict' : 'ide-shell'}>
      <TopBar saved={saved} syncState={syncState} onSync={syncNow} />
      {conflict && (
        <div className="sync-conflict-banner" role="alert">
          <div>
            <strong>检测到并发修改</strong>
            <span>服务器版本和本地编辑都已保留，请选择继续方式。</span>
          </div>
          <div className="conflict-actions">
            <button type="button" onClick={keepConflictCopy}>保留本地冲突副本</button>
            <button type="button" onClick={useServerVersion}>采用服务器版本</button>
          </div>
        </div>
      )}
      <main className={bodyClassName}>
        <ActivityBar activePanel={activePanel} onPanelChange={setActivePanel} />
        <WorkspaceSidebar
          activeFile={activeFile}
          activePanel={activePanel}
          drafts={workspace.drafts}
          selectedDraftId={workspace.selected_id}
          mode={mode}
          query={query}
          saved={saved}
          onDraftChange={selectDraft}
          onFileChange={setActiveFile}
          onModeChange={setMode}
          onQueryChange={setQuery}
        />
        <EditorStage
          activeFile={activeFile}
          bottomOpen={bottomOpen}
          code={documents[activeFile]}
          mode={mode}
          saved={saved}
          onBottomToggle={() => setBottomOpen((open) => !open)}
          onChange={updateActiveDocument}
          onSave={saveWorkspace}
          jumpToLine={jumpToLine}
          cursorPosition={cursorPosition}
          onCursorChange={handleCursorChange}
          onFileChange={setActiveFile}
        />
        <InspectorPanel
          hidden={inspectorHidden}
          issues={reviewIssues}
          onJumpToLine={setJumpToLine}
          onHide={() => setInspectorHidden(true)}
          onShow={() => setInspectorHidden(false)}
        />
      </main>
    </div>
  );
}

function getClientId(): string {
  const key = 'algoflow.client_id';
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const id = `web-${crypto.randomUUID()}`;
  sessionStorage.setItem(key, id);
  return id;
}

function draftToDocuments(draft: Draft | undefined): Documents {
  if (!draft || (!draft.code && !draft.idea && draft.cases === undefined)) return initialDocuments;
  return { 'main.cpp': draft.code, 'idea.md': draft.idea, 'cases.txt': draft.cases ?? '' };
}

function replaceDraft(state: WorkspaceState, draft: Draft): WorkspaceState {
  const found = state.drafts.some((item) => item.id === draft.id);
  return { ...state, drafts: found ? state.drafts.map((item) => item.id === draft.id ? draft : item) : [...state.drafts, draft] };
}

function unresolvedConflict(state: WorkspaceState): ConflictChoice | null {
  const record: ConflictRecord | undefined = state.conflicts.find((item) => !item.resolved);
  if (!record) return null;
  const copy = state.drafts.find((draft) => draft.id === record.local_copy_id);
  return copy ? { copy, server: record.server_entity } : null;
}
