import { useMemo } from 'react';
import { fileLabels } from '../data';
import type { FileId, Mode } from '../types';
import { CodeEditor } from './CodeEditor';
import { Icon } from './Icon';

interface EditorStageProps {
  activeFile: FileId;
  bottomOpen: boolean;
  code: string;
  mode: Mode;
  saved: boolean;
  onBottomToggle: () => void;
  onChange: (value: string) => void;
  onFileChange: (file: FileId) => void;
}

const editorFiles: Array<{ id: FileId; icon: string }> = [
  { id: 'main.cpp', icon: 'code' },
  { id: 'idea.md', icon: 'note' },
  { id: 'cases.txt', icon: 'test' },
];

export function EditorStage({
  activeFile,
  bottomOpen,
  code,
  mode,
  saved,
  onBottomToggle,
  onChange,
  onFileChange,
}: EditorStageProps) {
  const lineCount = useMemo(() => code.split('\n').length, [code]);
  const modeLabel = getModeLabel(mode);

  return (
    <section
      className={bottomOpen ? 'editor-stage panel-open' : 'editor-stage'}
      aria-label="代码编辑区"
    >
      <EditorBreadcrumb
        activeFile={activeFile}
        bottomOpen={bottomOpen}
        saved={saved}
        onBottomToggle={onBottomToggle}
        onFileChange={onFileChange}
      />
      <CodeEditor activeFile={activeFile} value={code} onChange={onChange} />
      {bottomOpen && <BottomPanel />}
      <footer className="statusbar">
        <span><i className="status-ok" /> {activeFile}</span>
        <span>Ln {lineCount}, Col 1</span>
        <span>UTF-8</span>
        <span>{fileLabels[activeFile]}</span>
        <span className="status-spacer" />
        <span>{modeLabel}</span>
        <span>本地工作区</span>
      </footer>
    </section>
  );
}

function getModeLabel(mode: Mode): string {
  const labels: Record<Mode, string> = {
    faithful_transform: '忠实转换',
    feasibility_analysis: '可行性',
    progressive_hint: '渐进提示',
    full_solution: '完整解题',
  };
  return labels[mode];
}

interface EditorBreadcrumbProps {
  activeFile: FileId;
  bottomOpen: boolean;
  saved: boolean;
  onBottomToggle: () => void;
  onFileChange: (file: FileId) => void;
}

function EditorBreadcrumb({
  activeFile,
  bottomOpen,
  saved,
  onBottomToggle,
  onFileChange,
}: EditorBreadcrumbProps) {
  return (
    <div className="breadcrumb">
      <span className="workspace-crumb">工作区</span>
      <b>/</b>
      <nav className="breadcrumb-files" aria-label="当前工作区文件">
        {editorFiles.map((file) => (
          <button
            key={file.id}
            className={activeFile === file.id ? 'breadcrumb-file active' : 'breadcrumb-file'}
            onClick={() => onFileChange(file.id)}
            type="button"
          >
            <Icon name={file.icon} />
            {file.id}
            {file.id === 'main.cpp' && activeFile === file.id && !saved && (
              <span className="tab-dot">●</span>
            )}
          </button>
        ))}
        <button className="breadcrumb-file-add" type="button" aria-label="新建文件">
          <Icon name="plus" />
        </button>
      </nav>
      <span className="breadcrumb-spacer" />
      <button type="button" className="editor-tool" onClick={onBottomToggle}>
        <Icon name="panel" />
        {bottomOpen ? '收起面板' : '问题与同步'}
      </button>
    </div>
  );
}

function BottomPanel() {
  return (
    <div className="bottom-panel">
      <div className="bottom-tabs">
        <button className="selected" type="button">问题 <b>0</b></button>
        <button type="button">同步日志</button>
        <button type="button">终端</button>
      </div>
      <p>没有新的问题。同步队列将在网络恢复后继续提交。</p>
    </div>
  );
}
