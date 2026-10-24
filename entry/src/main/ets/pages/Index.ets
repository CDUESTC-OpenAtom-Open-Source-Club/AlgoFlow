import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { AIArtifact, AIMode, AIResultStatus, CodeMapping, Draft, draftRenderKey, IdeaSegment, PseudocodeStep, SyncStatus } from '../domain/Models';
import { RdbDraftRepository } from '../platform/RdbDraftRepository';
import { SyncRunResult, SyncRunStatus } from '../platform/PhoneSyncService';
import { publishCardSnapshot } from '../platform/CardSnapshot';
import { DEBUG } from 'BuildProfile';
import { IDECapability, IDERecord, IDEState, ReviewKind, SourceCursor } from '../domain/IDEAIModels';
import { rangeOffsets } from '../domain/IDEAIContract';
import { assignRewriteLines, compareRewrite, resolveRewriteMapping, RewriteCodeLine, RewriteCompareSource, RewriteCompareStep, RewriteComparison, RewriteDiffLine,
  RewriteDiffOp, RewriteLineMapping, RewriteLineRange, RewriteMappingRecord, RewriteMappingState, RewriteMappingStatus,
  RewriteStepComparison, RewriteStepStatus, selectionLines } from '../domain/RewriteCompare';
import { PreferencesRewriteMappingStore } from '../platform/RewriteMappingStore';

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

// Idea-segment colours cycle by segment position (S1/S2/S3, S4 = S1 ...). They
// are only drawn where a real mapping to a segment exists.
const RAIL_COLORS: string[] = ['#8FBF9A', '#D9B36A', '#9DB4D4'];

class SnippetLine {
  line: number;
  text: string;
  color: string;

  constructor(line: number, text: string, color: string) {
    this.line = line;
    this.text = text;
    this.color = color;
  }
}

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
  @State aiBaseUrl: string = 'http://127.0.0.1:8788';
  @State aiLoading: boolean = false;
  @State aiMessage: string = '';
  @State aiError: boolean = false;
  @State aiResult: AIArtifact | null = null;
  @State aiRecords: IDERecord[] = [];
  @State aiStorageError: string = '';
  @State allowTestData: boolean = false;
  @State canWithdrawAI: boolean = false;
  @State drawerDraftsExpanded: boolean = false;
  @State drawerToolsExpanded: boolean = false;
  @State transformOutput: string = 'pseudocode';
  @State rewriteMappingRecord: RewriteMappingRecord | null = null;
  @State rewriteSelection: RewriteLineRange = new RewriteLineRange(1, 1);
  @State revealedCompareId: string = '';
  @State compareMessage: string = '';
  private aiRepository: RdbDraftRepository | null = null;
  private editEpoch: number = 0;

  aboutToDisappear(): void { this.viewModel.aiSession?.dispose(); }
  onPageHide(): void { this.viewModel.cancelAI(); }

  private configureAISession(): void {
    if (this.aiRepository === null) return;
    this.viewModel.configureAI(this.aiRepository.aiResults(this.allowTestData), this.allowTestData);
    const session = this.viewModel.aiSession;
    if (session === null) return;
    session.onChange = () => {
      this.aiRecords = session.records.slice();
      this.aiLoading = session.records.some(record => record.state === IDEState.LOADING);
      this.aiStorageError = session.storageError;
      this.canWithdrawAI = session.canWithdraw();
    };
    this.viewModel.selectAIContext(this.selectedId, this.activeFile);
  }

  private requestIDE(capability: IDECapability, kind: ReviewKind = ReviewKind.EXPLANATION, transformOutput: string = 'pseudocode'): void {
    this.viewModel.selectAIContext(this.selectedId, this.activeFile);
    const cursor = new SourceCursor(); cursor.line = this.activeLine + 1; cursor.char = this.activeColumn;
    this.viewModel.aiSession?.request(capability, kind, cursor, transformOutput);
  }

  private resultText(record: IDERecord): string {
    const result = this.viewModel.aiSession?.result(record);
    if (result === null || result === undefined) return record.message || record.errorCode;
    if (record.capability === IDECapability.TRANSFORM) return result.transformText;
    if (record.capability === IDECapability.COMPLETION) {
      const offsets = rangeOffsets(record.context.code, result.range);
      return `范围 ${JSON.stringify(result.range)}\n建议：\n${result.suggestion}\n来源：${result.sourceRefs.join(', ')}\n原范围：\n${record.context.code.substring(offsets[0], offsets[1])}`;
    }
    return result.diagnostics.map(item => `${diagnosticLevelLabel(item.level)} ${item.problem}\n依据：${item.basis}\n建议：${item.suggestion}\n范围：${JSON.stringify(item.range)}`).join('\n\n') || '未发现诊断项';
  }

  aboutToAppear(): void {
    this.initializeWorkspace();
  }

  private async initializeWorkspace(): Promise<void> {
    try {
      const repository = new RdbDraftRepository(getContext(this));
      this.viewModel = new DraftWorkspaceViewModel(repository, repository);
      await this.viewModel.initialize();
      this.viewModel.configureRewriteMappings(new PreferencesRewriteMappingStore(getContext(this)));
      this.aiRepository = repository;
      this.configureAISession();
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
    this.editEpoch++;
    this.viewModel.selectAIContext(this.selectedId, this.activeFile);
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
    this.aiResult = this.viewModel.getArtifact(this.selectedId, draft.aiMode) ?? null;
    this.aiError = false;
    this.aiMessage = '';
    publishCardSnapshot(getContext(this), this.drafts);
    this.saved = true;
    this.resetEditorPosition();
    this.refreshEditorFeatures();
    this.loadRewriteMapping();
  }

  private async loadRewriteMapping(): Promise<void> {
    const draftId = this.selectedId;
    const record = await this.viewModel.loadRewriteMapping(draftId);
    if (draftId === this.selectedId) this.rewriteMappingRecord = record;
  }

  // Reads @State (aiRecords, rewrite, rewriteMappingRecord), so builders that
  // call these helpers re-render when the session or partition changes.
  private compareRecord(): IDERecord | null {
    return this.viewModel.latestCompareRecord(this.aiRecords);
  }

  private compareSource(): RewriteCompareSource | null {
    const record = this.compareRecord();
    return record === null ? null : this.viewModel.compareSource(record);
  }

  private compareMapping(): RewriteMappingState {
    const record = this.compareRecord();
    return resolveRewriteMapping(this.rewriteMappingRecord, record === null ? '' : record.id, this.rewrite);
  }

  private compareHidden(): boolean {
    const record = this.compareRecord();
    return record !== null && record.hidden && this.revealedCompareId !== record.id;
  }

  private comparison(): RewriteComparison | null {
    const source = this.compareSource();
    const mapping = this.compareMapping();
    if (source === null || this.compareHidden() || mapping.status === RewriteMappingStatus.OUTDATED) return null;
    return compareRewrite(source, this.rewrite, mapping.mappings);
  }

  private async storeRewriteMapping(mappings: RewriteLineMapping[]): Promise<void> {
    const record = this.compareRecord();
    if (record === null) return;
    const draftId = this.selectedId;
    try {
      const stored = await this.viewModel.saveRewriteMapping(draftId, record.id, this.rewrite, mappings);
      if (draftId === this.selectedId) { this.rewriteMappingRecord = stored; this.compareMessage = ''; }
    } catch (error) {
      this.compareMessage = '复写划分保存失败，请检查存储空间后重试';
    }
  }

  private assignRewrite(stepId: string | null): void {
    const mapping = this.compareMapping();
    if (mapping.status === RewriteMappingStatus.OUTDATED) return;
    this.storeRewriteMapping(assignRewriteLines(mapping.mappings, this.rewriteSelection.start_line, this.rewriteSelection.end_line, stepId));
  }

  private async clearRewriteMapping(): Promise<void> {
    const draftId = this.selectedId;
    try {
      await this.viewModel.clearRewriteMapping(draftId);
      if (draftId === this.selectedId) this.rewriteMappingRecord = null;
    } catch (error) {
      this.compareMessage = '复写划分清空失败，请重试';
    }
  }

  private rewriteRangeText(stepId: string): string {
    const ranges = this.compareMapping().mappings.filter((mapping: RewriteLineMapping) => mapping.step_id === stepId)
      .map((mapping: RewriteLineMapping) => mapping.start_line === mapping.end_line ? `${mapping.start_line}` : `${mapping.start_line}-${mapping.end_line}`);
    return ranges.length > 0 ? `第 ${ranges.join('、')} 行` : '未划分';
  }

  private compareSummaryText(): string {
    const comparison = this.comparison();
    if (comparison === null) return '';
    return `一致 ${comparison.summary.same} · 有差异 ${comparison.summary.different} · 遗漏 ${comparison.summary.missing} · AI 无代码 ${comparison.summary.no_ai_code}`;
  }

  private compareRiskFlags(): string[] {
    const source = this.compareSource();
    return source === null ? [] : source.risk_flags;
  }

  private compareSteps(): RewriteCompareStep[] {
    const source = this.compareSource();
    return source === null ? [] : source.steps;
  }

  private comparisonSteps(): RewriteStepComparison[] {
    const comparison = this.comparison();
    return comparison === null ? [] : comparison.steps;
  }

  private aiUnmappedLines(): RewriteCodeLine[] {
    const comparison = this.comparison();
    return comparison === null ? [] : comparison.ai_unmapped;
  }

  private rewriteExtraLines(): RewriteCodeLine[] {
    const comparison = this.comparison();
    return comparison === null ? [] : comparison.rewrite_extra;
  }

  private canAssignRewrite(): boolean {
    return this.activeFile === EditorFile.REWRITE && this.compareMapping().status !== RewriteMappingStatus.OUTDATED;
  }

  private rewriteSelectionText(): string {
    if (this.activeFile !== EditorFile.REWRITE) return '先打开 rewrite.cpp，选中要划分的行';
    const range = this.rewriteSelection;
    return `选中复写的第 ${range.start_line}${range.end_line === range.start_line ? '' : `-${range.end_line}`} 行，归到：`;
  }

  // Session-only: shows a hidden AI result here without changing its hidden flag.
  private revealCompare(): void {
    const record = this.compareRecord();
    this.revealedCompareId = record === null ? '' : record.id;
  }

  private compareStepText(index: number): string {
    const steps = this.compareSource()?.steps ?? [];
    return index >= 1 && index <= steps.length ? steps[index - 1].step : '';
  }

  private compareProvenance(): string {
    const record = this.compareRecord();
    if (record === null) return '';
    const draft = this.viewModel.getDraft(this.selectedId);
    const current = draft === undefined || draft.version === record.context.version ? '' : `（当前 v${draft.version}）`;
    return `AI 片段基于草稿 v${record.context.version}${current} · ${record.context.mode}${record.isTestData ? ' · 测试数据' : ''}`;
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
    if (!this.viewModel.update(this.selectedId, this.title, this.idea, this.code, this.shortCode, this.rewrite)) return;
    this.editEpoch++;
    this.saved = false;
    this.syncStatus = SyncStatus.LOCAL_ONLY;
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
    if (this.activeFile === EditorFile.REWRITE) this.rewriteSelection = selectionLines(value, this.selectionStart, this.selectionEnd);
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
    this.editEpoch++;
    this.viewModel.selectAIContext(this.selectedId, file);
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
    // No change: editor edits were already persisted by updateDocument, or the
    // onChange came from assigning pulled content. Clear the "未保存" marker but
    // keep the current sync status and queue nothing.
    if (!this.viewModel.update(this.selectedId, this.title, this.idea, this.code, this.shortCode, this.rewrite)) {
      this.saved = true;
      return;
    }
    this.editEpoch++;
    const draft = this.viewModel.getDraft(this.selectedId);
    if (draft !== undefined) this.segments = draft.ideaSegments;
    this.drafts = this.viewModel.listDrafts();
    this.syncStatus = SyncStatus.LOCAL_ONLY;
    this.saved = true;
    publishCardSnapshot(getContext(this), this.drafts);
  }

  private async synchronize(): Promise<void> {
    const epoch = this.editEpoch;
    this.viewModel.setSyncBaseUrl(this.syncBaseUrl);
    this.syncStatus = SyncStatus.SYNCING;
    this.syncMessage = '正在连接 sync-api...';
    let result: SyncRunResult | undefined;
    try {
      result = await this.viewModel.synchronize();
    } catch (error) {
      this.syncStatus = SyncStatus.FAILED;
      this.syncMessage = error instanceof Error ? error.message : '同步请求失败';
      publishCardSnapshot(getContext(this), this.viewModel.listDrafts(), SyncStatus.FAILED);
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
    publishCardSnapshot(getContext(this), this.drafts, this.syncStatus);
    if (epoch !== this.editEpoch) return;
    this.selectRemoteDraftIfPlaceholder();
    const draft = this.viewModel.getDraft(this.selectedId);
    if (draft !== undefined) {
      this.title = draft.title;
      this.idea = draft.idea;
      this.code = draft.code;
      this.shortCode = draft.shortCode;
      this.rewrite = draft.rewrite;
      this.segments = draft.ideaSegments;
      this.viewModel.selectAIContext(this.selectedId, this.activeFile);
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
    this.editEpoch++;
    this.viewModel.setMode(this.selectedId, nextMode);
    this.mode = nextMode;
    this.saved = false;
    this.syncStatus = SyncStatus.LOCAL_ONLY;
    this.aiResult = this.viewModel.getArtifact(this.selectedId, nextMode) ?? null;
    this.aiError = false;
    this.aiMessage = '';
  }

  private async runAI(): Promise<void> {
    this.requestIDE(IDECapability.TRANSFORM, ReviewKind.EXPLANATION, this.transformOutput);
  }

  private toggleArtifact(): void {
    this.artifactHidden = !this.artifactHidden;
    this.viewModel.setArtifactHidden(this.selectedId, this.artifactHidden);
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

  private segmentFor(reference: string): IdeaSegment | undefined {
    return this.segments.find((segment: IdeaSegment) => segment.id === reference);
  }

  // A reference to a segment that no longer exists in idea.md is shown as such
  // instead of borrowing another segment's colour.
  private segmentLabel(reference: string): string {
    const segment = this.segmentFor(reference);
    return segment === undefined ? '来源已改' : `S${segment.position + 1}`;
  }

  private segmentColor(reference: string): string {
    const segment = this.segmentFor(reference);
    return segment === undefined ? '#3A3A3D' : railColor(segment.position);
  }

  private statusChipBackground(): string {
    if (!this.saved || this.syncStatus === SyncStatus.CONFLICT) return '#3A2C14';
    if (this.syncStatus === SyncStatus.FAILED) return '#3A1D1B';
    if (this.syncStatus === SyncStatus.SYNCING) return '#1C2A3A';
    if (this.syncStatus === SyncStatus.SYNCED) return '#1F3A27';
    return '#2A2A2D';
  }

  private statusChipText(): string {
    if (!this.saved || this.syncStatus === SyncStatus.CONFLICT) return '#FFC56B';
    if (this.syncStatus === SyncStatus.FAILED) return '#FF9A94';
    if (this.syncStatus === SyncStatus.SYNCING) return '#9CC3EE';
    if (this.syncStatus === SyncStatus.SYNCED) return '#9FE5B2';
    return '#B8B8BD';
  }

  // Snippet lines take the colour of the first idea segment of the step their
  // code_mappings entry points to; unmapped lines get no rail.
  private snippetLines(): SnippetLine[] {
    const artifact = this.aiResult;
    if (artifact === null || artifact.codeSnippet === null || artifact.codeSnippet.length === 0) return [];
    return artifact.codeSnippet.split('\n').map((text: string, index: number) => {
      const lineNumber = index + 1;
      const mapping = artifact.codeMappings.find((item: CodeMapping) =>
        lineNumber >= item.startLine && lineNumber <= item.endLine);
      const step = mapping === undefined ? undefined :
        artifact.pseudocode.find((item: PseudocodeStep) => item.id === mapping.stepId);
      const segment = step === undefined || step.sourceRefs.length === 0 ? undefined : this.segmentFor(step.sourceRefs[0]);
      return new SnippetLine(lineNumber, text, segment === undefined ? '#00000000' : railColor(segment.position));
    });
  }

  private compareRefs(stepId: string): string[] {
    const record = this.compareRecord();
    return record === null ? [] : stepSourceRefs(record.body, stepId);
  }

  private hideAndRewrite(): void {
    if (!this.artifactHidden) this.toggleArtifact();
    this.selectFile(EditorFile.REWRITE);
    this.activeTool = WorkspaceTool.NONE;
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
    Column() {
      Row({ space: 6 }) {
        Text(label).fontSize(11).fontFamily('monospace')
          .fontColor(this.activeFile === file ? '#ECECED' : '#8E8E93')
        if (!this.saved && this.activeFile === file) {
          Circle().width(6).height(6).fill('#FF9F0A')
        }
      }.height(34).alignItems(VerticalAlign.Center)
      Column().width('100%').height(2).borderRadius(1)
        .backgroundColor(this.activeFile === file ? '#ECECED' : Color.Transparent)
    }.padding({ left: 12, right: 12 }).onClick(() => this.selectFile(file))
  }

  @Builder
  ModeButton(label: string, value: AIMode) {
    Button() {
      Text(label).fontSize(11).fontColor(this.mode === value ? '#ECECED' : '#8E8E93')
    }.type(ButtonType.Normal).layoutWeight(1).height(32)
      .backgroundColor(this.mode === value ? '#2A2A2D' : Color.Transparent)
      .border({ width: 1, color: this.mode === value ? '#5A5A5F' : Color.Transparent })
      .borderRadius(8).onClick(() => this.chooseMode(value))
  }

  @Builder
  SegmentChip(reference: string) {
    Text(this.segmentLabel(reference)).height(20).padding({ left: 6, right: 6 })
      .fontSize(10).fontWeight(FontWeight.Bold)
      .fontColor(this.segmentFor(reference) === undefined ? '#ECECED' : '#1B1F1C')
      .backgroundColor(this.segmentColor(reference)).borderRadius(4)
  }

  @Builder
  StatusChip() {
    Row({ space: 5 }) {
      Circle().width(6).height(6).fill(this.statusColor())
      Text(this.statusLabel()).fontSize(10).fontColor(this.statusChipText())
    }.height(26).padding({ left: 9, right: 9 }).backgroundColor(this.statusChipBackground()).borderRadius(13)
  }

  @Builder
  DrawerSectionTitle(label: string) {
    Text(label.toUpperCase()).fontSize(10).fontWeight(FontWeight.Bold).fontColor('#8E8E93')
      .margin({ top: 4, bottom: 4 })
  }

  @Builder
  DrawerCollapsibleHeader(label: string, summary: string, expanded: boolean, onToggle: () => void) {
    Button() {
      Row({ space: 8 }) {
        Text(label).fontSize(10).fontWeight(FontWeight.Bold).fontColor('#ECECED')
        if (summary.length > 0) {
          Text(summary).fontSize(9).fontColor('#9BE7A9')
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
            .backgroundColor('#1E3A27').borderRadius(4)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        Blank()
        Text(expanded ? '收起' : '展开').fontSize(9).fontColor('#8E8E93')
      }.width('100%').alignItems(VerticalAlign.Center)
    }.type(ButtonType.Normal).width('100%').height(36).padding({ left: 11, right: 11 })
      .backgroundColor('#1C1C1E').border({ width: 1, color: expanded ? '#3E4A42' : '#2A2A2D' })
      .borderRadius(7).onClick(onToggle)
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
      Row({ space: 8 }) {
        if (value === AIMode.FAITHFUL_TRANSFORM) {
          Column().width(8).height(8).backgroundColor(RAIL_COLORS[0]).borderRadius(2)
        } else {
          this.Icon(this.modeIcon(value), 13, this.mode === value ? '#ECECED' : '#6E6E73')
        }
        Text(label).fontSize(11).fontColor(this.mode === value ? '#ECECED' : '#B8B8BD')
        Blank()
        if (value !== AIMode.FAITHFUL_TRANSFORM) {
          Text('尚未接入').fontSize(9).fontColor('#8E8E93')
            .padding({ left: 6, right: 6, top: 2, bottom: 2 }).border({ width: 1, color: '#3A3A3D' }).borderRadius(8)
        }
      }.width('100%')
    }.type(ButtonType.Normal).width('100%').height(38).padding({ left: 11, right: 11 })
      .backgroundColor(this.mode === value ? '#242426' : Color.Transparent)
      .border({ width: 1, color: this.mode === value ? '#5A5A5F' : Color.Transparent })
      .borderRadius(8).onClick(() => this.chooseMode(value))
  }

  @Builder
  TopNavigation() {
    Row({ space: 8 }) {
      Button() {
        this.Icon(WorkspaceIcon.MENU, 18, '#ECECED')
      }.width(38).height(38).padding({ left: 0, right: 0, top: 0, bottom: 0 })
        .backgroundColor('#1E1E20').borderRadius(19).onClick(() => this.openDrawer())
      Column() {
        Text(this.title.length === 0 ? '未命名思路' : this.title).fontSize(14).fontWeight(FontWeight.Bold)
          .fontColor('#ECECED').maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`v${this.viewModel.getDraft(this.selectedId)?.version ?? 0} · ${this.saved ? '已保存' : '未保存'}`)
          .fontSize(10).fontColor('#8E8E93').margin({ top: 2 })
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)
      Button() {
        Row({ space: 5 }) {
          Circle().width(6).height(6).fill(this.mode === AIMode.FAITHFUL_TRANSFORM ? '#30D158' : '#FF9F0A')
          Text(this.modeLabel()).fontSize(10).fontColor('#ECECED')
        }
      }.type(ButtonType.Normal).height(26).padding({ left: 9, right: 9 }).backgroundColor('#1E1E20')
        .border({ width: 1, color: '#3A3A3D' }).borderRadius(13)
        .onClick(() => this.toggleTool(WorkspaceTool.AI))
      Button() {
        this.StatusChip()
      }.type(ButtonType.Normal).backgroundColor(Color.Transparent).padding({ left: 0, right: 0, top: 0, bottom: 0 })
        .onClick(() => this.openTool(WorkspaceTool.SYNC))
    }.width('100%').height(58).padding({ left: 12, right: 12 })
      .backgroundColor('#111113')
  }

  @Builder
  EditorSurface() {
    Stack({ alignContent: Alignment.TopStart }) {
      Row() {
        Column() {
          Text(this.lineNumbers()).width('100%').padding({ top: 12, right: 9 })
            .fontSize(13).lineHeight(22).fontFamily('monospace').fontColor('#5A5A5F')
            .textAlign(TextAlign.End).translate({ y: -this.scrollY })
        }.width(40).height('100%').clip(true).backgroundColor('#0A0A0C')
        Blank().layoutWeight(1).height('100%').backgroundColor('#0A0A0C')
      }.width('100%').height('100%')

      // Full-row outline of the caret line, from the gutter edge to the right edge.
      Row() {
        Blank().layoutWeight(1).height(22).border({ width: 1, color: '#5A5A5F' })
          .backgroundColor('#0FFFFFFF').borderRadius(4)
      }.width('100%').height(22).padding({ left: 4, right: 4 })
        .position({ x: 0, y: 12 + this.activeLine * 22 - this.scrollY })

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
          }, (draft: Draft) => draftRenderKey(draft))
        }
      }.width('100%').height(130).scrollBar(BarState.Auto)
      TextInput({ text: this.title, placeholder: '草稿标题' }).width('100%').height(36).fontSize(11)
        .fontColor('#ECECED').placeholderColor('#6E6E73').backgroundColor('#1E1E20')
        .border({ width: 1, color: '#3A3A3D' }).borderRadius(4)
        .onChange((value: string) => { this.title = value; this.saveDraft(); })
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
        Column({ space: 6 }) {
          ForEach(this.segments, (segment: IdeaSegment) => {
            Row({ space: 8 }) {
              Text(`S${segment.position + 1}`).height(20).padding({ left: 6, right: 6 })
                .fontSize(10).fontWeight(FontWeight.Bold).fontColor('#1B1F1C')
                .backgroundColor(railColor(segment.position)).borderRadius(4)
              Text(segment.content).layoutWeight(1).fontSize(11).fontColor('#ECECED')
                .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
            }.width('100%').alignItems(VerticalAlign.Top)
          }, (segment: IdeaSegment) => `${segment.id}-${segment.position}-${segment.content}`)
        }.width('100%').margin({ top: 10 })
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
        .border({ width: 1, color: '#3A3A3D' }).borderRadius(4).onChange((value: string) => { this.shortCode = value; this.saveDraft(); })
    }.width('100%').backgroundColor('#161618')
  }

  // Bottom sheet over the dimmed editor; closing it leaves the editor size unchanged.
  @Builder
  AISheet() {
    Column() {
      Column().width(36).height(4).backgroundColor('#3A3A3D').borderRadius(2).margin({ top: 8, bottom: 4 })
      Row({ space: 8 }) {
        Text('AI 结果').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#ECECED')
        Row({ space: 5 }) {
          Circle().width(6).height(6).fill('#8E8E93')
          Text(this.aiResult !== null ? `来自 v${this.aiResult.sourceDraftVersion}` :
            `草稿 v${this.viewModel.getDraft(this.selectedId)?.version ?? 0}`).fontSize(10).fontColor('#B8B8BD')
        }.height(22).padding({ left: 8, right: 8 }).backgroundColor('#2A2A2D').borderRadius(11)
        Blank()
        Button() {
          this.Icon(WorkspaceIcon.CROSS, 14, '#A7A7AD')
        }.width(30).height(30).padding({ left: 0, right: 0, top: 0, bottom: 0 })
          .backgroundColor('#242426').borderRadius(15).onClick(() => this.toggleTool(WorkspaceTool.AI))
      }.width('100%').padding({ left: 16, right: 12, top: 4, bottom: 8 })
      Scroll() {
        Column() {
          this.AIPanel()
        }.width('100%').padding({ left: 16, right: 16, top: 4, bottom: 20 })
      }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Auto).edgeEffect(EdgeEffect.None)
    }.width('100%').height('70%').backgroundColor('#161618')
      .borderRadius({ topLeft: 24, topRight: 24 }).border({ width: { top: 1 }, color: '#2A2A2D' })
  }

  @Builder
  AIPanel() {
    Column({ space: 10 }) {
      Row({ space: 2 }) {
        this.ModeButton('忠实转换', AIMode.FAITHFUL_TRANSFORM)
        this.ModeButton('可行性', AIMode.FEASIBILITY_ANALYSIS)
        this.ModeButton('渐进提示', AIMode.PROGRESSIVE_HINT)
        this.ModeButton('完整解题', AIMode.FULL_SOLUTION)
      }.width('100%').padding(3).backgroundColor('#1E1E20').borderRadius(10)
      if (this.mode !== AIMode.FAITHFUL_TRANSFORM) {
        Text('该模式尚未接入，保持显式不可用，不会自动降级为忠实转换。').fontSize(10).fontColor('#FF9F0A')
      }
      Row({ space: 8 }) {
        Text('只翻译你的思路，不补新算法').layoutWeight(1).fontSize(10).fontColor('#8E8E93')
        Row({ space: 2 }) {
          this.OutputKindButton('伪代码', 'pseudocode')
          this.OutputKindButton('代码片段', 'code_snippet')
        }.padding(2).backgroundColor('#1E1E20').borderRadius(8)
      }.width('100%')
      if (this.transformOutput === 'code_snippet') {
        Text('代码片段只读展示，用于和 rewrite.cpp 复写对比，不会写入任何 .cpp 文件。').fontSize(10).fontColor('#8E8E93')
      }

      if (this.aiError) {
        Text(this.aiMessage).fontSize(10).lineHeight(16).fontColor('#FF9A94')
      } else if (this.aiResult !== null && !this.artifactHidden) {
        this.AIResultList()
      } else if (this.aiResult !== null) {
        Text('AI 结果已隐藏。先在 rewrite.cpp 独立复写，再到复写面板对比。').fontSize(11).lineHeight(17).fontColor('#B8B8BD')
          .width('100%').padding(12).backgroundColor('#1E1E20').borderRadius(12)
      } else if (!this.aiLoading) {
        Text(this.aiMessage.length === 0 ? '未发起转换。忠实转换严格映射思路来源，越界新增步骤将被拒绝。' : this.aiMessage)
          .fontSize(10).fontColor('#8E8E93')
      }

      if (this.aiLoading) {
        Row({ space: 8 }) {
          Text('正在请求 AI Gateway...').fontSize(10).fontColor('#79C0FF').layoutWeight(1)
          Button('取消').height(34).fontSize(11).fontColor('#FF9A94').backgroundColor('#2A1B1C').borderRadius(17)
            .onClick(() => { this.viewModel.cancelAI(); })
        }.width('100%')
      } else if (this.aiResult === null) {
        Button() {
          Row({ space: 5 }) {
            this.Icon(WorkspaceIcon.AI, 13, '#07110A')
            Text('发起忠实转换').fontSize(12).fontColor('#07110A')
          }
        }.width('100%').height(40).backgroundColor('#30D158').borderRadius(20)
          .onClick(() => this.runAI())
      } else {
        Row({ space: 6 }) {
          Button(this.artifactHidden ? '显示结果区' : '隐藏结果区').type(ButtonType.Normal).layoutWeight(1).height(40)
            .fontSize(11).fontColor('#ECECED').backgroundColor('#242426').borderRadius(20)
            .onClick(() => this.toggleArtifact())
          Button('发起忠实转换').type(ButtonType.Normal).layoutWeight(1).height(40)
            .fontSize(11).fontColor('#ECECED').backgroundColor('#242426').borderRadius(20)
            .onClick(() => this.runAI())
          Button('隐藏后复写').type(ButtonType.Normal).layoutWeight(1.3).height(40)
            .fontSize(11).fontWeight(FontWeight.Medium).fontColor('#07110A').backgroundColor('#30D158').borderRadius(20)
            .onClick(() => this.hideAndRewrite())
        }.width('100%')
      }

      Divider().color('#2A2A2D').margin({ top: 6, bottom: 2 })
      Text('代码审查与补全').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
      Text('审查只分析；局部补全接受后才保存 main.cpp，不自动同步。').fontSize(10).fontColor('#8E8E93')
      Row({ space: 6 }) {
        this.ReviewButton('解释', ReviewKind.EXPLANATION)
        this.ReviewButton('风险', ReviewKind.RISK)
        this.ReviewButton('复杂度', ReviewKind.COMPLEXITY)
      }.width('100%')
      Row({ space: 6 }) {
        Button('忠实局部补全').type(ButtonType.Normal).layoutWeight(1).height(34).fontSize(11)
          .fontColor('#ECECED').backgroundColor('#242426').borderRadius(17)
          .onClick(() => this.requestIDE(IDECapability.COMPLETION))
        Button('撤回本次补全').type(ButtonType.Normal).layoutWeight(1).height(34).fontSize(11)
          .fontColor('#ECECED').backgroundColor('#242426').borderRadius(17).enabled(this.canWithdrawAI)
          .opacity(this.canWithdrawAI ? 1 : 0.4)
          .onClick(() => { this.viewModel.aiSession?.withdraw((value: string) => this.updateDocument(value)); })
      }.width('100%')
      if (DEBUG) {
        Button(this.allowTestData ? '测试数据：已显式启用' : '启用测试数据（仅 Debug）').height(30).fontSize(10)
          .fontColor('#FFC56B').backgroundColor('#2A2618').borderRadius(15)
          .onClick(() => { this.allowTestData = !this.allowTestData; this.configureAISession(); })
      }
      if (this.aiStorageError.length > 0) {
        Text(this.aiStorageError).fontColor('#FF9A94').fontSize(10)
        Button('重试本地存储').height(30).fontSize(10).fontColor('#ECECED').backgroundColor('#242426').borderRadius(15)
          .onClick(() => { this.viewModel.aiSession?.retryStorage(); })
      }
      ForEach(this.aiRecords, (record: IDERecord) => {
        Column({ space: 5 }) {
          Text(`${record.capability}/${record.reviewKind} · ${record.state}${record.stale ? ' · 过期只读' : record.restored ? ' · 当前恢复结果（只读）' : ''}${record.isTestData ? ' · 测试数据' : ''}`)
            .fontSize(10).fontColor('#9CC3EE')
          Text(`草稿版本 ${record.context.version} · 规则 1.0.0 · ${this.viewModel.aiSession?.result(record)?.modelId ?? ''}`)
            .fontSize(9).fontFamily('monospace').fontColor('#8E8E93')
          if (!record.hidden) {
            Text(this.resultText(record)).fontSize(11).lineHeight(17).fontColor('#ECECED').copyOption(CopyOptions.LocalDevice)
          }
          Row({ space: 6 }) {
            Button(record.hidden ? '显示' : '隐藏').height(28).fontSize(10)
              .fontColor('#ECECED').backgroundColor('#2A2A2D').borderRadius(14)
              .onClick(() => this.viewModel.aiSession?.setHidden(record.id, !record.hidden))
            if (record.capability === IDECapability.COMPLETION) {
              Button('接受到 main.cpp').height(28).fontSize(10).fontColor('#07110A').backgroundColor('#30D158').borderRadius(14)
                .enabled(this.viewModel.aiSession?.canAccept(record) ?? false)
                .opacity((this.viewModel.aiSession?.canAccept(record) ?? false) ? 1 : 0.4)
                .onClick(() => { this.viewModel.aiSession?.accept(record.id, (value: string) => this.updateDocument(value)); })
              Button('拒绝').height(28).fontSize(10).fontColor('#FF9A94').backgroundColor('#2A1B1C').borderRadius(14)
                .onClick(() => this.viewModel.aiSession?.reject(record.id))
            }
          }
        }.width('100%').alignItems(HorizontalAlign.Start).padding(10).backgroundColor('#1E1E20').borderRadius(12)
      }, (record: IDERecord) => `${record.id}-${record.state}-${record.hidden}-${record.stale}`)

      Divider().color('#2A2A2D').margin({ top: 6, bottom: 2 })
      Text('AI Gateway').fontSize(11).fontWeight(FontWeight.Bold).fontColor('#ECECED')
      Text('未配置模型时返回 AI_NOT_ENABLED，不生成模拟结果。').fontSize(10).fontColor('#8E8E93')
      TextInput({ text: this.aiBaseUrl, placeholder: 'http://电脑局域网IP:8788' }).width('100%').height(34).fontSize(10)
        .fontColor('#ECECED').placeholderColor('#6E6E73').backgroundColor('#1E1E20')
        .border({ width: 1, color: '#3A3A3D' }).borderRadius(8)
        .onChange((value: string) => { this.aiBaseUrl = value; this.viewModel.setAIBaseUrl(value, this.allowTestData); })
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  ReviewButton(label: string, kind: ReviewKind) {
    Button(label).type(ButtonType.Normal).layoutWeight(1).height(34).fontSize(11)
      .fontColor('#ECECED').backgroundColor('#242426').borderRadius(17)
      .onClick(() => this.requestIDE(IDECapability.REVIEW, kind))
  }

  @Builder
  AIResultList() {
    Column({ space: 8 }) {
      Text('转换结果').fontSize(11).fontWeight(FontWeight.Bold).fontColor('#9BE7A9')
      if (this.aiResult !== null && this.aiResult.pseudocode.length > 0) {
        ForEach(this.aiResult.pseudocode, (step: PseudocodeStep, index: number) => {
          Row({ space: 10 }) {
            Text(`${index + 1}`).width(22).height(22).textAlign(TextAlign.Center).fontSize(11)
              .fontColor('#ECECED').backgroundColor('#2A2A2D').borderRadius(11)
            Column({ space: 6 }) {
              Text(step.step).fontSize(12).lineHeight(18).fontColor('#ECECED')
              Row({ space: 4 }) {
                ForEach(step.sourceRefs, (reference: string) => {
                  this.SegmentChip(reference)
                }, (reference: string) => reference)
              }
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          }.width('100%').alignItems(VerticalAlign.Top).padding(10).backgroundColor('#1E1E20').borderRadius(12)
        }, (step: PseudocodeStep) => step.id)
      } else {
        Text('（无伪代码步骤）').fontSize(10).fontColor('#8E8E93')
      }
      if (this.snippetLines().length > 0) {
        Text('代码片段 · 只读').fontSize(10).fontColor('#8E8E93')
        Column() {
          ForEach(this.snippetLines(), (line: SnippetLine) => {
            Row({ space: 6 }) {
              Text(line.line.toString().padStart(2, '0')).width(20).fontSize(10).lineHeight(18)
                .fontFamily('monospace').fontColor('#5A5A5F').textAlign(TextAlign.End)
              Column().width(3).height(18).backgroundColor(line.color)
              Text(line.text).layoutWeight(1).fontSize(11).lineHeight(18).fontFamily('monospace').fontColor('#E8ECE9')
            }.width('100%')
          }, (line: SnippetLine) => `${line.line}-${line.color}-${line.text}`)
        }.width('100%').padding(8).backgroundColor('#0A0A0C').border({ width: 1, color: '#2A2A2D' }).borderRadius(10)
      }
      if (this.aiResult !== null && this.aiResult.missingInformation.length > 0) {
        this.NoteBox('你的思路里没写', this.aiResult.missingInformation, true)
      }
      if (this.aiResult !== null && this.aiResult.assumptions.length > 0) {
        this.NoteBox('转换时的假设', this.aiResult.assumptions, false)
      }
      if (this.aiResult !== null && this.aiResult.riskFlags.length > 0) {
        this.NoteBox('AI 风险标记', this.aiResult.riskFlags, true)
      }
      if (this.aiResult !== null) {
        Text(`${this.aiResult.modelId} · rule ${this.aiResult.ruleVersion} · draft v${this.aiResult.sourceDraftVersion} · ${this.aiResult.addedAlgorithmSteps.length} added steps`)
          .fontSize(9).fontFamily('monospace').fontColor('#8E8E93')
      }
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  NoteBox(title: string, items: string[], warn: boolean) {
    Column({ space: 3 }) {
      Text(title).fontSize(11).fontWeight(FontWeight.Bold).fontColor(warn ? '#FFC56B' : '#B8B8BD')
      ForEach(items, (item: string, index: number) => {
        Text(`· ${item}`).fontSize(11).lineHeight(17).fontColor(warn ? '#F2E3B8' : '#ECECED')
      }, (item: string, index: number) => `${title}-${index}-${item}`)
    }.width('100%').alignItems(HorizontalAlign.Start).padding(10)
      .backgroundColor(warn ? '#2A2618' : '#1E1E20').borderRadius(12)
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
      this.RewriteComparePanel()
    }.width('100%')
  }

  @Builder
  OutputKindButton(label: string, kind: string) {
    Button(label).type(ButtonType.Normal).height(26).padding({ left: 10, right: 10 }).fontSize(10)
      .fontColor(this.transformOutput === kind ? '#ECECED' : '#8E8E93')
      .backgroundColor(this.transformOutput === kind ? '#2A2A2D' : Color.Transparent).borderRadius(6)
      .onClick(() => { this.transformOutput = kind; })
  }

  @Builder
  RewriteComparePanel() {
    Column({ space: 6 }) {
      Text('复写对比').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#ECECED')
      if (this.compareSource() === null) {
        Text('当前模式还没有 AI 代码片段。在 AI 面板把输出切到“代码片段”并发起忠实转换。伪代码不参与对比。')
          .fontSize(10).lineHeight(16).fontColor('#8E8E93')
      } else {
        Text(this.compareProvenance()).fontSize(9).fontColor('#8E8E93')
        Text('划分只保存在本机，不同步到其他设备。').fontSize(9).fontColor('#8E8E93')
        if (this.compareMessage.length > 0) {
          Text(this.compareMessage).fontSize(10).fontColor('#FF9A94')
        }
        if (this.compareMapping().status === RewriteMappingStatus.OUTDATED) {
          Text('rewrite.cpp 在划分后改过，原有行号可能错位。核对下面的行范围后确认，或清空重新划分。')
            .fontSize(10).lineHeight(16).fontColor('#FFD60A')
          Row({ space: 7 }) {
            Button('划分仍然有效').height(30).fontSize(10).fontColor('#9BE7A9').backgroundColor('#1E3A27').borderRadius(4)
              .onClick(() => { this.storeRewriteMapping(this.compareMapping().mappings); })
            Button('清空划分').height(30).fontSize(10).fontColor('#FF9A94').backgroundColor('#2A1B1C').borderRadius(4)
              .onClick(() => { this.clearRewriteMapping(); })
          }
        }
        Text(this.rewriteSelectionText()).fontSize(10).fontColor('#ECECED')
        Scroll() {
          Row({ space: 6 }) {
            ForEach(this.compareSteps(), (step: RewriteCompareStep, index: number) => {
              Button(`步骤 ${index + 1}`).height(30).fontSize(10).fontColor('#9BE7A9').backgroundColor('#1E3A27').borderRadius(4)
                .enabled(this.canAssignRewrite())
                .onClick(() => this.assignRewrite(step.id))
            }, (step: RewriteCompareStep) => step.id)
            Button('移出步骤').height(30).fontSize(10).fontColor('#B8B8BD').backgroundColor('#242426').borderRadius(4)
              .enabled(this.canAssignRewrite())
              .onClick(() => this.assignRewrite(null))
          }
        }.width('100%').height(36).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off)
        if (this.compareHidden()) {
          Text('AI 内容已隐藏').fontSize(9).fontColor('#B8B8BD').padding({ left: 8, right: 8, top: 2, bottom: 2 })
            .border({ width: 1, color: '#3A3A3D' }).borderRadius(10)
          Text('AI 结果已隐藏。划分时只显示步骤编号，不显示步骤内容和 AI 代码。').fontSize(10).lineHeight(16).fontColor('#8E8E93')
          ForEach(this.compareSteps(), (step: RewriteCompareStep, index: number) => {
            Text(`步骤 ${index + 1}：复写 ${this.rewriteRangeText(step.id)}`).fontSize(10).fontColor('#ECECED')
          }, (step: RewriteCompareStep) => `hidden-${step.id}-${this.rewriteRangeText(step.id)}`)
          Button('开始对比').height(36).fontSize(11).fontColor('#07110A').backgroundColor('#30D158').borderRadius(18)
            .onClick(() => { this.revealCompare(); })
          Text('开始对比只在本页显示 AI 内容，不会改变结果的隐藏状态。').fontSize(9).fontColor('#8E8E93')
        } else if (this.comparison() === null) {
          ForEach(this.compareSteps(), (step: RewriteCompareStep, index: number) => {
            Row({ space: 6 }) {
              ForEach(this.compareRefs(step.id), (reference: string) => {
                this.SegmentChip(reference)
              }, (reference: string) => `${step.id}-${reference}`)
              Text(`步骤 ${index + 1}：${step.step} · 复写 ${this.rewriteRangeText(step.id)}`).layoutWeight(1)
                .fontSize(10).fontColor('#ECECED')
            }.width('100%')
          }, (step: RewriteCompareStep) => `outdated-${step.id}-${this.rewriteRangeText(step.id)}`)
        } else {
          Text(this.compareSummaryText()).fontSize(10).fontWeight(FontWeight.Bold).fontColor('#ECECED')
          Column({ space: 3 }) {
            Text('AI 风险标记').fontSize(10).fontWeight(FontWeight.Bold).fontColor('#FFD60A')
            if (this.compareRiskFlags().length > 0) {
              ForEach(this.compareRiskFlags(), (flag: string, index: number) => {
                Text(`· ${flag}`).fontSize(10).lineHeight(16).fontColor('#F2E3B8')
              }, (flag: string, index: number) => `risk-${index}-${flag}`)
            } else {
              Text('AI 未标记风险。这不代表复写或 AI 片段正确。').fontSize(10).fontColor('#B8B8BD')
            }
          }.width('100%').alignItems(HorizontalAlign.Start).padding(8).backgroundColor('#2A2618').borderRadius(4)
          ForEach(this.comparisonSteps(), (item: RewriteStepComparison) => {
            this.RewriteStepCard(item)
          }, (item: RewriteStepComparison) => `${item.step_id}-${item.status}-${JSON.stringify(item.diff)}`)
          if (this.aiUnmappedLines().length > 0) {
            Text('AI 片段中未映射到步骤的行').fontSize(10).fontWeight(FontWeight.Bold).fontColor('#ECECED')
            ForEach(this.aiUnmappedLines(), (line: RewriteCodeLine) => {
              this.RewriteDiffRow(new RewriteDiffLine(RewriteDiffOp.AI_ONLY, line.line, null, line.text))
            }, (line: RewriteCodeLine) => `ai-${line.line}-${line.text}`)
          }
          if (this.rewriteExtraLines().length > 0) {
            Text('复写新增（未划分到步骤）').fontSize(10).fontWeight(FontWeight.Bold).fontColor('#ECECED')
            ForEach(this.rewriteExtraLines(), (line: RewriteCodeLine) => {
              this.RewriteDiffRow(new RewriteDiffLine(RewriteDiffOp.REWRITE_ONLY, null, line.line, line.text))
            }, (line: RewriteCodeLine) => `rw-${line.line}-${line.text}`)
          }
        }
      }
    }.width('100%').alignItems(HorizontalAlign.Start).margin({ top: 12 })
  }

  @Builder
  RewriteStepCard(item: RewriteStepComparison) {
    Column({ space: 5 }) {
      Row({ space: 6 }) {
        ForEach(this.compareRefs(item.step_id), (reference: string) => {
          this.SegmentChip(reference)
        }, (reference: string) => `${item.step_id}-${reference}`)
        Text(`步骤 ${item.index}`).fontSize(11).fontWeight(FontWeight.Bold).fontColor('#ECECED')
        Blank()
        Text(`● ${rewriteStatusLabel(item.status)}`).fontSize(10).fontColor(rewriteStatusColor(item.status))
      }.width('100%')
      Text(this.compareStepText(item.index)).fontSize(10).fontColor('#B8B8BD')
      ForEach(item.diff, (line: RewriteDiffLine) => {
        this.RewriteDiffRow(line)
      }, (line: RewriteDiffLine) => `${item.step_id}-${line.op}-${line.ai_line}-${line.rewrite_line}`)
    }.width('100%').alignItems(HorizontalAlign.Start).padding(10).backgroundColor('#1E1E20')
      .border({ width: 1, color: '#2A2A2D' }).borderRadius(12)
  }

  @Builder
  RewriteDiffRow(line: RewriteDiffLine) {
    Text(`${rewriteDiffTag(line.op)} ${lineLabel(line.ai_line)} ${lineLabel(line.rewrite_line)}  ${line.text}`)
      .width('100%').fontSize(10).lineHeight(16).fontFamily('monospace').fontColor(rewriteDiffColor(line.op))
      .backgroundColor(rewriteDiffBackground(line.op))
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

  // The panel keeps a fixed height so the editor does not jump; content taller
  // than that (review lists, compare cards) scrolls inside it instead of being
  // drawn under the floating toolbar. AI results use the bottom sheet instead.
  @Builder
  ToolPanel() {
    Scroll() {
      Column() {
        if (this.activeTool === WorkspaceTool.FILES) {
          this.FilesPanel()
        } else if (this.activeTool === WorkspaceTool.IDEA) {
          this.IdeaPanel()
        } else if (this.activeTool === WorkspaceTool.SNIPPET) {
          this.SnippetPanel()
        } else if (this.activeTool === WorkspaceTool.REWRITE) {
          this.RewritePanel()
        } else if (this.activeTool === WorkspaceTool.REVIEW) {
          this.ReviewPanel()
        } else if (this.activeTool === WorkspaceTool.SEARCH) {
          this.SearchPanel()
        } else if (this.activeTool === WorkspaceTool.SYNC) {
          this.SyncPanel()
        }
      }.width('100%').padding({ left: 14, right: 14, top: 12, bottom: 12 })
    }.width('100%').height(230).align(Alignment.Top).scrollBar(BarState.Auto).edgeEffect(EdgeEffect.None)
      .backgroundColor('#161618').border({ width: { top: 1 }, color: '#2A2A2D' })
  }

  @Builder
  WorkspaceDrawer() {
    Column() {
      Row() {
        Row({ space: 9 }) {
          Image($r('app.media.af_logo')).width(32).height(32).objectFit(ImageFit.Contain)
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
        Column({ space: 12 }) {
          Column({ space: 6 }) {
            this.DrawerSectionTitle('文件')
            this.DrawerFileButton(EditorFile.MAIN, 'main.cpp')
            this.DrawerFileButton(EditorFile.IDEA, 'idea.md')
            this.DrawerFileButton(EditorFile.REWRITE, 'rewrite.cpp')
          }.width('100%')

          Column({ space: 6 }) {
            this.DrawerCollapsibleHeader(
              '草稿管理',
              `${this.drafts.length} 篇`,
              this.drawerDraftsExpanded,
              () => { this.drawerDraftsExpanded = !this.drawerDraftsExpanded; }
            )
            if (this.drawerDraftsExpanded) {
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
                      Text(draftStatusLabel(draft.syncStatus)).fontSize(9).fontColor(draftStatusColor(draft.syncStatus))
                    }
                  }.width('100%').height(44).padding({ left: 10, right: 10 })
                    .backgroundColor(draft.id === this.selectedId ? '#242426' : '#1C1C1E')
                    .border({ width: 1, color: draft.id === this.selectedId ? '#5A5A5F' : '#2A2A2D' })
                    .borderRadius(6).onClick(() => { this.selectDraft(draft.id); this.closeDrawer(); })
                }, (draft: Draft) => draftRenderKey(draft))
              }.width('100%')
            }
          }.width('100%')

          Column({ space: 4 }) {
            this.DrawerSectionTitle('AI 模式')
            this.DrawerModeButton('忠实转换', AIMode.FAITHFUL_TRANSFORM)
            this.DrawerModeButton('可行性分析', AIMode.FEASIBILITY_ANALYSIS)
            this.DrawerModeButton('渐进提示', AIMode.PROGRESSIVE_HINT)
            this.DrawerModeButton('完整解题', AIMode.FULL_SOLUTION)
          }.width('100%')

          Column({ space: 4 }) {
            this.DrawerCollapsibleHeader(
              '工作台工具',
              this.activeTool === WorkspaceTool.NONE ? '7 项' : '已开启',
              this.drawerToolsExpanded,
              () => { this.drawerToolsExpanded = !this.drawerToolsExpanded; }
            )
            if (this.drawerToolsExpanded) {
              Column({ space: 3 }) {
                this.DrawerToolButton('草稿详情与标题', WorkspaceTool.FILES)
                this.DrawerToolButton('思路来源', WorkspaceTool.IDEA)
                this.DrawerToolButton('独立短代码', WorkspaceTool.SNIPPET)
                this.DrawerToolButton('独立复写', WorkspaceTool.REWRITE)
                this.DrawerToolButton('代码检查', WorkspaceTool.REVIEW)
                this.DrawerToolButton('当前文件搜索', WorkspaceTool.SEARCH)
                this.DrawerToolButton('保存与同步', WorkspaceTool.SYNC)
              }.width('100%').padding({ top: 2 })
            }
          }.width('100%')

          Column({ space: 6 }) {
            this.DrawerSectionTitle('同步')
            Column({ space: 6 }) {
              this.DrawerSummaryRow('同步', this.statusLabel(), this.statusColor())
              this.DrawerSummaryRow('电脑', this.syncBaseUrl, '#B8B8BD')
              this.DrawerSummaryRow('版本', `v${this.viewModel.getDraft(this.selectedId)?.version ?? 0}`, '#B8B8BD')
              if (this.syncMessage.length > 0) {
                Text(this.syncMessage).fontSize(9).fontColor('#8E8E93').maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              }
            }.width('100%').padding({ left: 11, right: 11, top: 10, bottom: 10 }).alignItems(HorizontalAlign.Start)
              .backgroundColor('#1C1C1E').border({ width: 1, color: '#2A2A2D' }).borderRadius(10)
            Button() {
              Row({ space: 6 }) {
                this.Icon(WorkspaceIcon.REFRESH, 14, '#07110A')
                Text('立即同步').fontSize(10).fontColor('#07110A')
              }
            }.width('100%').height(36).backgroundColor('#30D158').borderRadius(18)
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
  CapsuleItem(label: string, icon: WorkspaceIcon, active: boolean, onTap: () => void) {
    Column({ space: 2 }) {
      this.Icon(icon, 15, active ? '#ECECED' : '#8E8E93')
      Text(label).fontSize(9).fontColor(active ? '#ECECED' : '#8E8E93').maxLines(1)
    }.height(44).padding({ left: 10, right: 10 }).justifyContent(FlexAlign.Center)
      .backgroundColor(active ? '#2A2A2D' : Color.Transparent).borderRadius(22)
      .onClick(onTap)
  }

  @Builder
  DrawerSummaryRow(label: string, value: string, color: string) {
    Row({ space: 8 }) {
      Text(label).width(32).fontSize(10).fontColor('#8E8E93')
      Text(value).layoutWeight(1).fontSize(10).fontColor(color).textAlign(TextAlign.End)
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
    }.width('100%')
  }

  @Builder
  FloatingToolBar() {
    Row({ space: 2 }) {
      this.CapsuleItem(`思路片段${this.segments.length > 0 ? ` (${this.segments.length})` : ''}`, WorkspaceIcon.SOURCE,
        this.activeTool === WorkspaceTool.IDEA, () => this.toggleTool(WorkspaceTool.IDEA))
      this.CapsuleItem('代码', WorkspaceIcon.FILES,
        this.activeTool === WorkspaceTool.NONE && this.activeFile === EditorFile.MAIN,
        () => { this.selectFile(EditorFile.MAIN); this.activeTool = WorkspaceTool.NONE; })
      this.CapsuleItem('AI', WorkspaceIcon.AI, this.activeTool === WorkspaceTool.AI,
        () => this.toggleTool(WorkspaceTool.AI))
      this.CapsuleItem('复写', WorkspaceIcon.CODE, this.activeTool === WorkspaceTool.REWRITE,
        () => this.toggleTool(WorkspaceTool.REWRITE))
      this.CapsuleItem('同步', WorkspaceIcon.REFRESH, this.activeTool === WorkspaceTool.SYNC,
        () => this.toggleTool(WorkspaceTool.SYNC))
    }.height(52).padding({ left: 4, right: 4 }).backgroundColor('#1E1E20')
      .border({ width: 1, color: '#3A3A3D' }).borderRadius(26)
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
        }.padding({ left: 4, right: 8 })
      }.width('100%').height(36).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off)
        .backgroundColor('#0A0A0C').border({ width: { bottom: 1 }, color: '#1E1E20' })

      this.EditorSurface()

      Row() {
        Text(this.activeFile).fontSize(9).fontFamily('monospace').fontColor('#8E8E93')
        Text(`${this.currentValue().split('\n').length} 行`).fontSize(9).fontColor('#8E8E93').margin({ left: 10 })
        if (this.isCppFile()) {
          Text(`${this.reviewIssues.length} 项检查`).fontSize(9)
            .fontColor(this.reviewIssues.length === 0 ? '#8E8E93' : '#FF9F0A').margin({ left: 10 })
            .onClick(() => this.toggleTool(WorkspaceTool.REVIEW))
        }
        Blank()
        Text(`Ln ${this.activeLine + 1}, Col ${this.activeColumn + 1}`).fontSize(9).fontFamily('monospace').fontColor('#8E8E93')
        Text('UTF-8').fontSize(9).fontColor('#8E8E93').margin({ left: 10 })
      }.width('100%').height(26).padding({ left: 12, right: 12 }).backgroundColor('#111113')
        .border({ width: { top: 1 }, color: '#1E1E20' })

      if (this.activeTool !== WorkspaceTool.NONE && this.activeTool !== WorkspaceTool.AI) {
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
      if (this.activeTool === WorkspaceTool.AI) {
        Stack({ alignContent: Alignment.Bottom }) {
          Column().width('100%').height('100%').backgroundColor('#99000000')
            .onClick(() => this.toggleTool(WorkspaceTool.AI))
          this.AISheet()
        }.width('100%').height('100%')
      }
      if (this.drawerOpen) {
        Column().width('100%').height('100%').backgroundColor('#99000000').onClick(() => this.closeDrawer())
        this.WorkspaceDrawer()
      }
    }.width('100%').height('100%').backgroundColor('#0A0A0C')
  }
}

function railColor(position: number): string {
  return RAIL_COLORS[((position % RAIL_COLORS.length) + RAIL_COLORS.length) % RAIL_COLORS.length];
}

// source_refs of one pseudocode step in a stored transform result body; the
// body was validated by parseIDEResult when it was stored.
function stepSourceRefs(body: string, stepId: string): string[] {
  try {
    const value = JSON.parse(body) as Record<string, Object>;
    if (!Array.isArray(value['pseudocode'])) return [];
    const refs: string[] = [];
    (value['pseudocode'] as Object[]).forEach((item: Object) => {
      const step = item as Record<string, Object>;
      if (String(step['id']) !== stepId || !Array.isArray(step['source_refs'])) return;
      (step['source_refs'] as Object[]).forEach((reference: Object) => { refs.push(String(reference)); });
    });
    return refs;
  } catch (error) {
    return [];
  }
}

function draftStatusLabel(status: SyncStatus): string {
  if (status === SyncStatus.SYNCED) return '已同步';
  if (status === SyncStatus.SYNCING) return '同步中';
  if (status === SyncStatus.CONFLICT) return '有冲突';
  if (status === SyncStatus.FAILED) return '同步失败';
  return '仅本地';
}

function draftStatusColor(status: SyncStatus): string {
  if (status === SyncStatus.SYNCED) return '#9FE5B2';
  if (status === SyncStatus.SYNCING) return '#9CC3EE';
  if (status === SyncStatus.CONFLICT) return '#FFC56B';
  if (status === SyncStatus.FAILED) return '#FF9A94';
  return '#8E8E93';
}

function rewriteStatusLabel(status: RewriteStepStatus): string {
  if (status === RewriteStepStatus.SAME) return '一致';
  if (status === RewriteStepStatus.DIFFERENT) return '有差异';
  if (status === RewriteStepStatus.MISSING) return '遗漏';
  return 'AI 无代码';
}

function rewriteStatusColor(status: RewriteStepStatus): string {
  if (status === RewriteStepStatus.SAME) return '#30D158';
  if (status === RewriteStepStatus.DIFFERENT) return '#FF9F0A';
  if (status === RewriteStepStatus.MISSING) return '#FF9A94';
  return '#8E8E93';
}

// Text tags keep the diff readable without relying on color alone.
function rewriteDiffTag(op: RewriteDiffOp): string {
  if (op === RewriteDiffOp.AI_ONLY) return 'AI  ';
  if (op === RewriteDiffOp.REWRITE_ONLY) return '复写';
  return '    ';
}

function rewriteDiffColor(op: RewriteDiffOp): string {
  if (op === RewriteDiffOp.AI_ONLY) return '#FFB4A9';
  if (op === RewriteDiffOp.REWRITE_ONLY) return '#9BE7A9';
  return '#ECECED';
}

function rewriteDiffBackground(op: RewriteDiffOp): string {
  if (op === RewriteDiffOp.AI_ONLY) return '#2A1B1C';
  if (op === RewriteDiffOp.REWRITE_ONLY) return '#1E3A27';
  return '#00000000';
}

function lineLabel(line: number | null): string {
  return line === null ? '  ' : line.toString().padStart(2, ' ');
}

function diagnosticLevelLabel(level: string): string {
  if (level === 'error') return '错误';
  if (level === 'warning') return '警告';
  if (level === 'hint') return '提示';
  return '信息';
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
