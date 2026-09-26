import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { WebAIClient, toCursor } from './ai-client.mjs';
import { BrowserAIResultRepository } from './ai-result-storage.mjs';
import { AISession } from './ai-session.mjs';
import type { AIContext, ApplyAIEditorChange } from './types';

interface ConflictChoice {
  copy: Draft;
  server: Draft;
}

const syncClient = new LocalSyncClient();
const aiClient = new WebAIClient();

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
  const [aiSession] = useState(() => new AISession(aiClient, new BrowserAIResultRepository()));
  const aiState = useSyncExternalStore(aiSession.subscribe, aiSession.getSnapshot, aiSession.getSnapshot);
  const editorApply = useRef<ApplyAIEditorChange | null>(null);
  const editEpoch = useRef(0);
  const hasUnsavedEdits = useRef(false);
  const syncRunning = useRef(false);
  const syncAgain = useRef(false);
  const inFlightOperations = useRef(new Set<string>());
  const handleEditorReady = useCallback((apply: ApplyAIEditorChange | null) => { editorApply.current = apply; }, []);
  const handleCursorChange = useCallback((line: number, column: number) => {
    setCursorPosition({ line, column });
  }, []);

  useLayoutEffect(() => {
    if (currentDraft) aiSession.setContext(makeAIContext(currentDraft, documents, activeFile, mode));
  }, [aiSession, currentDraft, documents, activeFile, mode]);

  useEffect(() => () => aiSession.dispose(), [aiSession]);

  useEffect(() => {
    for (const draft of workspace.drafts) if (draft.deleted) aiSession.removeDraft(draft.id);
  }, [aiSession, workspace.drafts]);

  const flushQueue = useCallback(async () => {
    if (syncRunning.current) { syncAgain.current = true; return; }
    syncRunning.current = true;
    try {
    do {
    syncAgain.current = false;
    const startedAt = editEpoch.current;
    const state = repository.load();
    repository.save(state);
    if (!navigator.onLine) {
      setSyncState('local_only');
      setWorkspace(state);
      return;
    }
    setSyncState('syncing');
    inFlightOperations.current = new Set(state.operations.map(operation => operation.operation_id));
    const result = await synchronizeWorkspace(state, syncClient);
    // A save or selection during the request belongs to a newer local state.
    // Retry against that state; operation IDs make a repeated push idempotent.
    if (JSON.stringify(repository.load()) !== JSON.stringify(state)) {
      syncAgain.current = true;
      continue;
    }
    repository.save(result.state);
    setWorkspace(previous => {
      if (!hasUnsavedEdits.current) return result.state;
      const local = previous.drafts.find(draft => draft.id === previous.selected_id);
      return local ? replaceDraft({ ...result.state, selected_id: previous.selected_id }, local) : result.state;
    });
    const draft = result.state.drafts.find((item) => item.id === result.state.selected_id) ?? result.state.drafts[0];
    if (draft && startedAt === editEpoch.current && !hasUnsavedEdits.current) {
      aiSession.cancel();
      setDocuments(draftToDocuments(draft));
      setMode(draft.ai_mode);
    }
    setSyncState(result.status);
    const pendingConflict = unresolvedConflict(result.state);
    if (pendingConflict) setConflict(pendingConflict);
    } while (syncAgain.current);
    } finally {
      inFlightOperations.current.clear();
      syncRunning.current = false;
    }
  }, [aiSession, repository]);

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
    hasUnsavedEdits.current = true;
    const next = { ...documents, [activeFile]: value };
    editEpoch.current += 1;
    if (currentDraft) aiSession.setContext(makeAIContext(currentDraft, next, activeFile, mode));
    setDocuments(next);
    setSaved(false);
  }

  function selectFile(file: FileId) {
    if (currentDraft) aiSession.setContext(makeAIContext(currentDraft, documents, file, mode));
    setActiveFile(file);
  }

  function selectMode(nextMode: Mode) {
    hasUnsavedEdits.current = true;
    editEpoch.current += 1;
    if (currentDraft) aiSession.setContext(makeAIContext(currentDraft, documents, activeFile, nextMode));
    setMode(nextMode);
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
    // Never mutate the payload of an operation that may already be committed.
    // A fresh operation with the old base preserves the newer edit as a
    // conflict if the earlier push won the race.
    next.operations = next.operations.map(operation => inFlightOperations.current.has(operation.operation_id)
      ? { ...operation, operation_id: crypto.randomUUID() } : operation);
    repository.save(next);
    setWorkspace(next);
    hasUnsavedEdits.current = false;
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
    editEpoch.current += 1;
    aiSession.setContext(makeAIContext(draft, draftToDocuments(draft), activeFile, draft.ai_mode));
    const next = { ...state, selected_id: draftId };
    repository.save(next);
    setWorkspace(next);
    setDocuments(draftToDocuments(draft));
    setMode(draft.ai_mode);
    hasUnsavedEdits.current = false;
    setSaved(true);
    setSyncState(draft.sync_status);
  }

  function keepConflictCopy() {
    if (!conflict) return;
    editEpoch.current += 1;
    aiSession.cancel();
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
    hasUnsavedEdits.current = false;
    setSaved(true);
    setMode(copy.ai_mode);
    setConflict(null);
    setSyncState(navigator.onLine ? 'syncing' : 'local_only');
    if (navigator.onLine) void flushQueue();
  }

  function useServerVersion() {
    if (!conflict) return;
    editEpoch.current += 1;
    aiSession.cancel();
    const state = repository.load();
    let next = replaceDraft(
      { ...state, selected_id: conflict.server.id, drafts: state.drafts.filter((draft) => draft.id !== conflict.copy.id) },
      { ...conflict.server, sync_status: 'synced' },
    );
    next.conflicts = state.conflicts.map((record) => record.local_copy_id === conflict.copy.id ? { ...record, resolved: true } : record);
    repository.save(next);
    setWorkspace(next);
    setDocuments(draftToDocuments(conflict.server));
    hasUnsavedEdits.current = false;
    setMode(conflict.server.ai_mode);
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
          onFileChange={selectFile}
          onModeChange={selectMode}
          onQueryChange={setQuery}
          ideaSegments={aiState.segments}
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
          onFileChange={selectFile}
          editorKey={`${currentDraft?.id}:${activeFile}`}
          onEditorReady={handleEditorReady}
        />
        <InspectorPanel
          hidden={inspectorHidden}
          issues={reviewIssues}
          onJumpToLine={setJumpToLine}
          onHide={() => setInspectorHidden(true)}
          onShow={() => setInspectorHidden(false)}
          aiState={aiState}
          mode={mode}
          activeFile={activeFile}
          canAcceptCompletion={aiSession.canAcceptCompletion()}
          onReview={(kind) => { void aiSession.requestReview(kind); }}
          onCompletion={() => { void aiSession.requestCompletion(toCursor(cursorPosition.line, cursorPosition.column)); }}
          onAcceptCompletion={() => { aiSession.acceptCompletion(change => editorApply.current?.(change) ?? false); }}
          onRejectCompletion={() => aiSession.rejectCompletion()}
          onCancel={() => aiSession.cancel()}
          onToggleResult={(id, hidden) => aiSession.setHidden(id, hidden)}
          onRetryStorage={() => aiSession.retryStorage()}
        />
      </main>
    </div>
  );
}

function makeAIContext(draft: Draft, documents: Documents, fileId: FileId, mode: Mode): AIContext {
  return { draftId: draft.id, draftVersion: draft.version, fileId, mode,
    code: documents['main.cpp'], idea: documents['idea.md'], problemContext: draft.title || '当前草稿' };
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
