import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { AIClientError, WebAIClient, createIdeaSegments, rangeToOffsets, toCursor } from './ai-client.mjs';
import { BrowserAIResultRepository } from './ai-result-storage.mjs';
import type { AICompletionResult, AIRequestState, AIResultRecord, AIReviewDiagnostic, ReviewKind } from './types';

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
  const [applyChange, setApplyChange] = useState<{ from: number; to: number; insert: string; token: number } | null>(null);
  const [aiRecords, setAiRecords] = useState<AIResultRecord[]>([]);
  const aiRepository = useMemo(() => new BrowserAIResultRepository(), []);
  const requestGeneration = useRef(0);
  const requestControllers = useRef(new Map<string, AbortController>());
  const lastDocuments = useRef(documents);
  const handleCursorChange = useCallback((line: number, column: number) => {
    setCursorPosition({ line, column });
  }, []);

  useEffect(() => {
    const draftId = currentDraft?.id ?? '';
    if (lastDocuments.current['main.cpp'] !== documents['main.cpp'] || lastDocuments.current['idea.md'] !== documents['idea.md']) {
      const current = aiRepository.invalidateSource(draftId, documents['main.cpp'], documents['idea.md']);
      setAiRecords(current);
    } else {
      setAiRecords(aiRepository.listForDraft(draftId));
    }
    lastDocuments.current = documents;
  }, [aiRepository, currentDraft?.id, documents]);

  const invalidateAI = useCallback(() => {
    requestGeneration.current += 1;
    for (const controller of requestControllers.current.values()) controller.abort();
    requestControllers.current.clear();
    setAiRecords((records) => records.map((record) => ({ ...record, stale: true, state: record.state === 'loading' ? 'stale' : record.state })));
  }, [aiRepository, currentDraft?.id]);

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
    invalidateAI();
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
    invalidateAI();
  }

  function makeBaseRequest(outputKind: 'review' | 'completion', extra: Record<string, unknown> = {}) {
    const draft = currentDraft;
    if (!draft) throw new Error('没有选中的草稿');
    return {
      problem_context: documents['idea.md'] || draft.title,
      mode: 'faithful_transform', draft_id: draft.id, draft_version: draft.version,
      language: 'cpp', rule_version: '1.0.0', idea_segments: createIdeaSegments(documents['idea.md']),
      output_kind: outputKind, visibility: 'visible', code: documents['main.cpp'], ...extra
    };
  }

  async function requestReview(kind: ReviewKind) {
    const draft = currentDraft; if (!draft) return;
    const generation = ++requestGeneration.current;
    requestControllers.current.get(`review:${kind}`)?.abort();
    const controller = new AbortController(); requestControllers.current.set(`review:${kind}`, controller);
    const recordBase = { id: crypto.randomUUID(), draftId: draft.id, capability: 'review' as const, reviewKind: kind, state: 'loading' as AIRequestState, result: null, isTestData: false, hidden: false, stale: false, requestGeneration: generation, sourceDraftVersion: draft.version, sourceFile: activeFile, sourceCode: documents['main.cpp'], sourceIdea: documents['idea.md'], updatedAt: new Date().toISOString() };
    setAiRecords((records) => [...records.filter((item) => !(item.draftId === draft.id && item.capability === 'review' && item.reviewKind === kind)), recordBase]);
    try {
      const response = await aiClient.requestReview(makeBaseRequest('review', { review_kind: kind }), { signal: controller.signal });
      if (generation !== requestGeneration.current || controller.signal.aborted) return;
      const record = { ...recordBase, state: 'success' as AIRequestState, result: response.result, isTestData: response.isTestData, updatedAt: new Date().toISOString() };
      aiRepository.save(record); setAiRecords((records) => [...records.filter((item) => item.id !== recordBase.id && !(item.draftId === draft.id && item.capability === 'review' && item.reviewKind === kind)), record]);
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof AIClientError ? error.code : 'AI_PROVIDER_ERROR';
      const record = { ...recordBase, state: code === 'AI_NOT_ENABLED' ? 'unavailable' as AIRequestState : 'error' as AIRequestState, errorCode: code, errorMessage: error instanceof Error ? error.message : '请求失败', updatedAt: new Date().toISOString() };
      aiRepository.save(record); setAiRecords((records) => [...records.filter((item) => item.id !== recordBase.id), record]);
    }
  }

  async function requestCompletion() {
    const draft = currentDraft; if (!draft || activeFile !== 'main.cpp') return;
    const generation = ++requestGeneration.current;
    requestControllers.current.get('completion')?.abort();
    const controller = new AbortController(); requestControllers.current.set('completion', controller);
    try {
      const response = await aiClient.requestCompletion(makeBaseRequest('completion', { cursor: toCursor(cursorPosition.line, cursorPosition.column) }), { signal: controller.signal });
      if (generation !== requestGeneration.current || controller.signal.aborted) return;
      const record: AIResultRecord = { id: crypto.randomUUID(), draftId: draft.id, capability: 'completion', state: 'success', result: response.result, isTestData: response.isTestData, hidden: false, stale: false, requestGeneration: generation, sourceDraftVersion: draft.version, sourceFile: activeFile, sourceCode: documents['main.cpp'], sourceIdea: documents['idea.md'], updatedAt: new Date().toISOString() };
      aiRepository.save(record); setAiRecords((records) => [...records.filter((item) => item.capability !== 'completion' || item.draftId !== draft.id), record]);
    } catch (error) {
      if (controller.signal.aborted) return;
      const record: AIResultRecord = { id: crypto.randomUUID(), draftId: draft.id, capability: 'completion', state: error instanceof AIClientError && error.code === 'AI_NOT_ENABLED' ? 'unavailable' : 'error', result: null, errorCode: error instanceof AIClientError ? error.code : 'AI_PROVIDER_ERROR', errorMessage: error instanceof Error ? error.message : '请求失败', isTestData: false, hidden: false, stale: false, requestGeneration: generation, sourceDraftVersion: draft.version, sourceFile: activeFile, sourceCode: documents['main.cpp'], sourceIdea: documents['idea.md'], updatedAt: new Date().toISOString() };
      aiRepository.save(record); setAiRecords((records) => [...records.filter((item) => item.capability !== 'completion' || item.draftId !== draft.id), record]);
    }
  }

  function hideReview(kind: ReviewKind) {
    const record = aiRecords.find((item) => item.capability === 'review' && item.reviewKind === kind);
    if (record) aiRepository.setHidden(record);
    setAiRecords((records) => records.map((item) => item.capability === 'review' && item.reviewKind === kind ? { ...item, hidden: true, state: 'hidden' } : item));
  }

  function acceptCompletion() {
    const record = aiRecords.find((item) => item.capability === 'completion');
    const result = record?.result as AICompletionResult | null;
    if (!record || !result || record.stale || record.sourceCode !== documents['main.cpp'] || record.sourceDraftVersion !== currentDraft?.version || activeFile !== 'main.cpp') return;
    const offsets = rangeToOffsets(documents['main.cpp'], result.replaced_range);
    setApplyChange({ ...offsets, insert: result.suggestion_text, token: Date.now() });
    const hidden = { ...record, state: 'hidden' as AIRequestState, hidden: true };
    aiRepository.setHidden(hidden);
    setAiRecords((records) => records.map((item) => item.id === record.id ? hidden : item));
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
          applyChange={applyChange}
        />
        <InspectorPanel
          hidden={inspectorHidden}
          issues={reviewIssues}
          onJumpToLine={setJumpToLine}
          onHide={() => setInspectorHidden(true)}
          onShow={() => setInspectorHidden(false)}
          reviewState={Object.fromEntries((['explanation', 'risk', 'complexity'] as ReviewKind[]).map((kind) => [kind, aiRecords.find((item) => item.capability === 'review' && item.reviewKind === kind)?.state ?? 'idle'])) as Record<ReviewKind, AIRequestState>}
          reviewMessages={aiRecords.filter((item) => item.capability === 'review' && !item.hidden && item.result).map((item) => ({ kind: item.reviewKind!, diagnostics: (item.result as { diagnostics: AIReviewDiagnostic[] }).diagnostics, isTestData: item.isTestData, stale: item.stale }))}
          completion={(() => { const item = aiRecords.find((record) => record.capability === 'completion' && !record.hidden && record.result); return item ? { result: item.result as AICompletionResult, isTestData: item.isTestData, stale: item.stale } : null; })()}
          completionState={aiRecords.find((item) => item.capability === 'completion')?.state ?? 'idle'}
          onReview={requestReview}
          onCompletion={requestCompletion}
          onAcceptCompletion={acceptCompletion}
          onHideAI={hideReview}
          errorMessages={aiRecords.filter((item) => (item.state === 'error' || item.state === 'unavailable') && item.errorMessage).map((item) => item.errorMessage ?? '请求失败')}
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
