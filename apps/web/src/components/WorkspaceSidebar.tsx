import { files, modes } from '../data';
import type { FileId, Mode, Panel } from '../types';
import { Icon } from './Icon';

interface WorkspaceSidebarProps {
  activeFile: FileId;
  activePanel: Panel;
  mode: Mode;
  query: string;
  saved: boolean;
  onFileChange: (file: FileId) => void;
  onModeChange: (mode: Mode) => void;
  onQueryChange: (query: string) => void;
}

export function WorkspaceSidebar({
  activeFile,
  activePanel,
  mode,
  query,
  saved,
  onFileChange,
  onModeChange,
  onQueryChange,
}: WorkspaceSidebarProps) {
  return (
    <aside className="side-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h1>工作区</h1>
        </div>
        <button type="button" className="quiet-button" aria-label="更多工作区操作">
          ···
        </button>
      </div>
      {activePanel === 'files' && (
        <FilesPanel activeFile={activeFile} saved={saved} onFileChange={onFileChange} />
      )}
      {activePanel === 'search' && (
        <SearchPanel query={query} onQueryChange={onQueryChange} />
      )}
      {activePanel === 'source' && <SourcePanel />}
      {activePanel === 'ai' && <AiPanel mode={mode} onModeChange={onModeChange} />}
      {activePanel === 'versions' && <VersionsPanel />}
    </aside>
  );
}

interface FilesPanelProps {
  activeFile: FileId;
  saved: boolean;
  onFileChange: (file: FileId) => void;
}

function FilesPanel({ activeFile, saved, onFileChange }: FilesPanelProps) {
  return (
    <>
      <div className="panel-section-title">
        <span>文件</span>
        <button type="button" className="quiet-button" aria-label="新建文件">
          <Icon name="plus" />
        </button>
      </div>
      <div className="file-tree">
        {files.map((file) => (
          <button
            key={file.id}
            className={activeFile === file.id ? 'tree-item active' : 'tree-item'}
            onClick={() => onFileChange(file.id)}
            type="button"
          >
            <Icon name={file.icon} />
            {file.label}
            {file.id === 'main.cpp' && activeFile === file.id && !saved && (
              <span className="file-status">未保存</span>
            )}
          </button>
        ))}
      </div>
      <div className="panel-note">
        <span className="note-pin">⌁</span>
        <div>
          <strong>手机端刚刚更新</strong>
          <p>1 个思路片段等待你继续。</p>
        </div>
      </div>
    </>
  );
}

interface SearchPanelProps {
  query: string;
  onQueryChange: (query: string) => void;
}

function SearchPanel({ query, onQueryChange }: SearchPanelProps) {
  return (
    <div className="panel-content">
      <label className="search-box">
        <Icon name="search" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="在工作区中搜索"
        />
      </label>
      <p className="muted-copy">
        {query ? `正在搜索“${query}”` : '搜索标题、思路和代码。'}
      </p>
    </div>
  );
}

function SourcePanel() {
  return (
    <div className="panel-content">
      <SourceCard index="01" title="按右端点排序" segment="idea_segment_1" />
      <SourceCard index="02" title="依次选择不冲突区间" segment="idea_segment_2" />
      <p className="muted-copy">来源轨道将随着编辑内容保持稳定。</p>
    </div>
  );
}

interface SourceCardProps {
  index: string;
  title: string;
  segment: string;
}

function SourceCard({ index, title, segment }: SourceCardProps) {
  return (
    <div className="source-card">
      <span className="source-index">{index}</span>
      <div>
        <strong>{title}</strong>
        <p>{segment}</p>
      </div>
    </div>
  );
}

interface AiPanelProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
}

function AiPanel({ mode, onModeChange }: AiPanelProps) {
  return (
    <div className="panel-content">
      <span className="eyebrow">AI MODE</span>
      <div className="mode-list">
        {modes.map((item) => (
          <button
            key={item.id}
            className={mode === item.id ? 'mode-item selected' : 'mode-item'}
            onClick={() => onModeChange(item.id)}
            type="button"
          >
            <span>{item.label}</span>
            <small>{item.id}</small>
          </button>
        ))}
      </div>
      <div className="ai-disabled">
        <strong>AI 未启用</strong>
        <p>未配置模型服务。你的代码、复写和同步仍可继续。</p>
      </div>
    </div>
  );
}

function VersionsPanel() {
  return (
    <div className="panel-content">
      <VersionRow current title="当前编辑" detail="刚刚 · 本机" />
      <VersionRow title="手机端草稿" detail="今天 09:42 · 已同步" />
      <VersionRow title="初始思路" detail="昨天 21:18 · 仅本地" />
    </div>
  );
}

interface VersionRowProps {
  current?: boolean;
  title: string;
  detail: string;
}

function VersionRow({ current = false, title, detail }: VersionRowProps) {
  return (
    <div className="version-row">
      <span className={current ? 'version-dot current' : 'version-dot'} />
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}
