import { useCallback, useEffect, useState } from 'react';
import { ActivityBar } from './components/ActivityBar';
import { EditorStage } from './components/EditorStage';
import { InspectorPanel } from './components/InspectorPanel';
import { TopBar } from './components/TopBar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { initialDocuments } from './data';
import type { Documents, FileId, Mode, Panel } from './types';
import { reviewCpp } from './code-review';

export function App() {
  const [documents, setDocuments] = useState<Documents>(initialDocuments);
  const [activeFile, setActiveFile] = useState<FileId>('main.cpp');
  const [activePanel, setActivePanel] = useState<Panel>('files');
  const [mode, setMode] = useState<Mode>('faithful_transform');
  const [bottomOpen, setBottomOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [query, setQuery] = useState('');
  const [syncState, setSyncState] = useState<'local_only' | 'syncing' | 'synced' | 'conflict'>('local_only');
  const [clientId] = useState(() => localStorage.getItem('algoflow.client_id') ?? `web-${crypto.randomUUID()}`);
  const [jumpToLine, setJumpToLine] = useState(0);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });

  useEffect(() => {
    localStorage.setItem('algoflow.client_id', clientId);
    const raw = localStorage.getItem('algoflow.documents');
    if (raw) {
      try { setDocuments({ ...initialDocuments, ...(JSON.parse(raw) as Partial<Documents>) }); } catch { /* ignore corrupt local draft */ }
    }
  }, [clientId]);

  function updateActiveDocument(value: string) {
    setDocuments((current) => ({ ...current, [activeFile]: value }));
    setSaved(false);
  }

  const handleCursorChange = useCallback((line: number, column: number) => {
    setCursorPosition({ line, column });
  }, []);

  function saveWorkspace() {
    localStorage.setItem('algoflow.documents', JSON.stringify(documents));
    const queue = readQueue();
    const entityId = 'draft-local';
    const previous = queue.find((item) => item.entity_id === entityId);
    const operation = {
      operation_id: previous?.operation_id ?? crypto.randomUUID(), entity_type: 'draft', entity_id: entityId,
      operation_type: 'upsert', base_version: previous?.base_version ?? 0, client_id: clientId,
      occurred_at: new Date().toISOString(), payload: { id: entityId, code: documents['main.cpp'], idea: documents['idea.md'], cases: documents['cases.txt'], deleted: false }
    };
    localStorage.setItem('algoflow.sync.queue', JSON.stringify([...queue.filter((item) => item.entity_id !== entityId), operation]));
    setSaved(true);
    void flushQueue();
  }

  function readQueue(): Array<Record<string, unknown>> {
    try { const value = JSON.parse(localStorage.getItem('algoflow.sync.queue') ?? '[]'); return Array.isArray(value) ? value as Array<Record<string, unknown>> : []; } catch { return []; }
  }

  async function flushQueue() {
    const queue = readQueue();
    if (!queue.length || !navigator.onLine) { setSyncState(queue.length ? 'local_only' : 'synced'); return; }
    setSyncState('syncing');
    const remaining: Array<Record<string, unknown>> = [];
    for (const operation of queue) {
      try {
        const response = await fetch('http://127.0.0.1:8787/v1/sync/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation) });
        const result = await response.json() as { status?: string };
        if (result.status === 'conflict') {
          setSyncState('conflict');
          const conflictKey = `algoflow.conflict.${String(operation.entity_id)}.${Date.now()}`;
          localStorage.setItem(conflictKey, JSON.stringify({ ...operation, conflict_created_at: new Date().toISOString() }));
          remaining.push(operation);
          continue;
        }
        if (!response.ok) remaining.push(operation);
      } catch { remaining.push(operation); }
    }
    localStorage.setItem('algoflow.sync.queue', JSON.stringify(remaining));
    if (remaining.length === 0) setSyncState('synced');
  }

  useEffect(() => { const onOnline = () => void flushQueue(); window.addEventListener('online', onOnline); return () => window.removeEventListener('online', onOnline); }, []);

  const bodyClassName = inspectorHidden
    ? 'ide-body inspector-collapsed'
    : 'ide-body';
  const reviewIssues = activeFile.endsWith('.cpp') ? reviewCpp(documents[activeFile]) : [];

  return (
    <div className="ide-shell">
      <TopBar saved={saved} syncState={syncState} onSync={() => void flushQueue()} />
      <main className={bodyClassName}>
        <ActivityBar activePanel={activePanel} onPanelChange={setActivePanel} />
        <WorkspaceSidebar
          activeFile={activeFile}
          activePanel={activePanel}
          mode={mode}
          query={query}
          saved={saved}
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
