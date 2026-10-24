import type { ReactNode } from 'react';
import { fileLabels } from '../data';
import type { ApplyAIEditorChange, FileId, Mode } from '../types';
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
  onSave?: () => void;
  jumpToLine?: number;
  onCursorChange?: (line: number, column: number) => void;
  cursorPosition?: { line: number; column: number };
  onFileChange: (file: FileId) => void;
  editorKey: string;
  onEditorReady: (apply: ApplyAIEditorChange | null) => void;
  onSelectionLines?: (startLine: number, endLine: number) => void;
  /** Shown beside the editor, e.g. the rewrite comparison. */
  sidePanel?: ReactNode;
  compareOpen?: boolean;
  onCompareToggle?: () => void;
}

const editorFiles: Array<{ id: FileId; icon: string }> = [
  { id: 'main.cpp', icon: 'code' },
  { id: 'idea.md', icon: 'note' },
  { id: 'cases.txt', icon: 'test' },
  { id: 'rewrite.cpp', icon: 'code' },
];

export function EditorStage({
  activeFile,
  bottomOpen,
  code,
  mode,
  saved,
  onBottomToggle,
  onChange,
  onSave,
  jumpToLine,
  onCursorChange,
  cursorPosition = { line: 1, column: 1 },
  onFileChange,
  editorKey,
  onEditorReady,
  onSelectionLines,
  sidePanel,
  compareOpen = false,
  onCompareToggle,
}: EditorStageProps) {
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
        onSaveFile={() => downloadFile(activeFile, code)}
        compareOpen={compareOpen}
        onCompareToggle={activeFile === 'rewrite.cpp' ? onCompareToggle : undefined}
      />
      <div className={sidePanel ? 'editor-body with-side-panel' : 'editor-body'}>
        <CodeEditor key={editorKey} activeFile={activeFile} value={code} onChange={onChange} onSave={onSave} jumpToLine={jumpToLine} onCursorChange={onCursorChange} onEditorReady={onEditorReady} onSelectionLines={onSelectionLines} />
        {sidePanel}
      </div>
      {bottomOpen && <BottomPanel />}
      <footer className="statusbar">
        <span>{activeFile}</span>
        <span>Ln {cursorPosition.line}, Col {cursorPosition.column}</span>
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
  onSaveFile: () => void;
  compareOpen: boolean;
  onCompareToggle?: () => void;
}

function EditorBreadcrumb({
  activeFile,
  bottomOpen,
  saved,
  onBottomToggle,
  onFileChange,
  onSaveFile,
  compareOpen,
  onCompareToggle,
}: EditorBreadcrumbProps) {
  return (
    <div className="breadcrumb">
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
              <span className="tab-dot" aria-label="未保存" />
            )}
          </button>
        ))}
        <button className="breadcrumb-file-add" type="button" aria-label="新建文件">
          <Icon name="plus" />
        </button>
      </nav>
      <span className="breadcrumb-spacer" />
      {onCompareToggle && (
        <button type="button" className="editor-tool" onClick={onCompareToggle} aria-pressed={compareOpen}>
          {compareOpen ? '收起对比' : '复写对比'}
        </button>
      )}
      <button type="button" className="editor-tool" onClick={onBottomToggle}>
        <Icon name="panel" />
        {bottomOpen ? '收起面板' : '问题与同步'}
      </button>
      <button type="button" className="editor-tool" onClick={onSaveFile} title="保存当前文件到本地">
        保存文件
      </button>
    </div>
  );
}

function downloadFile(file: FileId, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file;
  anchor.click();
  URL.revokeObjectURL(url);
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
