import { useState } from 'react';
import { ActivityBar } from './components/ActivityBar';
import { EditorStage } from './components/EditorStage';
import { InspectorPanel } from './components/InspectorPanel';
import { TopBar } from './components/TopBar';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { initialDocuments } from './data';
import type { Documents, FileId, Mode, Panel } from './types';

export function App() {
  const [documents, setDocuments] = useState<Documents>(initialDocuments);
  const [activeFile, setActiveFile] = useState<FileId>('main.cpp');
  const [activePanel, setActivePanel] = useState<Panel>('files');
  const [mode, setMode] = useState<Mode>('faithful_transform');
  const [bottomOpen, setBottomOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [query, setQuery] = useState('');

  function updateActiveDocument(value: string) {
    setDocuments((current) => ({ ...current, [activeFile]: value }));
    setSaved(false);
  }

  const bodyClassName = inspectorHidden
    ? 'ide-body inspector-collapsed'
    : 'ide-body';

  return (
    <div className="ide-shell">
      <TopBar saved={saved} />
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
          onFileChange={setActiveFile}
        />
        <InspectorPanel
          hidden={inspectorHidden}
          onHide={() => setInspectorHidden(true)}
          onShow={() => setInspectorHidden(false)}
        />
      </main>
    </div>
  );
}
