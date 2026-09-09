import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { AIMode, Draft, IdeaSegment, SyncStatus } from '../domain/Models';
import { RdbDraftRepository } from '../platform/RdbDraftRepository';
import { SyncRunResult, SyncRunStatus } from '../platform/PhoneSyncService';
import { saveCardSnapshot } from '../platform/CardSnapshot';

enum WorkspaceTool {
  NONE = 'none', FILES = 'files', IDEA = 'idea', SNIPPET = 'snippet', AI = 'ai',
  REWRITE = 'rewrite', REVIEW = 'review', SEARCH = 'search', SYNC = 'sync'
}

enum EditorFile { MAIN = 'main.cpp', IDEA = 'idea.md', REWRITE = 'rewrite.cpp' }

enum WorkspaceIcon {
  MENU = 'menu', FILES = 'files', SOURCE = 'source', AI = 'ai', SEARCH = 'search',
  DOCUMENT = 'document', REFRESH = 'refresh', CROSS = 'cross', PLUS = 'plus', CODE = 'code'
}

class ReviewIssue {
  line: number;
  severity: string;
  message: string;
  constructor(line: number, severity: string, message: string) {
    this.line = line;
    this.severity = severity;
    this.message = message;
  }
}

class CompletionItem {
  label: string;
  detail: string;
  insertion: string;
  constructor(label: string, detail: string, insertion: string = label) {
    this.label = label;
    this.detail = detail;
    this.insertion = insertion;
  }
}

class SyntaxToken {
  text: string;
  color: string;

  constructor(text: string, color: string) {
    this.text = text;
    this.color = color;
  }
}

class BracketEntry {
  char: string;
  line: number;
  constructor(char: string, line: number) {
    this.char = char;
    this.line = line;
  }
}

const CPP_COMPLETIONS: CompletionItem[] = [
  new CompletionItem('auto', '类型推导'), new CompletionItem('bool', '布尔类型'),
  new CompletionItem('break', '跳出循环'), new CompletionItem('case', '分支标签'),
  new CompletionItem('class', '类声明'), new CompletionItem('const', '只读限定'),
  new CompletionItem('continue', '继续循环'), new CompletionItem('else', '条件分支'),
  new CompletionItem('for', '循环语句'), new CompletionItem('if', '条件语句'),
  new CompletionItem('include', '头文件指令'), new CompletionItem('int', '整数类型'),
  new CompletionItem('long', '长整数类型'), new CompletionItem('namespace', '命名空间'),
  new CompletionItem('nullptr', '空指针'), new CompletionItem('return', '返回值'),
  new CompletionItem('std', 'C++ 标准库'), new CompletionItem('struct', '结构体声明'),
  new CompletionItem('template', '模板声明'), new CompletionItem('using', '别名或命名空间'),
  new CompletionItem('void', '无返回值'), new CompletionItem('while', '条件循环'),
  new CompletionItem('vector', 'std::vector<T>'), new CompletionItem('array', 'std::array<T, N>'),
  new CompletionItem('map', 'std::map<K, V>'), new CompletionItem('unordered_map', '哈希键值容器'),
  new CompletionItem('pair', 'std::pair<T1, T2>'), new CompletionItem('queue', '队列容器'),
  new CompletionItem('stack', '栈容器'), new CompletionItem('set', '有序集合'),
  new CompletionItem('string', 'std::string'), new CompletionItem('sort', 'std::sort(first, last)'),
  new CompletionItem('for-loop', '循环片段', 'for (int i = 0; i < n; ++i) {\n  \n}'),
  new CompletionItem('range-for', '范围循环片段', 'for (const auto& item : items) {\n  \n}'),
  new CompletionItem('if-else', '条件片段', 'if (condition) {\n  \n} else {\n  \n}'),
  new CompletionItem('main', '程序入口片段', 'int main() {\n  return 0;\n}')
];

@Entry
@Component
struct Index {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new RdbDraftRepository(getContext(this)));
  private editorController: TextAreaController = new TextAreaController();

  @State drafts: Draft[] = [];
  @State selectedId: string = '';
  @State title: string = '';
  @State idea: string = '';
  @State code: string = '';
  @State shortCode: string = '';
  @State rewrite: string = '';
  @State mode: AIMode = AIMode.FAITHFUL_TRANSFORM;
  @State artifactHidden: boolean = false;
  @State syncStatus: SyncStatus = SyncStatus.LOCAL_ONLY;
  @State segments: IdeaSegment[] = [];
  @State activeFile: EditorFile = EditorFile.MAIN;
  @State activeTool: WorkspaceTool = WorkspaceTool.NONE;
  @State drawerOpen: boolean = false;
  @State saved: boolean = true;
  @State selectionStart: number = 0;
  @State selectionEnd: number = 0;
  @State activeLine: number = 0;
  @State activeColumn: number = 0;
  @State scrollY: number = 0;
  @State completionItems: CompletionItem[] = [];
  @State completionVisible: boolean = false;
  @State reviewIssues: ReviewIssue[] = [];
  @State searchQuery: string = '';
  @State searchCount: number = 0;
  @State syncBaseUrl: string = 'http://127.0.0.1:8787';
  @State syncMessage: string = '';

  aboutToAppear(): void {
    this.initializeWorkspace();
  }

  private async initializeWorkspace(): Promise<void> {
    try {
      const repository = new RdbDraftRepository(getContext(this));
      this.viewModel = new DraftWorkspaceViewModel(repository, repository);
      await this.viewModel.initialize();
      const routedDraftId = AppStorage.get<string>('routeDraftId');
      const resolvedRouteId = routedDraftId === 'latest' ? this.viewModel.ensureStarterDraft() : routedDraftId;
      this.selectedId = resolvedRouteId !== undefined && this.viewModel.getDraft(resolvedRouteId) !== undefined
        ? resolvedRouteId : this.viewModel.ensureStarterDraft();
      const configuredBaseUrl = this.viewModel.getSyncBaseUrl();
      if (configuredBaseUrl.length > 0) this.syncBaseUrl = configuredBaseUrl;
      if (routedDraftId !== undefined) AppStorage.setOrCreate<string>('routeDraftId', '');
      this.loadSelectedDraft();
    } catch (error) {
      console.error(`[AlgoFlow] RDB initialization failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.syncStatus = SyncStatus.FAILED;
      this.saved = false;
    }
  }

  private loadSelectedDraft(): void {
    this.drafts = this.viewModel.listDrafts();
    const draft = this.viewModel.getDraft(this.selectedId);
    if (draft === undefined) return;
    this.title = draft.title;
    this.idea = draft.idea;
    this.code = draft.code;
    this.shortCode = draft.shortCode;
    this.rewrite = draft.rewrite;
    this.mode = draft.aiMode;
    this.artifactHidden = draft.artifactHidden;
    this.syncStatus = draft.syncStatus;
    this.segments = draft.ideaSegments;
    saveCardSnapshot(getContext(this), draft);
    this.saved = true;
    this.resetEditorPosition();
    this.refreshEditorFeatures();
  }

  private resetEditorPosition(): void {
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.activeLine = 0;
    this.activeColumn = 0;
    this.scrollY = 0;
    this.completionItems = [];
    this.completionVisible = false;
    setTimeout(() => {
      this.editorController.setTextSelection(0, 0);
      this.editorController.caretPosition(0);
    }, 60);
  }

  private currentValue(): string {
    if (this.activeFile === EditorFile.IDEA) return this.idea;
    if (this.activeFile === EditorFile.REWRITE) return this.rewrite;
    return this.code;
  }

  private isCppFile(): boolean {
    return this.activeFile === EditorFile.MAIN || this.activeFile === EditorFile.REWRITE;
  }

  private setCurrentValue(value: string): void {
    if (this.activeFile === EditorFile.IDEA) this.idea = value;
    else if (this.activeFile === EditorFile.REWRITE) this.rewrite = value;
    else this.code = value;
  }

  private updateDocument(value: string): void {
    this.setCurrentValue(value);
    this.saved = false;
    this.syncStatus = SyncStatus.LOCAL_ONLY;
    this.viewModel.update(this.selectedId, this.title, this.idea, this.code, this.shortCode, this.rewrite);
    const draft = this.viewModel.getDraft(this.selectedId);
    if (draft !== undefined) this.segments = draft.ideaSegments;
    this.refreshEditorFeatures();
  }

  private replaceSelection(insertion: string): void {
    const value = this.currentValue();
    const start = Math.max(0, Math.min(this.selectionStart, value.length));
    const end = Math.max(start, Math.min(this.selectionEnd, value.length));
    const nextValue = `${value.substring(0, start)}${insertion}${value.substring(end)}`;
    this.updateDocument(nextValue);
    this.moveCaret(start + insertion.length);
  }

  private moveCaret(position: number, selectionEnd: number = position): void {
    const value = this.currentValue();
    const safeStart = Math.max(0, Math.min(position, value.length));
    const safeEnd = Math.max(safeStart, Math.min(selectionEnd, value.length));
    this.updateSelection(safeStart, safeEnd);
    setTimeout(() => {
      if (safeStart === safeEnd) {
        this.editorController.caretPosition(safeStart);
      } else {
        this.editorController.setTextSelection(safeStart, safeEnd);
      }
    }, 180);
  }

  private updateSelection(start: number, end: number = start): void {
    const value = this.currentValue();
    this.selectionStart = Math.max(0, Math.min(start, value.length));
    this.selectionEnd = Math.max(this.selectionStart, Math.min(end, value.length));
    const before = value.substring(0, this.selectionStart);
    this.activeLine = before.split('\n').length - 1;
    const lastBreak = before.lastIndexOf('\n');
    this.activeColumn = before.length - lastBreak - 1;
    this.updateCompletions();
  }

  private updateCompletions(): void {
    if (!this.isCppFile() || this.selectionStart !== this.selectionEnd) {
      this.completionVisible = false;
      this.completionItems = [];
      return;
    }
    const before = this.currentValue().substring(0, this.selectionStart);
    const match = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);
    const prefix = match === null ? '' : match[0];
    if (prefix.length === 0) {
      this.completionVisible = false;
      this.completionItems = [];
      return;
    }
    this.completionItems = CPP_COMPLETIONS.filter((item: CompletionItem) => item.label.startsWith(prefix)).slice(0, 6);
    this.completionVisible = this.completionItems.length > 0;
  }

  private applyCompletion(item: CompletionItem): void {
    const before = this.currentValue().substring(0, this.selectionStart);
    const match = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);
    const prefixLength = match === null ? 0 : match[0].length;
    this.selectionStart -= prefixLength;
    this.replaceSelection(item.insertion);
    this.completionVisible = false;
  }

  private handleEditorKey(event: KeyEvent): boolean {
    if (event.type !== KeyType.Down) return false;
    if ((event.keyText === 'Tab' || event.keyText === 'TAB') && this.completionVisible && this.completionItems.length > 0) {
      this.applyCompletion(this.completionItems[0]);
      return true;
    }
    return false;
  }

  private handleWillInsert(info: InsertValue): boolean {
    if (!this.isCppFile() || this.selectionStart !== this.selectionEnd) return true;
    const value = this.currentValue();
    const offset = Math.max(0, Math.min(info.insertOffset, value.length));
    const inserted = info.insertValue;
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const closing = pairs[inserted];
    if (closing !== undefined) {
      this.applyEditorTransaction(offset, offset, `${inserted}${closing}`, offset + 1);
      return false;
    }
    if (inserted === ')' || inserted === ']' || inserted === '}') {
      if (value.substring(offset, offset + 1) === inserted) {
        this.moveCaret(offset + 1);
        return false;
      }
      return true;
    }
    if (inserted === '\n') {
      this.insertIndentedNewline(offset);
      return false;
    }
    return true;
  }

  private applyEditorTransaction(start: number, end: number, insertion: string, caret: number): void {
    const value = this.currentValue();
    const safeStart = Math.max(0, Math.min(start, value.length));
    const safeEnd = Math.max(safeStart, Math.min(end, value.length));
    const nextValue = `${value.substring(0, safeStart)}${insertion}${value.substring(safeEnd)}`;
    this.updateDocument(nextValue);
    this.moveCaret(caret);
  }

  private insertIndentedNewline(offset: number): void {
    const value = this.currentValue();
    const lineStart = value.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const beforeCaret = value.substring(lineStart, offset);
    const indentMatch = beforeCaret.match(/^\s*/);
    const baseIndent = indentMatch === null ? '' : indentMatch[0];
    const trimmedBefore = beforeCaret.trimEnd();
    const opener = trimmedBefore.length === 0 ? '' : trimmedBefore.substring(trimmedBefore.length - 1);
    const expectedClose = opener === '{' ? '}' : opener === '[' ? ']' : opener === '(' ? ')' : '';
    const nextCharacter = value.substring(offset, offset + 1);
    if (expectedClose.length > 0 && nextCharacter === expectedClose) {
      const innerIndent = `${baseIndent}  `;
      const insertion = `\n${innerIndent}\n${baseIndent}`;
      this.applyEditorTransaction(offset, offset, insertion, offset + 1 + innerIndent.length);
      return;
    }
    const nextIndent = opener === '{' ? `${baseIndent}  ` : baseIndent;
    const insertion = `\n${nextIndent}`;
    this.applyEditorTransaction(offset, offset, insertion, offset + insertion.length);
  }

  private highlightedTokens(): SyntaxToken[] {
    if (!this.isCppFile()) return [new SyntaxToken(this.currentValue(), '#E8ECE9')];
    return tokenizeCpp(this.currentValue());
  }

  private duplicateLine(): void {
    const value = this.currentValue();
    const lineStart = value.lastIndexOf('\n', Math.max(0, this.selectionStart - 1)) + 1;
    const nextBreak = value.indexOf('\n', this.selectionStart);
    const lineEnd = nextBreak < 0 ? value.length : nextBreak;
    const line = value.substring(lineStart, lineEnd);
    const nextValue = `${value.substring(0, lineEnd)}\n${line}${value.substring(lineEnd)}`;
    this.updateDocument(nextValue);
    this.moveCaret(this.selectionStart + line.length + 1);
  }

  private deleteLine(): void {
    const value = this.currentValue();
    const lineStart = value.lastIndexOf('\n', Math.max(0, this.selectionStart - 1)) + 1;
    const nextBreak = value.indexOf('\n', this.selectionStart);
    const lineEnd = nextBreak < 0 ? value.length : nextBreak + 1;
    const nextValue = `${value.substring(0, lineStart)}${value.substring(lineEnd)}`;
    this.updateDocument(nextValue);
    this.moveCaret(Math.min(lineStart, nextValue.length));
  }

  private formatDocument(): void {
    if (!this.isCppFile()) return;
    let level = 0;
    const formatted = this.currentValue().split('\n').map((line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return '';
      if (trimmed.startsWith('}')) level = Math.max(0, level - 1);
      const result = `${'  '.repeat(level)}${trimmed}`;
      if (trimmed.endsWith('{')) level += 1;
      return result;
    }).join('\n');
    this.updateDocument(formatted);
    this.moveCaret(Math.min(this.selectionStart, formatted.length));
  }

  private refreshEditorFeatures(): void {
    this.reviewIssues = this.isCppFile() ? reviewCpp(this.currentValue()) : [];
    this.updateSearchCount();
    this.updateCompletions();
  }

  private updateSearchCount(): void {
    if (this.searchQuery.length === 0) {
      this.searchCount = 0;
      return;
    }
    const value = this.currentValue();
    let offset = 0;
    let count = 0;
    while (offset <= value.length) {
      const found = value.indexOf(this.searchQuery, offset);
      if (found < 0) break;
      count += 1;
      offset = found + Math.max(1, this.searchQuery.length);
    }
    this.searchCount = count;
  }

  private jumpToNextMatch(): void {
    if (this.searchQuery.length === 0) return;
    const value = this.currentValue();
    let found = value.indexOf(this.searchQuery, this.selectionEnd);
    if (found < 0) found = value.indexOf(this.searchQuery);
    if (found >= 0) this.moveCaret(found, found + this.searchQuery.length);
  }

  private jumpToLine(lineNumber: number): void {
    const lines = this.currentValue().split('\n');
    const safeLine = Math.max(1, Math.min(lineNumber, lines.length));
    let position = 0;
    for (let index = 0; index < safeLine - 1; index++) position += lines[index].length + 1;
    this.moveCaret(position);
  }

  private selectFile(file: EditorFile): void {
    if (this.activeFile === file) return;
    this.activeFile = file;
    this.resetEditorPosition();
    this.refreshEditorFeatures();
  }

  private toggleTool(tool: WorkspaceTool): void {
    this.activeTool = this.activeTool === tool ? WorkspaceTool.NONE : tool;
    this.completionVisible = false;
  }

  private openDrawer(): void {
    this.drawerOpen = true;
    this.completionVisible = false;
  }

  private closeDrawer(): void {
    this.drawerOpen = false;
  }

  private openTool(tool: WorkspaceTool): void {
    this.activeTool = tool;
    this.drawerOpen = false;
    this.completionVisible = false;
  }

  private createDraft(): void {
    this.selectedId = this.viewModel.createDraft();
    this.activeFile = EditorFile.MAIN;
    this.loadSelectedDraft();
  }

  private selectDraft(id: string): void {
    this.selectedId = id;
    this.activeFile = EditorFile.MAIN;
    this.loadSelectedDraft();
  }

  private deleteDraft(): void {
    this.selectedId = this.viewModel.deleteDraft(this.selectedId);
    this.activeFile = EditorFile.MAIN;
    this.loadSelectedDraft();
  }

  private saveDraft(): void {
    this.viewModel.update(this.selectedId, this.title, this.idea, this.code, this.shortCode, this.rewrite);
    const draft = this.viewModel.getDraft(this.selectedId);
    if (draft !== undefined) this.segments = draft.ideaSegments;
    this.drafts = this.viewModel.listDrafts();
    this.syncStatus = SyncStatus.LOCAL_ONLY;
    this.saved = true;
    if (draft !== undefined) saveCardSnapshot(getContext(this), draft);
  }

  private async synchronize(): Promise<void> {
    this.viewModel.setSyncBaseUrl(this.syncBaseUrl);
    this.syncStatus = SyncStatus.SYNCING;
    this.syncMessage = '正在连接 sync-api...';
    let result: SyncRunResult | undefined;
    try {
      result = await this.viewModel.synchronize();
    } catch (error) {
      this.syncStatus = SyncStatus.FAILED;
      this.syncMessage = error instanceof Error ? error.message : '同步请求失败';
      return;
    }
    if (result === undefined) {
      this.syncStatus = SyncStatus.LOCAL_ONLY;
      this.syncMessage = '当前仓储未启用同步';
      return;
    }
    if (result.status === SyncRunStatus.SYNCED) this.syncStatus = SyncStatus.SYNCED;
    else if (result.status === SyncRunStatus.CONFLICT) this.syncStatus = SyncStatus.CONFLICT;
    else if (result.status === SyncRunStatus.FAILED) this.syncStatus = SyncStatus.FAILED;
    else this.syncStatus = SyncStatus.LOCAL_ONLY;
    this.syncMessage = result.message;
    this.drafts = this.viewModel.listDrafts();
    this.selectRemoteDraftIfPlaceholder();
    const draft = this.viewModel.getDraft(this.selectedId);
    if (draft !== undefined) {
      this.title = draft.title;
      this.idea = draft.idea;
      this.code = draft.code;
      this.shortCode = draft.shortCode;
      this.rewrite = draft.rewrite;
      this.segments = draft.ideaSegments;
      saveCardSnapshot(getContext(this), draft);
    }
  }

  private selectRemoteDraftIfPlaceholder(): void {
    const selected = this.viewModel.getDraft(this.selectedId);
    if (selected === undefined || selected.version > 0 || selected.code.length > 0 ||
      selected.idea.length > 0 || selected.shortCode.length > 0 || selected.rewrite.length > 0) return;
    const remote = this.drafts
      .filter((draft: Draft) => draft.id !== selected.id && draft.syncStatus === SyncStatus.SYNCED && !draft.deleted)
      .filter((draft: Draft) => draft.version > 0 || draft.code.length > 0 || draft.idea.length > 0 ||
        draft.shortCode.length > 0 || draft.rewrite.length > 0)
      .sort((left: Draft, right: Draft) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (remote !== undefined) {
      this.selectedId = remote.id;
      this.loadSelectedDraft();
    }
  }

  private chooseMode(nextMode: AIMode): void {
    this.viewModel.setMode(this.selectedId, nextMode);
    this.mode = nextMode;
    this.saved = false;
    this.syncStatus = SyncStatus.LOCAL_ONLY;
  }

  private toggleArtifact(): void {
    this.viewModel.toggleArtifact(this.selectedId);
    this.artifactHidden = !this.artifactHidden;
    this.saved = false;
  }

  private lineNumbers(): string {
    const count = Math.max(1, this.currentValue().split('\n').length);
    const result: string[] = [];
    for (let index = 1; index <= count; index++) result.push(index.toString().padStart(2, '0'));
    return result.join('\n');
  }

  private placeholder(): string {
    if (this.activeFile === EditorFile.IDEA) return '# 每行记录一个思路步骤';
    if (this.activeFile === EditorFile.REWRITE) return '// 在这里独立复写';
    return '// 在 main.cpp 中继续编辑';
  }

  private modeLabel(): string {
    if (this.mode === AIMode.FEASIBILITY_ANALYSIS) return '可行性分析';
    if (this.mode === AIMode.PROGRESSIVE_HINT) return '渐进提示';
    if (this.mode === AIMode.FULL_SOLUTION) return '完整解题';
    return '忠实转换';
  }

  private statusLabel(): string {
    if (!this.saved) return '未保存';
    if (this.syncStatus === SyncStatus.SYNCING) return '同步中';
    if (this.syncStatus === SyncStatus.SYNCED) return '已同步';
    if (this.syncStatus === SyncStatus.CONFLICT) return '有冲突';
    if (this.syncStatus === SyncStatus.FAILED) return '同步失败';
    return '仅本地';
  }

  private statusColor(): string {
    if (!this.saved || this.syncStatus === SyncStatus.CONFLICT) return '#FF9F0A';
    if (this.syncStatus === SyncStatus.FAILED) return '#FF453A';
    if (this.syncStatus === SyncStatus.SYNCING) return '#79C0FF';
    if (this.syncStatus === SyncStatus.SYNCED) return '#30D158';
    return '#8E8E93';
  }

  private fileIcon(file: EditorFile): WorkspaceIcon {
    if (file === EditorFile.IDEA) return WorkspaceIcon.SOURCE;
    if (file === EditorFile.REWRITE) return WorkspaceIcon.CODE;
    return WorkspaceIcon.FILES;
  }

  private toolIcon(tool: WorkspaceTool): WorkspaceIcon {
    if (tool === WorkspaceTool.FILES) return WorkspaceIcon.FILES;
    if (tool === WorkspaceTool.IDEA) return WorkspaceIcon.SOURCE;
    if (tool === WorkspaceTool.SNIPPET) return WorkspaceIcon.CODE;
    if (tool === WorkspaceTool.AI) return WorkspaceIcon.AI;
    if (tool === WorkspaceTool.REWRITE) return WorkspaceIcon.DOCUMENT;
    if (tool === WorkspaceTool.SEARCH) return WorkspaceIcon.SEARCH;
    if (tool === WorkspaceTool.SYNC) return WorkspaceIcon.REFRESH;
    return WorkspaceIcon.DOCUMENT;
  }

  private modeIcon(mode: AIMode): WorkspaceIcon {
    if (mode === AIMode.FAITHFUL_TRANSFORM) return WorkspaceIcon.SOURCE;
    if (mode === AIMode.FEASIBILITY_ANALYSIS) return WorkspaceIcon.SEARCH;
    if (mode === AIMode.PROGRESSIVE_HINT) return WorkspaceIcon.AI;
    return WorkspaceIcon.DOCUMENT;
  }

  @Builder
  Icon(icon: WorkspaceIcon, size: number = 15, color: string = '#FFFFFF') {
    if (icon === WorkspaceIcon.MENU) {
      Image($r('app.media.menu')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    } else if (icon === WorkspaceIcon.FILES) {
      Image($r('app.media.files')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    } else if (icon === WorkspaceIcon.SOURCE) {
      Image($r('app.media.source')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    } else if (icon === WorkspaceIcon.AI) {
      Image($r('app.media.ai')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    } else if (icon === WorkspaceIcon.SEARCH) {
      Image($r('app.media.search')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    } else if (icon === WorkspaceIcon.DOCUMENT) {
      Image($r('app.media.document')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    } else if (icon === WorkspaceIcon.REFRESH) {
      Image($r('app.media.refresh')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    } else if (icon === WorkspaceIcon.CROSS) {
      Image($r('app.media.cross')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    } else if (icon === WorkspaceIcon.PLUS) {
      Image($r('app.media.plus')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    } else {
      Image($r('app.media.code')).width(size).height(size).fillColor(color).objectFit(ImageFit.Contain)
    }
  }

  @Builder
  FileTab(file: EditorFile, label: string) {
    Button() {
      Row({ space: 5 }) {
        this.Icon(this.fileIcon(file), 13, this.activeFile === file ? '#ECECED' : '#6E6E73')
        Text(`${label}${!this.saved && this.activeFile === file ? ' *' : ''}`).fontSize(10)
          .fontColor(this.activeFile === file ? '#ECECED' : '#8E8E93')
      }
    }.height(34).padding({ left: 11, right: 11 })
      .backgroundColor(this.activeFile === file ? '#1C1C1E' : Color.Transparent)
      .borderRadius(4).onClick(() => this.selectFile(file))
  }

  @Builder
  ToolButton(label: string, tool: WorkspaceTool) {
    Button() {
      Row({ space: 5 }) {
        this.Icon(this.toolIcon(tool), 14, this.activeTool === tool ? '#ECECED' : '#8E8E93')
        Text(label).fontSize(10).fontColor(this.activeTool === tool ? '#ECECED' : '#8E8E93')
      }
    }.height(36).padding({ left: 13, right: 13 })
      .backgroundColor(this.activeTool === tool ? '#1E6B39' : Color.Transparent)
      .borderRadius(5).onClick(() => this.toggleTool(tool))
  }

  @Builder
  ModeButton(label: string, value: AIMode) {
    Button() {
      Row({ space: 5 }) {
        this.Icon(this.modeIcon(value), 13, this.mode === value ? '#07110A' : '#A7A7AD')
        Text(label).fontSize(10).fontColor(this.mode === value ? '#07110A' : '#D4D4D8')
      }
    }.layoutWeight(1).height(34)
      .backgroundColor(this.mode === value ? '#30D158' : '#242426')
      .borderRadius(4).onClick(() => this.chooseMode(value))
  }

  @Builder
  DrawerSectionTitle(label: string) {
    Text(label.toUpperCase()).fontSize(9).fontWeight(FontWeight.Bold).fontColor('#8E8E93')
      .margin({ bottom: 7 })
  }

  @Builder
  DrawerFileButton(file: EditorFile, label: string) {
    Button() {
      Row({ space: 9 }) {
        this.Icon(this.fileIcon(file), 15, this.activeFile === file ? '#ECECED' : '#A7A7AD')
        Column() {
          Text(label).fontSize(11).fontColor(this.activeFile === file ? '#ECECED' : '#B8B8BD')
          Text(file === EditorFile.MAIN ? '主代码编辑区' : file === EditorFile.IDEA ? '思路来源文件' : '独立复写文件')
            .fontSize(9).fontColor('#6E6E73').margin({ top: 2 })
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        if (this.activeFile === file) {
          Circle().width(6).height(6).fill('#ECECED')
        }
      }
    }.width('100%').height(48).padding({ left: 11, right: 11 })
      .backgroundColor(this.activeFile === file ? '#242426' : '#1C1C1E')
      .border({ width: 1, color: this.activeFile === file ? '#5A5A5F' : '#2A2A2D' })
      .borderRadius(7).onClick(() => { this.selectFile(file); this.closeDrawer(); })
  }

  @Builder
  DrawerToolButton(label: string, tool: WorkspaceTool) {
    Button() {
      Row({ space: 8 }) {
        this.Icon(this.toolIcon(tool), 14, this.activeTool === tool ? '#ECECED' : '#A7A7AD')
        Text(label).fontSize(10).fontColor(this.activeTool === tool ? '#ECECED' : '#B8B8BD')
        Blank()
        if (this.activeTool === tool) {
          Text('打开').fontSize(9).fontColor('#ECECED')
        }
      }
    }.width('100%').height(36).padding({ left: 11, right: 11 })
      .backgroundColor(this.activeTool === tool ? '#242426' : Color.Transparent)
      .border({ width: 1, color: this.activeTool === tool ? '#5A5A5F' : Color.Transparent })
      .borderRadius(6).onClick(() => this.openTool(tool))
  }

  @Builder
  DrawerModeButton(label: string, value: AIMode) {
    Button() {
      Row({ space: 5 }) {
        this.Icon(this.modeIcon(value), 13, this.mode === value ? '#ECECED' : '#A7A7AD')
        Text(label).fontSize(10).fontColor(this.mode === value ? '#ECECED' : '#B8B8BD')
      }
    }.layoutWeight(1).height(34)
      .backgroundColor(this.mode === value ? '#242426' : '#1C1C1E')
      .border({ width: 1, color: this.mode === value ? '#5A5A5F' : '#2A2A2D' })
      .borderRadius(4).onClick(() => this.chooseMode(value))
  }

  @Builder
  TopNavigation() {
    Row() {
      Button() {
        this.Icon(WorkspaceIcon.MENU, 18, '#ECECED')
      }.width(38).height(38).padding({ left: 0, right: 0, top: 0, bottom: 0 })
        .backgroundColor('#1E1E20').borderRadius(19).onClick(() => this.openDrawer())
      Column() {
        Text(this.activeFile).fontSize(13).fontWeight(FontWeight.Medium).fontFamily('monospace')
          .fontColor('#ECECED')
        Text(this.title.length === 0 ? '未命名思路' :
          this.title.length > 16 ? `${this.title.substring(0, 16)}...` : this.title).fontSize(9).fontColor('#8E8E93')
          .margin({ top: 3 })
      }.layoutWeight(1).alignItems(HorizontalAlign.Center)
      Button() {
        Row({ space: 5 }) {
          Circle().width(7).height(7).fill(this.statusColor())
          Text(this.statusLabel()).fontSize(9).fontColor('#B8B8BD')
        }
      }.height(28).padding({ left: 9, right: 9 }).backgroundColor('#1E1E20').borderRadius(14)
        .onClick(() => this.openTool(WorkspaceTool.SYNC))
    }.width('100%').height(58).padding({ left: 14, right: 14 })
      .backgroundColor('#111113').border({ width: { bottom: 1 }, color: '#2A2A2D' })
  }

  @Builder
  EditorHeader() {
    Row() {
      Text(this.activeFile === EditorFile.IDEA ? 'TEXT' : 'C++').fontSize(9).fontWeight(FontWeight.Bold)
        .fontColor('#9BE7A9').backgroundColor('#1E3A27').borderRadius(3)
        .padding({ left: 6, right: 6, top: 3, bottom: 3 })
      Text(this.activeFile).fontSize(12).fontWeight(FontWeight.Medium).fontColor('#ECECED').margin({ left: 9 })
      if (!this.saved) {
        Circle().width(6).height(6).fill('#FF9F0A').margin({ left: 7 })
      }
      Blank()
      Text(`${this.currentValue().split('\n').length} 行`).fontSize(9).fontColor('#8E8E93')
      if (this.isCppFile()) {
        Text(`${this.reviewIssues.length} 项检查`).fontSize(9).fontColor('#8E8E93').margin({ left: 10 })
      }
    }.width('100%').height(36).padding({ left: 12, right: 12 }).backgroundColor('#161618')
      .border({ width: { bottom: 1 }, color: '#242426' })
  }

  @Builder
  EditorSurface() {
    Stack({ alignContent: Alignment.TopStart }) {
      Row() {
        Column() {
          Text(this.lineNumbers()).width('100%').padding({ top: 12, right: 9 })
            .fontSize(13).lineHeight(22).fontFamily('monospace').fontColor('#48484A')
            .textAlign(TextAlign.End).translate({ y: -this.scrollY })
        }.width(40).height('100%').clip(true).backgroundColor('#0D0D0F')
        Blank().layoutWeight(1).height('100%').backgroundColor('#0A0A0C')
      }.width('100%').height('100%')

      Row() {
        Blank().width(40)
        Blank().layoutWeight(1).height(22).border({ width: { left: 2 }, color: '#8E8E93' })
          .backgroundColor('#1C1C1E').margin({ right: 8 })
      }.width('100%').height(22).position({ x: 0, y: 12 + this.activeLine * 22 - this.scrollY })

      if (this.currentValue().length > 0) {
        Row() {
          Blank().width(40).height('100%')
          Text() {
            ForEach(this.highlightedTokens(), (token: SyntaxToken) => {
              Span(token.text).fontColor(token.color)
            }, (token: SyntaxToken, index: number) => `${index}-${token.color}-${token.text}`)
          }.layoutWeight(1).padding({ top: 12, bottom: 12, left: 0, right: 8 })
            .fontSize(13).lineHeight(22).fontFamily('monospace').fontColor('#E8ECE9')
            .textAlign(TextAlign.Start).translate({ y: -this.scrollY }).hitTestBehavior(HitTestMode.Transparent)
        }.width('100%').height('100%').alignItems(VerticalAlign.Top).hitTestBehavior(HitTestMode.Transparent)
      }

      Row() {
        Blank().width(40).height('100%')
        TextArea({ text: this.currentValue(), placeholder: this.placeholder(), controller: this.editorController })
          .layoutWeight(1).height('100%').padding({ top: 12, bottom: 12, left: 0, right: 8 })
          .fontSize(13).lineHeight(22).fontFamily('monospace').fontColor(Color.Transparent)
          .placeholderColor('#7B857E')
          .caretColor('#E8ECE9').selectedBackgroundColor('#46594D')
          .backgroundColor(Color.Transparent).border({ width: 0 }).borderRadius(0)
          .onTextSelectionChange((start: number, end: number) => this.updateSelection(start, end))
          .onContentScroll((_offsetX: number, offsetY: number) => { this.scrollY = this.getUIContext().px2vp(offsetY); })
          .onKeyEvent((event: KeyEvent) => this.handleEditorKey(event))
          .onWillInsert((info: InsertValue) => this.handleWillInsert(info))
          .onChange((value: string) => this.updateDocument(value))
      }.width('100%').height('100%')

      if (this.completionVisible) {
        Column() {
          ForEach(this.completionItems, (item: CompletionItem) => {
            Button(`${item.label}    ${item.detail}`).width('100%').height(30).fontSize(10)
              .fontColor('#E7ECE8').backgroundColor('#303A34')
              .onClick(() => this.applyCompletion(item))
          }, (item: CompletionItem) => item.label)
        }.width(240).position({ x: 44, y: 38 }).padding({ top: 3, bottom: 3 })
          .backgroundColor('#303A34').border({ width: 1, color: '#607066' }).borderRadius(4)
      }
    }.width('100%').layoutWeight(1).clip(true).backgroundColor('#0A0A0C')
  }

  @Builder
  FilesPanel() {
    Column({ space: 8 }) {
      Row() {
        Text('草稿').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
        Blank()
        Button() {
          Row({ space: 5 }) {
            this.Icon(WorkspaceIcon.PLUS, 13)
            Text('新建').fontSize(10).fontColor('#FFFFFF')
          }
        }.height(30).fontColor('#07110A').backgroundColor('#30D158').borderRadius(4).onClick(() => this.createDraft())
        Button('删除').height(30).fontSize(10).fontColor('#FF9A94').backgroundColor('#2A1B1C').borderRadius(4).margin({ left: 7 }).onClick(() => this.deleteDraft())
      }.width('100%')
      Text(this.syncMessage).fontSize(10).lineHeight(16).fontColor(this.syncStatus === SyncStatus.FAILED ? '#FF9A94' : '#8E8E93')
        .margin({ top: 7 })
      Scroll() {
        Column({ space: 5 }) {
          ForEach(this.drafts, (draft: Draft) => {
            Button(`${draft.title} · v${draft.version}`).width('100%').height(34).fontSize(10)
              .fontColor(draft.id === this.selectedId ? '#07110A' : '#B8B8BD')
              .backgroundColor(draft.id === this.selectedId ? '#30D158' : '#242426')
              .borderRadius(4).onClick(() => this.selectDraft(draft.id))
          }, (draft: Draft) => draft.id)
        }
      }.width('100%').height(130).scrollBar(BarState.Auto)
      TextInput({ text: this.title, placeholder: '草稿标题' }).width('100%').height(36).fontSize(11)
        .fontColor('#ECECED').placeholderColor('#6E6E73').backgroundColor('#1E1E20')
        .border({ width: 1, color: '#3A3A3D' }).borderRadius(4)
        .onChange((value: string) => { this.title = value; this.saved = false; })
    }.width('100%').backgroundColor('#161618')
  }

  @Builder
  IdeaPanel() {
    Column() {
      Text('思路来源').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
      Text('编辑 idea.md 后，每个非空行保留稳定来源 ID。').fontSize(10).fontColor('#8E8E93').margin({ top: 3, bottom: 9 })
      Button() {
        Row({ space: 5 }) {
          this.Icon(WorkspaceIcon.SOURCE, 14)
          Text('打开 idea.md').fontSize(10).fontColor('#FFFFFF')
        }
      }.height(34).fontColor('#07110A').backgroundColor('#30D158').borderRadius(4)
        .onClick(() => { this.selectFile(EditorFile.IDEA); this.activeTool = WorkspaceTool.NONE; })
      if (this.segments.length > 0) {
        Scroll() {
          Row({ space: 6 }) {
            ForEach(this.segments, (segment: IdeaSegment) => {
              Text(`S${segment.position + 1}`).height(28).padding({ left: 9, right: 9 })
                .fontSize(10).fontColor('#9BE7A9').backgroundColor('#1E3A27').borderRadius(4)
            }, (segment: IdeaSegment) => segment.id)
          }
        }.width('100%').height(36).margin({ top: 10 }).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off)
      }
    }.width('100%')
  }

  @Builder
  SnippetPanel() {
    Column() {
      Text('独立短代码').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
      Text('该内容不会覆盖 main.cpp。').fontSize(10).fontColor('#8E8E93').margin({ top: 3, bottom: 8 })
      TextArea({ text: this.shortCode, placeholder: '// 局部 C++ 片段' }).width('100%').height(145)
        .fontSize(12).lineHeight(20).fontFamily('monospace').fontColor('#E8ECE9').backgroundColor('#0A0A0C')
        .border({ width: 1, color: '#3A3A3D' }).borderRadius(4).onChange((value: string) => { this.shortCode = value; this.saved = false; })
    }.width('100%').backgroundColor('#161618')
  }

  @Builder
  AIPanel() {
    Column({ space: 7 }) {
      Text('AI 模式').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
      Row({ space: 7 }) {
        this.ModeButton('忠实转换', AIMode.FAITHFUL_TRANSFORM)
        this.ModeButton('可行性', AIMode.FEASIBILITY_ANALYSIS)
      }.width('100%')
      Row({ space: 7 }) {
        this.ModeButton('渐进提示', AIMode.PROGRESSIVE_HINT)
        this.ModeButton('完整解题', AIMode.FULL_SOLUTION)
      }.width('100%')
      Row() {
        Column() {
          Text('AI 未启用').fontSize(12).fontWeight(FontWeight.Bold).fontColor('#ECECED')
          Text('未配置模型服务，不生成模拟结果。').fontSize(10).fontColor('#8E8E93').margin({ top: 2 })
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Button(this.artifactHidden ? '显示结果区' : '隐藏结果区').height(32).fontSize(10)
          .fontColor('#9BE7A9').backgroundColor('#1E3A27').borderRadius(4).onClick(() => this.toggleArtifact())
      }.width('100%').margin({ top: 4 })
    }.width('100%')
  }

  @Builder
  RewritePanel() {
    Column() {
      Text('独立复写').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
      Text('复写文件与 main.cpp 分开保存。').fontSize(10).fontColor('#8E8E93').margin({ top: 3, bottom: 9 })
      Button() {
        Row({ space: 5 }) {
          this.Icon(WorkspaceIcon.CODE, 14)
          Text('打开 rewrite.cpp').fontSize(10).fontColor('#FFFFFF')
        }
      }.height(34).fontColor('#07110A').backgroundColor('#30D158').borderRadius(4)
        .onClick(() => { this.selectFile(EditorFile.REWRITE); this.activeTool = WorkspaceTool.NONE; })
    }.width('100%')
  }

  @Builder
  ReviewPanel() {
    Column() {
      Row({ space: 7 }) {
        Button('复制行').height(30).fontSize(10).fontColor('#9BE7A9').backgroundColor('#1E3A27').borderRadius(4).onClick(() => this.duplicateLine())
        Button('删除行').height(30).fontSize(10).fontColor('#FF9A94').backgroundColor('#2A1B1C').borderRadius(4).onClick(() => this.deleteLine())
        Button('格式化').height(30).fontSize(10).fontColor('#9BE7A9').backgroundColor('#1E3A27').borderRadius(4).onClick(() => this.formatDocument())
      }.width('100%').margin({ bottom: 8 })
      if (!this.isCppFile()) {
        Text('当前文件不是 C++ 文档。').fontSize(11).fontColor('#8E8E93')
      } else if (this.reviewIssues.length === 0) {
        Text('基础检查通过').fontSize(12).fontWeight(FontWeight.Bold).fontColor('#30D158')
        Text('未发现括号、入口或头文件基础问题。').fontSize(10).fontColor('#8E8E93').margin({ top: 4 })
      } else {
        Scroll() {
          Column() {
            ForEach(this.reviewIssues, (issue: ReviewIssue) => {
              Button(`第 ${issue.line} 行 · ${issue.message}`).width('100%').height(31).fontSize(10)
                .fontColor(issue.severity === 'error' ? '#FF9A94' : '#B8B8BD')
                .backgroundColor(Color.Transparent).onClick(() => this.jumpToLine(issue.line))
            }, (issue: ReviewIssue) => `${issue.line}-${issue.message}`)
          }
        }.width('100%').height(145).scrollBar(BarState.Auto)
      }
    }.width('100%')
  }

  @Builder
  SearchPanel() {
    Column() {
      Text('当前文件搜索').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
      Row({ space: 7 }) {
        TextInput({ text: this.searchQuery, placeholder: '输入关键词' }).layoutWeight(1).height(36).fontSize(11)
          .fontColor('#ECECED').placeholderColor('#6E6E73').backgroundColor('#1E1E20')
          .border({ width: 1, color: '#3A3A3D' }).borderRadius(4)
          .onChange((value: string) => { this.searchQuery = value; this.updateSearchCount(); })
        Button() {
          Row({ space: 5 }) {
            this.Icon(WorkspaceIcon.SEARCH, 13)
            Text('下一个').fontSize(10).fontColor('#FFFFFF')
          }
        }.height(36).fontColor('#07110A').backgroundColor('#30D158').borderRadius(4).onClick(() => this.jumpToNextMatch())
      }.width('100%').margin({ top: 8 })
      Text(this.searchQuery.length === 0 ? '输入关键词开始搜索。' : `找到 ${this.searchCount} 处`).fontSize(10).fontColor('#8E8E93').margin({ top: 8 })
    }.width('100%')
  }

  @Builder
  SyncPanel() {
    Column() {
      Text('保存与同步').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
      Text('本地 RDB 保存离线副本；同步连接局域网 sync-api。').fontSize(10).lineHeight(17).fontColor('#8E8E93').margin({ top: 5, bottom: 10 })
      TextInput({ text: this.syncBaseUrl, placeholder: 'http://电脑局域网IP:8787' }).width('100%').height(34).fontSize(10)
        .fontColor('#ECECED').placeholderColor('#6E6E73').backgroundColor('#1E1E20')
        .border({ width: 1, color: '#3A3A3D' }).borderRadius(4)
        .onChange((value: string) => { this.syncBaseUrl = value; this.viewModel.setSyncBaseUrl(value); })
      Row() {
        Text(this.statusLabel()).fontSize(11).fontWeight(FontWeight.Bold).fontColor(this.statusColor())
        Blank()
        Text(`v${this.viewModel.getDraft(this.selectedId)?.version ?? 0}`).fontSize(10).fontColor('#8E8E93')
      }.width('100%')
      Button() {
        Row({ space: 5 }) {
          this.Icon(WorkspaceIcon.DOCUMENT, 14)
          Text('保存当前内容').fontSize(11).fontColor('#FFFFFF')
        }
      }.width('100%').height(36).fontColor('#07110A')
        .backgroundColor('#30D158').borderRadius(4).margin({ top: 12 }).onClick(() => this.saveDraft())
      Button() {
        Row({ space: 5 }) {
          this.Icon(WorkspaceIcon.REFRESH, 14, '#9BE7A9')
          Text('立即同步').fontSize(11).fontColor('#9BE7A9')
        }
      }.width('100%').height(36)
        .backgroundColor('#1E3A27').borderRadius(4).margin({ top: 7 }).onClick(() => this.synchronize())
    }.width('100%').backgroundColor('#161618')
  }

  @Builder
  ToolPanel() {
    Column() {
      if (this.activeTool === WorkspaceTool.FILES) {
        this.FilesPanel()
      } else if (this.activeTool === WorkspaceTool.IDEA) {
        this.IdeaPanel()
      } else if (this.activeTool === WorkspaceTool.SNIPPET) {
        this.SnippetPanel()
      } else if (this.activeTool === WorkspaceTool.AI) {
        this.AIPanel()
      } else if (this.activeTool === WorkspaceTool.REWRITE) {
        this.RewritePanel()
      } else if (this.activeTool === WorkspaceTool.REVIEW) {
        this.ReviewPanel()
      } else if (this.activeTool === WorkspaceTool.SEARCH) {
        this.SearchPanel()
      } else if (this.activeTool === WorkspaceTool.SYNC) {
        this.SyncPanel()
      }
    }.width('100%').height(230).padding({ left: 14, right: 14, top: 12, bottom: 12 })
      .backgroundColor('#161618').border({ width: { top: 1 }, color: '#2A2A2D' })
  }

  @Builder
  WorkspaceDrawer() {
    Column() {
      Row() {
        Row({ space: 9 }) {
          Stack({ alignContent: Alignment.Center }) {
            Row().width(32).height(32).backgroundColor('#1E3A27').borderRadius(8)
            this.Icon(WorkspaceIcon.CODE, 17, '#9BE7A9')
          }
          Column() {
            Text('AlgoFlow IDE').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
            Text('OpenHarmony 移动端').fontSize(9).fontColor('#8E8E93').margin({ top: 2 })
          }.alignItems(HorizontalAlign.Start)
        }
        Blank()
        Button() {
          this.Icon(WorkspaceIcon.CROSS, 15, '#A7A7AD')
        }.width(32).height(32).padding({ left: 0, right: 0, top: 0, bottom: 0 })
          .backgroundColor('#242426').borderRadius(16).onClick(() => this.closeDrawer())
      }.width('100%').height(64).padding({ left: 16, right: 12 })
        .border({ width: { bottom: 1 }, color: '#2A2A2D' })

      Scroll() {
        Column({ space: 15 }) {
          Column() {
            this.DrawerSectionTitle('草稿管理')
            Button() {
              Row({ space: 7 }) {
                this.Icon(WorkspaceIcon.PLUS, 14, '#07110A')
                Text('新建思路草稿').fontSize(10).fontColor('#07110A')
              }
            }.width('100%').height(36).backgroundColor('#30D158').borderRadius(6)
              .onClick(() => { this.createDraft(); this.closeDrawer(); })
            Column({ space: 5 }) {
              ForEach(this.drafts, (draft: Draft) => {
                Button() {
                  Row() {
                    Column() {
                      Text(draft.title.length === 0 ? '未命名思路' : draft.title).fontSize(10)
                        .fontColor(draft.id === this.selectedId ? '#ECECED' : '#B8B8BD')
                      Text(`main.cpp · v${draft.version}`).fontSize(9).fontColor('#6E6E73').margin({ top: 2 })
                    }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                    Circle().width(7).height(7).fill(draft.id === this.selectedId ? '#ECECED' : '#6E6E73')
                  }
                }.width('100%').height(44).padding({ left: 10, right: 10 })
                  .backgroundColor(draft.id === this.selectedId ? '#242426' : '#1C1C1E')
                  .border({ width: 1, color: draft.id === this.selectedId ? '#5A5A5F' : '#2A2A2D' })
                  .borderRadius(6).onClick(() => { this.selectDraft(draft.id); this.closeDrawer(); })
              }, (draft: Draft) => draft.id)
            }.width('100%').margin({ top: 7 })
          }.width('100%')

          Column({ space: 6 }) {
            this.DrawerSectionTitle('文件')
            this.DrawerFileButton(EditorFile.MAIN, 'main.cpp')
            this.DrawerFileButton(EditorFile.IDEA, 'idea.md')
            this.DrawerFileButton(EditorFile.REWRITE, 'rewrite.cpp')
          }.width('100%')

          Column({ space: 6 }) {
            this.DrawerSectionTitle('AI 协作模式')
            Row({ space: 6 }) {
              this.DrawerModeButton('忠实转换', AIMode.FAITHFUL_TRANSFORM)
              this.DrawerModeButton('可行性分析', AIMode.FEASIBILITY_ANALYSIS)
            }.width('100%')
            Row({ space: 6 }) {
              this.DrawerModeButton('渐进提示', AIMode.PROGRESSIVE_HINT)
              this.DrawerModeButton('完整解题', AIMode.FULL_SOLUTION)
            }.width('100%')
            Text('当前未配置模型服务，保持 AI 结果隔离。').fontSize(9).fontColor('#8E8E93').margin({ top: 3 })
          }.width('100%')

          Column({ space: 3 }) {
            this.DrawerSectionTitle('工具')
            this.DrawerToolButton('草稿详情与标题', WorkspaceTool.FILES)
            this.DrawerToolButton('思路来源', WorkspaceTool.IDEA)
            this.DrawerToolButton('独立短代码', WorkspaceTool.SNIPPET)
            this.DrawerToolButton('独立复写', WorkspaceTool.REWRITE)
            this.DrawerToolButton('代码检查', WorkspaceTool.REVIEW)
            this.DrawerToolButton('当前文件搜索', WorkspaceTool.SEARCH)
            this.DrawerToolButton('保存与同步', WorkspaceTool.SYNC)
          }.width('100%')

          Column() {
            this.DrawerSectionTitle('同步状态')
            Row() {
              Column() {
                Text(this.statusLabel()).fontSize(11).fontWeight(FontWeight.Bold).fontColor(this.statusColor())
                Text(this.syncMessage.length === 0 ? '本地副本可继续编辑' : this.syncMessage)
                  .fontSize(9).fontColor('#8E8E93').margin({ top: 3 })
              }.alignItems(HorizontalAlign.Start).layoutWeight(1)
              Text(`v${this.viewModel.getDraft(this.selectedId)?.version ?? 0}`).fontSize(10).fontColor('#8E8E93')
            }.width('100%').padding({ left: 11, right: 11, top: 10, bottom: 10 })
              .backgroundColor('#1C1C1E').border({ width: 1, color: '#2A2A2D' }).borderRadius(7)
            Button() {
              Row({ space: 6 }) {
                this.Icon(WorkspaceIcon.REFRESH, 14, '#07110A')
                Text('立即同步').fontSize(10).fontColor('#07110A')
              }
            }.width('100%').height(34).backgroundColor('#30D158').borderRadius(6).margin({ top: 7 })
              .onClick(() => { this.closeDrawer(); this.synchronize(); })
          }.width('100%')
        }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 18 })
      }.layoutWeight(1).scrollBar(BarState.Auto)

      Row() {
        Text('IDE 工作区').fontSize(9).fontColor('#6E6E73')
        Blank()
        Text('OpenHarmony').fontSize(9).fontColor('#6E6E73')
      }.width('100%').height(42).padding({ left: 16, right: 16 })
        .border({ width: { top: 1 }, color: '#2A2A2D' })
    }.width('84%').height('100%').backgroundColor('#161618')
      .border({ width: { right: 1 }, color: '#2A2A2D' })
  }

  @Builder
  FloatingToolBar() {
    Row() {
      Button() {
        Row({ space: 6 }) {
          this.Icon(WorkspaceIcon.SOURCE, 14, '#FF9F0A')
          Text(`思路片段${this.segments.length > 0 ? ` (${this.segments.length})` : ''}`).fontSize(10).fontColor('#ECECED')
        }
      }.height(36).padding({ left: 11, right: 11 }).backgroundColor(Color.Transparent)
        .onClick(() => this.toggleTool(WorkspaceTool.IDEA))
      Blank().width(1).height(18).backgroundColor('#3A3A3D')
      Button() {
        Row({ space: 6 }) {
          Circle().width(7).height(7).fill('#79C0FF')
          Text(this.modeLabel()).fontSize(10).fontColor('#ECECED')
        }
      }.height(36).padding({ left: 11, right: 11 }).backgroundColor(Color.Transparent)
        .onClick(() => this.toggleTool(WorkspaceTool.AI))
      Blank().width(1).height(18).backgroundColor('#3A3A3D')
      Button(this.artifactHidden ? '显示结果' : '隐藏结果').height(36).padding({ left: 11, right: 11 })
        .fontSize(10).fontColor('#B8B8BD').backgroundColor(Color.Transparent).onClick(() => this.toggleArtifact())
    }.height(48).padding({ left: 7, right: 7 }).backgroundColor('#1E1E20')
      .border({ width: 1, color: '#3A3A3D' }).borderRadius(24)
  }

  @Builder
  IDEWorkspace() {
    Column() {
      this.TopNavigation()

      Scroll() {
        Row({ space: 3 }) {
          this.FileTab(EditorFile.MAIN, 'main.cpp')
          this.FileTab(EditorFile.IDEA, 'idea.md')
          this.FileTab(EditorFile.REWRITE, 'rewrite.cpp')
        }.padding({ left: 8, right: 8 })
      }.width('100%').height(42).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off)
        .backgroundColor('#0D0D0F')

      this.EditorHeader()
      this.EditorSurface()

      Row() {
        Text(this.activeFile).fontSize(9).fontColor('#8E8E93')
        Blank()
        Text(`Ln ${this.activeLine + 1}, Col ${this.activeColumn + 1}`).fontSize(9).fontColor('#8E8E93')
        Text('UTF-8').fontSize(9).fontColor('#8E8E93').margin({ left: 12 })
        Text(this.modeLabel()).fontSize(9).fontColor('#9BE7A9').margin({ left: 12 })
      }.width('100%').height(28).padding({ left: 12, right: 12 }).backgroundColor('#111113')
        .border({ width: { top: 1 }, color: '#242426' })

      if (this.activeTool !== WorkspaceTool.NONE) {
        this.ToolPanel()
      }

      Row() {
        Blank().layoutWeight(1)
        this.FloatingToolBar()
        Blank().layoutWeight(1)
      }.width('100%').height(68).padding({ top: 8, bottom: 8, left: 8, right: 8 })
        .backgroundColor('#0A0A0C')
    }.width('100%').height('100%').backgroundColor('#0A0A0C')
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      this.IDEWorkspace()
      if (this.drawerOpen) {
        Column().width('100%').height('100%').backgroundColor('#99000000').onClick(() => this.closeDrawer())
        this.WorkspaceDrawer()
      }
    }.width('100%').height('100%').backgroundColor('#0A0A0C')
  }
}

function reviewCpp(source: string): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const lines = source.split('\n');
  if (!/\bmain\s*\(/.test(source)) issues.push(new ReviewIssue(1, 'warning', '未发现 main() 入口函数'));
  if (!/^\s*#\s*include\b/m.test(source)) issues.push(new ReviewIssue(1, 'info', '当前文件没有 #include'));
  const includes = new Set<string>();
  lines.forEach((line: string, index: number) => {
    const match = line.match(/^\s*#\s*include\s*([<"].*[>"])/);
    const header = match === null ? '' : match[1];
    if (header.length > 0) {
      if (includes.has(header)) issues.push(new ReviewIssue(index + 1, 'warning', `重复引入 ${header}`));
      includes.add(header);
    }
  });
  const stack: BracketEntry[] = [];
  let blockComment = false;
  lines.forEach((line: string, lineIndex: number) => {
    let stringQuote = '';
    for (let index = 0; index < line.length; index++) {
      const pair = line.substring(index, index + 2);
      const char = line[index];
      if (stringQuote.length === 0 && !blockComment && pair === '//') break;
      if (stringQuote.length === 0 && !blockComment && pair === '/*') { blockComment = true; index += 1; continue; }
      if (blockComment) {
        if (pair === '*/') { blockComment = false; index += 1; }
        continue;
      }
      if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
        stringQuote = stringQuote === char ? '' : (stringQuote.length === 0 ? char : stringQuote);
        continue;
      }
      if (stringQuote.length > 0) continue;
      if ('({['.includes(char)) stack.push(new BracketEntry(char, lineIndex + 1));
      if (')}]'.includes(char)) {
        const expected = char === ')' ? '(' : char === ']' ? '[' : '{';
        const top = stack.pop();
        if (top === undefined || top.char !== expected) issues.push(new ReviewIssue(lineIndex + 1, 'error', `括号不匹配：${char}`));
      }
    }
  });
  stack.forEach((entry: BracketEntry) => issues.push(new ReviewIssue(entry.line, 'error', `未闭合括号：${entry.char}`)));
  if (blockComment) issues.push(new ReviewIssue(lines.length, 'warning', '块注释未闭合'));
  return issues.sort((left: ReviewIssue, right: ReviewIssue) => left.line - right.line);
}

function tokenizeCpp(source: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const lines = source.split('\n');
  let inBlockComment = false;
  lines.forEach((line: string, lineIndex: number) => {
    let index = 0;
    while (index < line.length) {
      if (inBlockComment) {
        const end = line.indexOf('*/', index);
        if (end < 0) {
          tokens.push(new SyntaxToken(line.substring(index), '#6A9955'));
          index = line.length;
          continue;
        }
        tokens.push(new SyntaxToken(line.substring(index, end + 2), '#6A9955'));
        index = end + 2;
        inBlockComment = false;
        continue;
      }
      const pair = line.substring(index, index + 2);
      if (pair === '//') {
        tokens.push(new SyntaxToken(line.substring(index), '#6A9955'));
        index = line.length;
        continue;
      }
      if (pair === '/*') {
        const end = line.indexOf('*/', index + 2);
        if (end < 0) {
          tokens.push(new SyntaxToken(line.substring(index), '#6A9955'));
          inBlockComment = true;
          index = line.length;
          continue;
        }
        tokens.push(new SyntaxToken(line.substring(index, end + 2), '#6A9955'));
        index = end + 2;
        continue;
      }
      const char = line[index];
      if (char === '"' || char === "'") {
        const quote = char;
        let end = index + 1;
        while (end < line.length) {
          if (line[end] === quote && line[end - 1] !== '\\') {
            end += 1;
            break;
          }
          end += 1;
        }
        tokens.push(new SyntaxToken(line.substring(index, end), '#CE9178'));
        index = end;
        continue;
      }
      if (/\s/.test(char)) {
        let end = index + 1;
        while (end < line.length && /\s/.test(line[end])) end += 1;
        tokens.push(new SyntaxToken(line.substring(index, end), '#E8ECE9'));
        index = end;
        continue;
      }
      if (/[A-Za-z_]/.test(char)) {
        let end = index + 1;
        while (end < line.length && /[A-Za-z0-9_]/.test(line[end])) end += 1;
        const word = line.substring(index, end);
        tokens.push(new SyntaxToken(word, cppWordColor(word)));
        index = end;
        continue;
      }
      if (/\d/.test(char)) {
        let end = index + 1;
        while (end < line.length && /[0-9A-Fa-fxX.]/.test(line[end])) end += 1;
        tokens.push(new SyntaxToken(line.substring(index, end), '#B5CEA8'));
        index = end;
        continue;
      }
      const color = char === '#' ? '#C586C0' : '#D4D4D4';
      tokens.push(new SyntaxToken(char, color));
      index += 1;
    }
    if (lineIndex < lines.length - 1) tokens.push(new SyntaxToken('\n', '#E8ECE9'));
  });
  return tokens.length === 0 ? [new SyntaxToken('', '#E8ECE9')] : tokens;
}

function cppWordColor(word: string): string {
  if (/^(alignas|auto|bool|break|case|catch|char|class|const|continue|default|delete|double|else|false|float|for|if|include|int|long|namespace|nullptr|return|short|sizeof|static|struct|switch|template|this|throw|true|try|using|void|while)$/.test(word)) {
    return '#C586C0';
  }
  if (/^(array|deque|map|pair|queue|set|stack|string|tuple|unordered_map|unordered_set|vector)$/.test(word)) {
    return '#4EC9B0';
  }
  if (word === 'std') return '#4EC9B0';
  return '#9CDCFE';
}
