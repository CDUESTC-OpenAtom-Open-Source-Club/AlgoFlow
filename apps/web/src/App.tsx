import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityBar } from './components/ActivityBar';
import { EditorStage } from './components/EditorStage';
import { InspectorPanel } from './components/InspectorPanel';
import { RewriteComparePanel } from './components/RewriteComparePanel';
import { PhoneConnectionModal, type PhoneConnectionConfig } from './components/PhoneConnectionModal';
import { TopBar } from './components/TopBar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { initialDocuments } from './data';
import { BrowserWorkspaceRepository, clearDeviceToken, getAIArtifactFreshness, loadDeviceToken, markSyncedDraftsLocal, queueAIArtifact, queueReviewResult, queueUpsert, saveDeviceToken, selectCurrentAIArtifact, sortAIArtifactsNewestFirst } from './storage.mjs';
import { LocalSyncClient, synchronizeWorkspace, syncNoticeFor } from './sync-client.mjs';
import { describeBrowser } from './pairing-client.mjs';
import { AI_ENTRY, HOSTED, ICP_RECORD, PRIVACY_URL } from './site-config.mjs';
import type { AIArtifact, AIResultRecord, ConflictRecord, Documents, Draft, FileId, Mode, Panel, ReviewResult, SyncNotice, SyncStatus, TransformOutputKind, WorkspaceState } from './types';
import { reviewCpp } from './code-review';
import { artifactFromGateway, buildAIRequest, transformErrorMessage, WebAIClient, toCursor } from './ai-client.mjs';
import { assertAIArtifact } from './sync-client.mjs';
import { BrowserAIResultRepository } from './ai-result-storage.mjs';
import { AISession } from './ai-session.mjs';
import { assignRewriteLines, resolveRewriteMapping } from './rewrite-compare.mjs';
import { BrowserRewriteMappingRepository } from './rewrite-mapping-storage.mjs';
import type { AIContext, ApplyAIEditorChange } from './types';

interface ConflictChoice {
  copy: Draft;
  server: Draft;
}

const syncClient = new LocalSyncClient();
const aiClient = new WebAIClient();
const rewriteMappings = new BrowserRewriteMappingRepository();
let pendingWorkspace: Promise<string> | null = null;

// Storage is read first because another tab may already have created or
// switched the token.
function storedDeviceToken(): string {
  const stored = loadDeviceToken(syncClient.apiBase);
  if (stored) syncClient.token = stored;
  return stored;
}

// The local build creates a workspace on first sync; acceptance-server and LAN
// testing rely on it. The hosted build calls this only after the user agrees on
// the 手机远程 card, so nothing is uploaded before that.
function ensureDeviceToken(): Promise<string> {
  const apiBase = syncClient.apiBase;
  const stored = storedDeviceToken();
  if (stored) return Promise.resolve(stored);
  pendingWorkspace ??= syncClient.createWorkspace({ device_name: describeBrowser(navigator.userAgent) }).then((created) => {
    saveDeviceToken(apiBase, created.device_token);
    if (syncClient.apiBase === apiBase) syncClient.token = created.device_token;
    return created.device_token;
  }).finally(() => { pendingWorkspace = null; });
  return pendingWorkspace;
}

/** Returns false when another tab has already replaced the rejected token. */
function forgetDeviceToken(rejected: string): boolean {
  if (syncClient.token === rejected) syncClient.token = '';
  if (loadDeviceToken(syncClient.apiBase) !== rejected) return false;
  clearDeviceToken(syncClient.apiBase);
  return true;
}

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
  const [saved, setSaved] = useState(true);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [syncState, setSyncState] = useState<SyncStatus>(
    workspace.conflicts.some((item) => !item.resolved) ? 'conflict' : currentDraft?.sync_status ?? 'local_only',
  );
  const [conflict, setConflict] = useState<ConflictChoice | null>(() => unresolvedConflict(workspace));
  const [jumpToLine, setJumpToLine] = useState(0);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [artifactBusy, setArtifactBusy] = useState(false);
  const [artifactMessage, setArtifactMessage] = useState('');
  const [transformOutput, setTransformOutput] = useState<TransformOutputKind>('pseudocode');
  const [compareOpen, setCompareOpen] = useState(false);
  const [rewriteSelection, setRewriteSelection] = useState({ start: 1, end: 1 });
  const [revealedArtifactId, setRevealedArtifactId] = useState('');
  const [mappingRevision, setMappingRevision] = useState(0);
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null);
  // Hosted: 手机远程 counts as on while this browser holds a token.
  const [phoneConfig, setPhoneConfig] = useState<PhoneConnectionConfig>(() => ({
    enabled: HOSTED ? loadDeviceToken(syncClient.apiBase) !== '' : true,
    route: HOSTED ? 'relay' : 'lan',
    computerName: HOSTED ? describeBrowser(navigator.userAgent) : 'AlgoFlow-Desktop',
    syncBaseUrl: syncClient.apiBase,
    aiBaseUrl: aiClient.baseUrl,
  }));
  const [aiSession] = useState(() => new AISession(aiClient, new BrowserAIResultRepository()));
  const aiState = useSyncExternalStore(aiSession.subscribe, aiSession.getSnapshot, aiSession.getSnapshot);
  const artifactHistory = useMemo(() => currentDraft
    ? sortAIArtifactsNewestFirst((workspace.ai_artifacts ?? []).filter((artifact) => artifact.draft_id === currentDraft.id && artifact.mode === mode && !artifact.deleted))
    : [], [workspace.ai_artifacts, currentDraft, mode]);
  const currentArtifact = useMemo(() => currentDraft ? selectCurrentAIArtifact(workspace, currentDraft.id, mode) ?? null : null,
    [workspace, currentDraft, mode]);
  // Pseudocode never enters the IDE, so only code_snippet results are compared.
  const compareArtifact = useMemo(() => artifactHistory.find((artifact) => artifact.output_kind === 'code_snippet') ?? null, [artifactHistory]);
  const mappingRecord = useMemo(() => currentDraft ? rewriteMappings.load(currentDraft.id) : null,
    // mappingRevision forces a reload after a local partition write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentDraft?.id, mappingRevision]);
  const rewriteMapping = useMemo(() => resolveRewriteMapping(mappingRecord, compareArtifact?.id ?? '', documents['rewrite.cpp']),
    [mappingRecord, compareArtifact, documents]);
  const artifactAbort = useRef<AbortController | null>(null);
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
  const handleSelectionLines = useCallback((start: number, end: number) => {
    setRewriteSelection(previous => previous.start === start && previous.end === end ? previous : { start, end });
  }, []);

  useLayoutEffect(() => {
    if (currentDraft) aiSession.setContext(makeAIContext(currentDraft, documents, activeFile, mode));
  }, [aiSession, currentDraft, documents, activeFile, mode]);

  useEffect(() => {
    aiSession.importRecords(reviewRecordsForSession(workspace));
  }, [aiSession, workspace.review_results, workspace.draft_history, workspace.drafts]);

  useEffect(() => () => aiSession.dispose(), [aiSession]);

  useEffect(() => {
    for (const draft of workspace.drafts) if (draft.deleted) { aiSession.removeDraft(draft.id); rewriteMappings.removeDraft(draft.id); }
  }, [aiSession, workspace.drafts]);

  // The server no longer accepts the token: a removed device, deleted cloud
  // data or a restarted in-memory sync-api. Local drafts and the queue stay.
  // The local build gets a new token on the next sync; the hosted build waits
  // until the user turns 手机远程 on again.
  const rejectToken = useCallback((token: string) => {
    if (!forgetDeviceToken(token)) return;
    setSyncNotice(syncNoticeFor({ auth_required: true }, HOSTED));
    if (HOSTED) setPhoneConfig(config => ({ ...config, enabled: false }));
  }, []);

  const flushQueue = useCallback(async () => {
    if (syncRunning.current) { syncAgain.current = true; return; }
    syncRunning.current = true;
    let renewedToken = false;
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
    let token = HOSTED ? storedDeviceToken() : '';
    if (HOSTED && !token) {
      setSyncState('local_only');
      setWorkspace(state);
      aiSession.importRecords(reviewRecordsForSession(state));
      return;
    }
    setSyncState('syncing');
    try {
      token ||= await ensureDeviceToken();
    } catch {
      setSyncState('failed');
      setWorkspace(state);
      aiSession.importRecords(reviewRecordsForSession(state));
      return;
    }
    inFlightOperations.current = new Set(state.operations.map(operation => operation.operation_id));
    const result = await synchronizeWorkspace(state, syncClient);
    if (result.auth_required) {
      // Nothing was applied and the queue is intact, so the local build retries
      // once with a replacement token; the hosted build ends as local_only.
      rejectToken(token);
      if (!renewedToken) {
        renewedToken = true;
        syncAgain.current = true;
        continue;
      }
    }
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
    // A full workspace or rate limit needs the user; a later clean run clears it.
    const notice = syncNoticeFor(result, HOSTED);
    setSyncNotice(previous => notice ?? (previous?.kind === 'auth' ? previous : null));
    const pendingConflict = unresolvedConflict(result.state);
    if (pendingConflict) setConflict(pendingConflict);
    // A new epoch (workspace transfer or server restart) re-queued the drafts the
    // server does not have. Upload them now instead of at the next edit.
    if (result.state.server_epoch !== state.server_epoch && result.state.operations.length > 0) syncAgain.current = true;
    } while (syncAgain.current);
    } finally {
      inFlightOperations.current.clear();
      syncRunning.current = false;
    }
  }, [aiSession, rejectToken, repository]);

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
        setSyncState(willSync() ? 'syncing' : 'local_only');
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
      rewrite: documents['rewrite.cpp'],
      ai_mode: mode,
      updated_at: new Date().toISOString(),
      last_modified_client_id: clientId,
      sync_status: willSync() ? 'syncing' : 'local_only',
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
    setSyncState(willSync() ? 'syncing' : 'local_only');
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
    const controller = new AbortController();
    artifactAbort.current = controller;
    try {
      const request = buildAIRequest(source, documents, mode, transformOutput);
      const response = await aiClient.requestTransform(request, { signal: controller.signal });
      if (response.isTestData) {
        setArtifactMessage('测试数据仅供本地调试，不进入跨端同步。');
        return;
      }
      const latest = repository.load().drafts.find((draft) => draft.id === source.id);
      if (!latest || latest.version !== source.version || latest.sync_status !== 'synced') throw new Error('DRAFT_CHANGED_RETRY_AI');
      const artifact = artifactFromGateway(response.result, source, clientId, request.idea_segments.map((segment) => segment.id), request.rule_version, request.output_kind);
      assertAIArtifact(artifact, new Set(request.idea_segments.map((segment) => segment.id)));
      const state = repository.load();
      queueAIArtifact(state, artifact);
      repository.save(state);
      setWorkspace(state); setArtifactMessage('忠实转换结果已保存，可同步到手机端。');
      if (navigator.onLine) void flushQueue();
    } catch (error) {
      setArtifactMessage(transformErrorMessage(error));
    } finally {
      if (artifactAbort.current === controller) artifactAbort.current = null;
      setArtifactBusy(false);
    }
  }

  function cancelArtifact() {
    artifactAbort.current?.abort();
  }

  function toggleArtifact(artifact: AIArtifact) {
    const state = repository.load();
    const updated: AIArtifact = { ...artifact, visibility: artifact.visibility === 'hidden' ? 'visible' : 'hidden', updated_at: new Date().toISOString(), last_modified_client_id: clientId };
    queueAIArtifact(state, updated); repository.save(state); setWorkspace(state);
    if (navigator.onLine) void flushQueue();
  }

  function saveRewriteMapping(mappings: ReturnType<typeof assignRewriteLines>) {
    if (!currentDraft || !compareArtifact) return;
    try { rewriteMappings.save(currentDraft.id, compareArtifact.id, documents['rewrite.cpp'], mappings); }
    catch { setArtifactMessage('复写划分保存失败，请检查浏览器存储空间。'); }
    setMappingRevision(revision => revision + 1);
  }

  function assignRewriteSelection(stepId: string | null) {
    if (rewriteMapping.status === 'outdated') return;
    saveRewriteMapping(assignRewriteLines(rewriteMapping.mappings, rewriteSelection.start, rewriteSelection.end, stepId));
  }

  function clearRewriteMapping() {
    if (currentDraft) rewriteMappings.removeDraft(currentDraft.id);
    setMappingRevision(revision => revision + 1);
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
      sync_status: willSync() ? 'syncing' : 'local_only',
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
    setSyncState(willSync() ? 'syncing' : 'local_only');
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

  // The phone already had another workspace: this browser joins it. The old
  // device is deleted afterwards; the next sync sees a new epoch and rebases
  // local drafts onto the phone's workspace.
  const handlePairingTransfer = useCallback(async (token: string) => {
    const previous = new LocalSyncClient(syncClient.apiBase, syncClient.token);
    saveDeviceToken(syncClient.apiBase, token);
    syncClient.token = token;
    setSyncNotice(null);
    if (previous.token && previous.token !== token) {
      try { await previous.revokeCurrentDevice(); } catch { /* stays listed until removed from another device */ }
    }
    void flushQueue();
  }, [flushQueue]);

  // The first workspace of this browser: upload the queue now so the phone sees
  // the drafts right after it scans the code.
  const ensurePairingToken = useCallback(async () => {
    const hadToken = loadDeviceToken(syncClient.apiBase) !== '';
    const token = await ensureDeviceToken();
    if (!hadToken) {
      setSyncNotice(null);
      void flushQueue();
    }
    return token;
  }, [flushQueue]);

  // Device actions treat a rejected token like a sync run does.
  const withDeviceToken = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    const token = storedDeviceToken();
    if (!token) throw new Error('AUTH_REQUIRED');
    try {
      return await action();
    } catch (error) {
      if (error instanceof Error && error.message === 'AUTH_REQUIRED') rejectToken(token);
      throw error;
    }
  }, [rejectToken]);

  // Disconnecting, deleting the cloud data or removing the last device: only
  // the token goes, every local draft and queued edit stays.
  const leaveWorkspace = useCallback(() => {
    syncClient.token = '';
    clearDeviceToken(syncClient.apiBase);
    setPhoneConfig(config => ({ ...config, enabled: false }));
    setSyncState('local_only');
  }, []);

  const listDevices = useCallback(() => withDeviceToken(() => syncClient.listDevices()), [withDeviceToken]);

  const removeDevice = useCallback(async (deviceId: string) => {
    const result = await withDeviceToken(() => syncClient.removeDevice(deviceId));
    if (result.workspace_deleted) leaveWorkspace();
    return result;
  }, [leaveWorkspace, withDeviceToken]);

  const disconnectDevice = useCallback(async () => {
    storedDeviceToken();
    await syncClient.revokeCurrentDevice();
    leaveWorkspace();
  }, [leaveWorkspace]);

  // Like the phone: a token the server already dropped counts as deleted. The
  // synced drafts become local-only again; turning 手机远程 back on uploads
  // them to a new workspace through the epoch reset.
  const deleteCloudData = useCallback(async () => {
    storedDeviceToken();
    try {
      await syncClient.deleteWorkspace();
    } catch (error) {
      if (!(error instanceof Error && error.message === 'AUTH_REQUIRED')) throw error;
    }
    leaveWorkspace();
    const state = repository.load();
    markSyncedDraftsLocal(state);
    repository.save(state);
    setWorkspace(previous => {
      const next = { ...previous };
      markSyncedDraftsLocal(next);
      return next;
    });
  }, [leaveWorkspace, repository]);

  function handleSavePhoneConfig(next: PhoneConnectionConfig) {
    syncClient.apiBase = next.syncBaseUrl;
    syncClient.token = loadDeviceToken(next.syncBaseUrl);
    aiClient.baseUrl = next.aiBaseUrl.replace(/\/$/, '');
    setPhoneConfig(next);
  }

  const bodyClassName = inspectorHidden ? 'ide-body inspector-collapsed' : 'ide-body';
  const reviewIssues = activeFile.endsWith('.cpp') ? reviewCpp(documents[activeFile]) : [];

  return (
    <div className="ide-shell">
      <TopBar
        saved={saved}
        syncState={syncState}
        onSync={syncNow}
        onOpenPhoneModal={() => setPhoneModalOpen(true)}
        draftTitle={currentDraft ? currentDraft.title || currentDraft.id : undefined}
        draftVersion={currentDraft?.version}
        mode={AI_ENTRY ? mode : undefined}
      />
      <PhoneConnectionModal
        open={phoneModalOpen}
        onClose={() => setPhoneModalOpen(false)}
        clientId={clientId}
        cursor={workspace.cursor}
        pendingCount={workspace.operations.length}
        config={phoneConfig}
        onSaveConfig={handleSavePhoneConfig}
        onSyncNow={syncNow}
        ensureToken={ensurePairingToken}
        onTokenRejected={rejectToken}
        onTransfer={handlePairingTransfer}
        listDevices={listDevices}
        removeDevice={removeDevice}
        onDisconnect={disconnectDevice}
        onDeleteCloud={deleteCloudData}
      />
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
      {!conflict && syncNotice && (
        <div className="sync-conflict-banner" role="status">
          <div>
            <strong>{syncNotice.title}</strong>
            <span>{syncNotice.message}</span>
          </div>
          <div className="conflict-actions">
            {syncNotice.kind === 'auth' && (
              <button type="button" onClick={() => { setSyncNotice(null); setPhoneModalOpen(true); }}>打开手机远程</button>
            )}
            <button type="button" onClick={() => setSyncNotice(null)}>知道了</button>
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
          saved={saved}
          onDraftChange={selectDraft}
          onFileChange={selectFile}
          onModeChange={selectMode}
          ideaSegments={aiState.segments}
        />
        <EditorStage
          activeFile={activeFile}
          code={documents[activeFile]}
          mode={mode}
          saved={saved}
          onChange={updateActiveDocument}
          onSave={saveWorkspace}
          jumpToLine={jumpToLine}
          cursorPosition={cursorPosition}
          onCursorChange={handleCursorChange}
          onFileChange={selectFile}
          editorKey={`${currentDraft?.id}:${activeFile}`}
          onEditorReady={handleEditorReady}
          onSelectionLines={handleSelectionLines}
          compareOpen={compareOpen}
          onCompareToggle={() => setCompareOpen(open => !open)}
          sidePanel={AI_ENTRY && activeFile === 'rewrite.cpp' && compareOpen ? (
            <RewriteComparePanel
              artifact={compareArtifact}
              draftVersion={currentDraft?.version ?? 0}
              rewrite={documents['rewrite.cpp']}
              mapping={rewriteMapping}
              selection={rewriteSelection}
              revealed={compareArtifact !== null && revealedArtifactId === compareArtifact.id}
              onReveal={() => setRevealedArtifactId(compareArtifact?.id ?? '')}
              onAssign={assignRewriteSelection}
              onConfirm={() => saveRewriteMapping(rewriteMapping.mappings)}
              onClear={clearRewriteMapping}
              onClose={() => setCompareOpen(false)}
              segments={aiState.segments}
            />
          ) : undefined}
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
          transformOutput={transformOutput}
          onTransformOutputChange={setTransformOutput}
          onArtifact={requestArtifact}
          onCancelArtifact={cancelArtifact}
          onToggleArtifact={toggleArtifact}
          onModeChange={selectMode}
          mode={mode}
          activeFile={activeFile}
          canAcceptCompletion={aiSession.canAcceptCompletion()}
          canWithdrawCompletion={aiSession.canWithdrawCompletion()}
          onReview={(kind) => { void aiSession.requestReview(kind); }}
          onCompletion={() => { void aiSession.requestCompletion(toCursor(cursorPosition.line, cursorPosition.column)); }}
          onAcceptCompletion={() => { aiSession.acceptCompletion(change => editorApply.current?.(change) ?? false); }}
          onWithdrawCompletion={() => { aiSession.withdrawCompletion(change => editorApply.current?.(change) ?? false); }}
          onRejectCompletion={() => aiSession.rejectCompletion()}
          onCancel={() => aiSession.cancel()}
          onToggleResult={(id, hidden) => aiSession.setHidden(id, hidden)}
          onRetryStorage={() => aiSession.retryStorage()}
        />
      </main>
      {(ICP_RECORD || PRIVACY_URL) && (
        <footer className="site-footer">
          {PRIVACY_URL && <a href={PRIVACY_URL} target="_blank" rel="noreferrer">隐私政策</a>}
          {PRIVACY_URL && ICP_RECORD && <span aria-hidden="true">·</span>}
          {ICP_RECORD && <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">{ICP_RECORD}</a>}
        </footer>
      )}
    </div>
  );
}

// Hosted builds upload nothing until 手机远程 is on, so a save stays local-only.
function willSync(): boolean {
  return navigator.onLine && (!HOSTED || loadDeviceToken(syncClient.apiBase) !== '');
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
  if (!draft || (!draft.code && !draft.idea && draft.cases === undefined && !draft.rewrite)) return initialDocuments;
  return { 'main.cpp': draft.code, 'idea.md': draft.idea, 'cases.txt': draft.cases ?? '', 'rewrite.cpp': draft.rewrite ?? '' };
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
