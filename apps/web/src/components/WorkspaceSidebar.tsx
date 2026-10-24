import { files, modes } from '../data';
import type { Draft, FileId, IdeaSegment, Mode, Panel } from '../types';
import { Icon } from './Icon';
import { SourceTag } from './SourceTag';
import { SyncChip } from './TopBar';

const panelTitles: Record<Panel, string> = {
  files: '工作区',
  search: '搜索',
  source: '来源轨道',
  ai: 'AI 模式',
  versions: '版本',
};

interface WorkspaceSidebarProps {
  activeFile: FileId;
  activePanel: Panel;
  drafts: Draft[];
  selectedDraftId: string;
  mode: Mode;
  query: string;
  saved: boolean;
  onDraftChange: (draftId: string) => void;
  onFileChange: (file: FileId) => void;
  onModeChange: (mode: Mode) => void;
  onQueryChange: (query: string) => void;
  ideaSegments: IdeaSegment[];
}

export function WorkspaceSidebar({
  activeFile,
  activePanel,
  drafts,
  selectedDraftId,
  mode,
  query,
  saved,
  onDraftChange,
  onFileChange,
  onModeChange,
  onQueryChange,
  ideaSegments,
}: WorkspaceSidebarProps) {
  return (
    <aside className="side-panel" aria-label={panelTitles[activePanel]}>
      {activePanel !== 'files' && <div className="side-heading"><span>{panelTitles[activePanel]}</span></div>}
      {activePanel === 'files' && (
        <FilesPanel activeFile={activeFile} saved={saved} drafts={drafts} selectedDraftId={selectedDraftId}
          onDraftChange={onDraftChange} onFileChange={onFileChange} segments={ideaSegments} />
      )}
      {activePanel === 'search' && (
        <SearchPanel query={query} onQueryChange={onQueryChange} />
      )}
      {activePanel === 'source' && <SourcePanel segments={ideaSegments} />}
      {activePanel === 'ai' && <AiPanel mode={mode} onModeChange={onModeChange} />}
      {activePanel === 'versions' && <VersionsPanel />}
    </aside>
  );
}

interface FilesPanelProps {
  activeFile: FileId;
  saved: boolean;
  drafts: Draft[];
  selectedDraftId: string;
  onDraftChange: (draftId: string) => void;
  onFileChange: (file: FileId) => void;
  segments: IdeaSegment[];
}

function FilesPanel({ activeFile, saved, drafts, selectedDraftId, onDraftChange, onFileChange, segments }: FilesPanelProps) {
  const visibleDrafts = drafts.filter((draft) => !draft.deleted);
  const currentDraft = visibleDrafts.find((draft) => draft.id === selectedDraftId);
  return (
    <>
      <div className="side-heading">
        <span>文件</span>
        <button type="button" className="quiet-button" aria-label="新建文件">
          <Icon name="plus" />
        </button>
      </div>
      <div className="file-tree">
        {files.map((file) => (
          <button
            key={file.id}
            className={activeFile === file.id ? 'tree-item file-item active' : 'tree-item file-item'}
            onClick={() => onFileChange(file.id)}
            type="button"
          >
            <Icon name={file.icon} />
            {file.label}
            {file.id === 'main.cpp' && activeFile === file.id && !saved ? (
              <span className="file-status">未保存</span>
            ) : file.id === 'main.cpp' && currentDraft && (
              <small className="file-meta">v{currentDraft.version}</small>
            )}
          </button>
        ))}
      </div>
      <div className="side-heading">
        <span>思路 · 来源轨道</span>
        <small>{segments.length} 段</small>
      </div>
      <IdeaRail segments={segments} />
      <div className="side-heading"><span>草稿</span></div>
      <div className="file-tree draft-tree">
        {visibleDrafts.map((draft) => (
          <button key={draft.id} className={draft.id === selectedDraftId ? 'tree-item draft-item active' : 'tree-item draft-item'}
            onClick={() => onDraftChange(draft.id)} type="button" title={draft.id}>
            <span className="draft-title">{draft.title || draft.id}</span>
            <SyncChip state={draft.sync_status} small />
          </button>
        ))}
      </div>
    </>
  );
}

/** Idea segments with their rail tag; the only data the sidebar rail is drawn from. */
function IdeaRail({ segments, showIds = false }: { segments: IdeaSegment[]; showIds?: boolean }) {
  if (segments.length === 0) return <p className="muted-copy">在 idea.md 写下思路后，会按行拆成来源片段。</p>;
  return (
    <div className="idea-rail">
      {segments.map((segment, index) => (
        <div className="idea-rail-item" key={segment.id}>
          <SourceTag index={index} title={segment.id} />
          <div>
            <p>{segment.content}</p>
            {showIds && <small>{segment.id}</small>}
          </div>
        </div>
      ))}
    </div>
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

function SourcePanel({ segments }: { segments: IdeaSegment[] }) {
  return (
    <div className="panel-content">
      <IdeaRail segments={segments} showIds />
      <p className="muted-copy">来源轨道颜色按片段顺序在三种颜色间循环；AI 步骤和复写对比用同一组标记引用这些片段。</p>
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
        <strong>{mode === 'faithful_transform' ? '忠实转换 · 按需请求' : '该 AI 模式尚未接入'}</strong>
        <p>在右侧思路检查中请求审查或预览局部补全。未配置模型时会明确显示 AI 不可用。</p>
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
