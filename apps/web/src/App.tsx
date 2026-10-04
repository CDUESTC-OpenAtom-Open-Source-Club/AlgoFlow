import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityBar } from './components/ActivityBar';
import { EditorStage } from './components/EditorStage';
import { InspectorPanel } from './components/InspectorPanel';
import { TopBar } from './components/TopBar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { initialDocuments } from './data';
import { BrowserWorkspaceRepository, createLocalReviewResult, queueAIArtifact, queueReviewResult, queueUpsert } from './storage.mjs';
import { LocalSyncClient, synchronizeWorkspace } from './sync-client.mjs';
import type { AIArtifact, ConflictRecord, Documents, Draft, FileId, Mode, Panel, ReviewKind, ReviewResult, SyncStatus, WorkspaceState } from './types';
import { reviewCpp } from './code-review';
import { LocalAIClient, artifactFromGateway, buildAIRequest, reconcileIdeaSegments } from './ai-client.mjs';

interface ConflictChoice {
  entity_type: 'draft' | 'ai_artifact' | 'review_result';
  copy: Draft | AIArtifact | ReviewResult;
  server: Draft | AIArtifact | ReviewResult;
}

const syncClient = new LocalSyncClient();
const aiClient = new LocalAIClient();

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
  const [aiMessage, setAIMessage] = useState('');
  const [aiGenerating, setAIGenerating] = useState(false);
  const [reviewKind, setReviewKind] = useState<ReviewKind>('risk');
  const editorRevisionRef = useRef(0);
  const currentArtifact = useMemo(() => currentDraft ? latestArtifact(workspace.ai_artifacts, currentDraft.id, mode) : undefined,
    [workspace.ai_artifacts, currentDraft, mode]);
  const currentReview = useMemo(() => currentDraft ? latestReview(workspace.review_results, currentDraft.id, mode, reviewKind) : undefined,
    [workspace.review_results, currentDraft, mode, reviewKind]);
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
    editorRevisionRef.current += 1;
    setSaved(false);
  }

  function saveWorkspace(): Promise<void> {
    const base = repository.load();
    const draft = currentDraft;
    if (!draft) return Promise.resolve();
    const updated: Draft = {
      ...draft,
      code: documents['main.cpp'],
      idea: documents['idea.md'],
      idea_segments: reconcileIdeaSegments(draft.idea_segments ?? [], documents['idea.md']),
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
    return navigator.onLine ? flushQueue() : Promise.resolve();
  }

  function syncNow() {
    if (!saved) {
      saveWorkspace();
      return;
    }
    void flushQueue();
  }

  function toggleArtifactVisibility() {
    if (!currentArtifact) return;
    const state = repository.load();
    const updated: AIArtifact = {
      ...currentArtifact,
      visibility: currentArtifact.visibility === 'hidden' ? 'visible' : 'hidden',
      updated_at: new Date().toISOString(),
      last_modified_client_id: clientId,
    };
    queueAIArtifact(state, updated);
    repository.save(state);
    setWorkspace(state);
    if (navigator.onLine) void flushQueue();
  }

  function toggleReviewVisibility() {
    if (!currentReview) return;
    const state = repository.load();
    queueReviewResult(state, { ...currentReview, visibility: currentReview.visibility === 'hidden' ? 'visible' : 'hidden', updated_at: new Date().toISOString(), last_modified_client_id: clientId });
    repository.save(state);
    setWorkspace(state);
    setSyncState(navigator.onLine ? 'syncing' : 'local_only');
    if (navigator.onLine) void flushQueue();
  }

  async function saveLocalReview() {
    if (!currentDraft) return;
    const draftNeedsSave = !saved || currentDraft.code !== documents['main.cpp'] || currentDraft.idea !== documents['idea.md'] ||
      (currentDraft.cases ?? '') !== documents['cases.txt'] || currentDraft.ai_mode !== mode;
    if (draftNeedsSave) await saveWorkspace();
    const state = repository.load();
    const sourceDraft = state.drafts.find((draft) => draft.id === currentDraft.id);
    if (!sourceDraft || sourceDraft.code !== documents['main.cpp'] || sourceDraft.idea !== documents['idea.md'] ||
      (sourceDraft.cases ?? '') !== documents['cases.txt'] || sourceDraft.ai_mode !== mode) {
      setAIMessage('草稿保存存在冲突，请先处理冲突后再保存审查结果。');
      return;
    }
    const result = createLocalReviewResult(sourceDraft, clientId, mode, reviewKind, reviewCpp(documents['main.cpp']).map((issue, index) => ({
        id: `local-${index + 1}`, level: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
        range: { start_line: issue.line, start_char: 0, end_line: issue.line, end_char: 1 }, problem: issue.message,
        basis: '本地规则检查命中对应代码行。', suggestion: '请结合当前思路确认是否需要调整。'
      })));
    queueReviewResult(state, result);
    repository.save(state);
    setWorkspace(state);
    setSyncState(navigator.onLine ? 'syncing' : 'local_only');
    setAIMessage('审查结果已独立保存。');
    if (navigator.onLine) void flushQueue();
  }

  async function generateArtifact() {
    if (!currentDraft || mode !== 'faithful_transform' || aiGenerating) return;
    if (!documents['idea.md'].trim()) {
      setAIMessage('请先输入思路内容。');
      return;
    }
    setAIGenerating(true);
    setAIMessage('正在请求 AI Gateway...');
    const generationRevision = editorRevisionRef.current;
    try {
      if (!saved || (currentDraft.idea_segments ?? []).length === 0) await saveWorkspace();
      const state = repository.load();
      const draft = state.drafts.find((item) => item.id === currentDraft.id) ?? currentDraft;
      const request = buildAIRequest(draft, documents, mode);
      const response = await aiClient.generate(request);
      const latestState = repository.load();
      const latestDraft = latestState.drafts.find((item) => item.id === draft.id);
      if (!latestDraft || latestDraft.version !== draft.version || latestState.selected_id !== draft.id || editorRevisionRef.current !== generationRevision) {
        throw new Error('DRAFT_CHANGED_RETRY_AI');
      }
      const artifact = artifactFromGateway(response, draft, clientId, request.idea_segments.map((segment) => segment.id), request.rule_version);
      queueAIArtifact(latestState, artifact);
      repository.save(latestState);
      setWorkspace(latestState);
      setAIMessage('忠实转换结果已保存，可同步到手机端。');
      if (navigator.onLine) void flushQueue();
    } catch (error) {
      setAIMessage(error instanceof Error ? error.message : 'AI 请求失败');
    } finally {
      setAIGenerating(false);
    }
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
    if (conflict.entity_type === 'ai_artifact') {
      const copy: AIArtifact = { ...(conflict.copy as AIArtifact), last_modified_client_id: clientId, visibility: 'visible' };
      const next = { ...state, ai_artifacts: state.ai_artifacts.map((item) => item.id === copy.id ? copy : item), conflicts: state.conflicts.map((record) => record.local_copy_id === copy.id ? { ...record, resolved: true } : record) };
      queueAIArtifact(next, copy);
      repository.save(next);
      setWorkspace(next);
      setConflict(null);
      setSyncState(navigator.onLine ? 'syncing' : 'local_only');
      if (navigator.onLine) void flushQueue();
      return;
    }
    if (conflict.entity_type === 'review_result') {
      const copy: ReviewResult = { ...(conflict.copy as ReviewResult), last_modified_client_id: clientId, visibility: 'visible' };
      const next = { ...state, review_results: state.review_results.map((item) => item.id === copy.id ? copy : item), conflicts: state.conflicts.map((record) => record.local_copy_id === copy.id ? { ...record, resolved: true } : record) };
      queueReviewResult(next, copy);
      repository.save(next);
      setWorkspace(next);
      setConflict(null);
      setSyncState(navigator.onLine ? 'syncing' : 'local_only');
      if (navigator.onLine) void flushQueue();
      return;
    }
    const copy: Draft = {
      ...(conflict.copy as Draft),
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
    if (conflict.entity_type === 'ai_artifact') {
      const server = conflict.server as AIArtifact;
      const next = { ...state, ai_artifacts: state.ai_artifacts.filter((artifact) => artifact.id !== conflict.copy.id).map((artifact) => artifact.id === server.id ? server : artifact), conflicts: state.conflicts.map((record) => record.local_copy_id === conflict.copy.id ? { ...record, resolved: true } : record) };
      repository.save(next);
      setWorkspace(next);
      setConflict(null);
      setSyncState('synced');
      return;
    }
    if (conflict.entity_type === 'review_result') {
      const server = conflict.server as ReviewResult;
      const next = {
        ...state,
        review_results: state.review_results.filter((result) => result.id !== conflict.copy.id).map((result) => result.id === server.id ? server : result),
        conflicts: state.conflicts.map((record) => record.local_copy_id === conflict.copy.id ? { ...record, resolved: true } : record),
      };
      repository.save(next);
      setWorkspace(next);
      setConflict(null);
      setSyncState('synced');
      return;
    }
    let next = replaceDraft(
      { ...state, selected_id: conflict.server.id, drafts: state.drafts.filter((draft) => draft.id !== conflict.copy.id) },
      { ...(conflict.server as Draft), sync_status: 'synced' },
    );
    next.conflicts = state.conflicts.map((record) => record.local_copy_id === conflict.copy.id ? { ...record, resolved: true } : record);
    repository.save(next);
    setWorkspace(next);
    setDocuments(draftToDocuments(conflict.server as Draft));
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
            <span>{conflict.entity_type === 'ai_artifact' ? '服务器 AI 结果和本地副本都已保留，请选择继续方式。' : conflict.entity_type === 'review_result' ? '服务器审查结果和本地副本都已保留，请选择继续方式。' : '服务器版本和本地编辑都已保留，请选择继续方式。'}</span>
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
          aiMessage={aiMessage}
          aiGenerating={aiGenerating}
          onGenerateArtifact={generateArtifact}
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
          artifact={currentArtifact}
          onToggleArtifact={toggleArtifactVisibility}
          review={currentReview}
          reviewKind={reviewKind}
          onReviewKindChange={setReviewKind}
          onSaveReview={saveLocalReview}
          onToggleReview={toggleReviewVisibility}
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
  if (record.entity_type === 'ai_artifact') {
    const copy = state.ai_artifacts.find((artifact) => artifact.id === record.local_copy_id);
    return copy ? { entity_type: 'ai_artifact', copy, server: record.server_entity as AIArtifact } : null;
  }
  if (record.entity_type === 'review_result') {
    const copy = state.review_results.find((review) => review.id === record.local_copy_id);
    return copy ? { entity_type: 'review_result', copy, server: record.server_entity as ReviewResult } : null;
  }
  const copy = state.drafts.find((draft) => draft.id === record.local_copy_id);
  return copy ? { entity_type: 'draft', copy, server: record.server_entity as Draft } : null;
}

function latestArtifact(artifacts: AIArtifact[], draftId: string, mode: Mode): AIArtifact | undefined {
  return artifacts.filter((artifact) => artifact.draft_id === draftId && artifact.mode === mode && !artifact.deleted)
    .sort((left, right) => right.server_sequence - left.server_sequence || right.version - left.version || right.updated_at.localeCompare(left.updated_at))[0];
}

function latestReview(results: ReviewResult[], draftId: string, mode: Mode, kind: ReviewResult['review_kind']): ReviewResult | undefined {
  return results.filter((result) => result.draft_id === draftId && result.mode === mode && result.review_kind === kind && !result.deleted)
    .sort((left, right) => right.server_sequence - left.server_sequence || right.version - left.version || right.updated_at.localeCompare(left.updated_at))[0];
}
