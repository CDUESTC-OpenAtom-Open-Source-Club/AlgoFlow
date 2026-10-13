import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityBar } from './components/ActivityBar';
import { EditorStage } from './components/EditorStage';
import { InspectorPanel } from './components/InspectorPanel';
import { TopBar } from './components/TopBar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { initialDocuments } from './data';
import { BrowserWorkspaceRepository, getAIArtifactFreshness, queueAIArtifact, queueReviewResult, queueUpsert, selectCurrentAIArtifact, sortAIArtifactsNewestFirst } from './storage.mjs';
import { LocalSyncClient, synchronizeWorkspace } from './sync-client.mjs';
import type { AIArtifact, AIResultRecord, ConflictRecord, Documents, Draft, FileId, Mode, Panel, ReviewResult, SyncStatus, WorkspaceState } from './types';
import { reviewCpp } from './code-review';
import { artifactFromGateway, buildAIRequest, WebAIClient, toCursor } from './ai-client.mjs';
import { assertAIArtifact } from './sync-client.mjs';
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
  const [artifactBusy, setArtifactBusy] = useState(false);
  const [artifactMessage, setArtifactMessage] = useState('');
  const [aiSession] = useState(() => new AISession(aiClient, new BrowserAIResultRepository()));
  const aiState = useSyncExternalStore(aiSession.subscribe, aiSession.getSnapshot, aiSession.getSnapshot);
  const artifactHistory = useMemo(() => currentDraft
    ? sortAIArtifactsNewestFirst((workspace.ai_artifacts ?? []).filter((artifact) => artifact.draft_id === currentDraft.id && artifact.mode === mode && !artifact.deleted))
    : [], [workspace.ai_artifacts, currentDraft, mode]);
  const currentArtifact = useMemo(() => currentDraft ? selectCurrentAIArtifact(workspace, currentDraft.id, mode) ?? null : null,
    [workspace, currentDraft, mode]);
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

  useEffect(() => {
    aiSession.importRecords(reviewRecordsForSession(workspace));
  }, [aiSession, workspace.review_results, workspace.draft_history, workspace.drafts]);

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
      aiSession.importRecords(reviewRecordsForSession(state));
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
    aiSession.importRecords(reviewRecordsForSession(result.state));
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
    aiSession.setPersistedResultHandler((record) => {
      if (record.isTestData || record.capability !== 'review' || record.state !== 'success' || record.result?.output_kind !== 'review') return;
      const state = repository.load();
      const review = reviewEntityFromRecord(record, state, clientId);
      if (!review) return;
      try {
        queueReviewResult(state, review);
        repository.save(state);
        setWorkspace(state);
        setSyncState(navigator.onLine ? 'syncing' : 'local_only');
        if (navigator.onLine) void flushQueue();
      } catch (error) {
        // The session still keeps the local result visible; source/version
        // validation prevents an invalid entity from entering sync storage.
        console.warn(`[AlgoFlow] review sync bridge rejected result: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    });
    return () => aiSession.setPersistedResultHandler(() => {});
  }, [aiSession, clientId, flushQueue, repository]);

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
    next.operations = next.operations.map(operation => operation.entity_id === updated.id && inFlightOperations.current.has(operation.operation_id)
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

  async function requestArtifact() {
    if (!currentDraft || artifactBusy || mode !== 'faithful_transform' || activeFile !== 'main.cpp') return;
    if (currentDraft.sync_status !== 'synced' || !saved) {
      setArtifactMessage('请先保存并同步当前草稿，再请求忠实转换。');
      return;
    }
    setArtifactBusy(true); setArtifactMessage('正在请求 AI Gateway…');
    const source = currentDraft;
    try {
      const request = buildAIRequest(source, documents, mode);
      const response = await aiClient.requestTransform(request, {});
      if (response.isTestData) {
        setArtifactMessage('测试数据仅供本地调试，不进入跨端同步。');
        return;
      }
      const latest = repository.load().drafts.find((draft) => draft.id === source.id);
      if (!latest || latest.version !== source.version || latest.sync_status !== 'synced') throw new Error('DRAFT_CHANGED_RETRY_AI');
      const artifact = artifactFromGateway(response.result, source, clientId, request.idea_segments.map((segment) => segment.id), request.rule_version);
      assertAIArtifact(artifact, new Set(request.idea_segments.map((segment) => segment.id)));
      const state = repository.load();
      queueAIArtifact(state, artifact);
      repository.save(state);
      setWorkspace(state); setArtifactMessage('忠实转换结果已保存，可同步到手机端。');
      if (navigator.onLine) void flushQueue();
    } catch (error) {
      setArtifactMessage(error instanceof Error ? error.message : 'AI 请求失败');
    } finally { setArtifactBusy(false); }
  }

  function toggleArtifact(artifact: AIArtifact) {
    const state = repository.load();
    const updated: AIArtifact = { ...artifact, visibility: artifact.visibility === 'hidden' ? 'visible' : 'hidden', updated_at: new Date().toISOString(), last_modified_client_id: clientId };
    queueAIArtifact(state, updated); repository.save(state); setWorkspace(state);
    if (navigator.onLine) void flushQueue();
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
          artifact={currentArtifact}
          artifactHistory={artifactHistory}
          artifactBusy={artifactBusy}
          artifactMessage={artifactMessage}
          onArtifact={requestArtifact}
          onToggleArtifact={toggleArtifact}
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
  const sourceMatches = documents['main.cpp'] === draft.code && documents['idea.md'] === draft.idea &&
    documents['cases.txt'] === (draft.cases ?? '') && mode === draft.ai_mode;
  return { draftId: draft.id, draftVersion: draft.version, fileId, mode,
    code: documents['main.cpp'], idea: documents['idea.md'], idea_segments: draft.idea_segments ?? [], problemContext: draft.title || '当前草稿',
    syncStatus: sourceMatches ? draft.sync_status : 'local_only' };
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
  return copy && 'title' in record.server_entity ? { copy, server: record.server_entity } : null;
}

function reviewRecordsForSession(state: WorkspaceState): AIResultRecord[] {
  return (state.review_results ?? []).filter((review) => !review.deleted).map((review) => {
    const draft = state.drafts.find((item) => item.id === review.draft_id);
    const snapshot = (state.draft_history ?? []).find((item) => item.draft_id === review.draft_id && item.version === review.source_draft_version);
    const sourceCode = snapshot?.code ?? (draft?.version === review.source_draft_version ? draft.code : '');
    const sourceSegments = snapshot?.idea_segments ?? draft?.idea_segments ?? [];
    return {
      id: review.id, draftId: review.draft_id, capability: 'review', mode: review.mode, reviewKind: review.review_kind,
      state: 'success', result: {
        mode: review.mode, draft_id: review.draft_id, source_draft_version: review.source_draft_version,
        model_id: review.model_id, rule_version: review.rule_version, review_kind: review.review_kind,
        output_kind: 'review', diagnostics: review.diagnostics, visibility: review.visibility,
      }, isTestData: false, hidden: review.visibility === 'hidden', stale: review.freshness === 'stale', restored: true,
      requestGeneration: 0, sourceDraftVersion: review.source_draft_version, sourceFile: 'main.cpp', sourceCode,
      sourceIdea: draft?.idea ?? '', sourceProblemContext: draft?.title || '当前草稿',
      sourceSegments: sourceSegments.map((segment) => ({ ...segment })), sourceCursor: null, updatedAt: review.updated_at,
      createdAt: review.created_at, serverVersion: review.version, serverSequence: review.server_sequence,
    } satisfies AIResultRecord;
  });
}

function reviewEntityFromRecord(record: AIResultRecord, state: WorkspaceState, clientId: string): ReviewResult | null {
  if (record.result?.output_kind !== 'review') return null;
  const draft = state.drafts.find((item) => item.id === record.draftId && !item.deleted);
  if (!draft || draft.version !== record.sourceDraftVersion || draft.sync_status !== 'synced') return null;
  const now = record.updatedAt || new Date().toISOString();
  return {
    id: record.id, version: 0, server_sequence: 0, created_at: now, updated_at: now, deleted: false,
    last_modified_client_id: clientId, draft_id: record.draftId, mode: record.result.mode,
    source_draft_version: record.result.source_draft_version, model_id: record.result.model_id,
    rule_version: record.result.rule_version, review_kind: record.result.review_kind,
    diagnostics: record.result.diagnostics, visibility: record.result.visibility, freshness: 'current',
  };
}
