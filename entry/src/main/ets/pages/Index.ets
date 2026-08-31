import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { AIMode, Draft, IdeaSegment, SyncStatus } from '../domain/Models';
import { InMemoryDraftRepository } from '../platform/InMemoryDraftRepository';

enum WorkspaceTool {
  NONE = 'none', FILES = 'files', IDEA = 'idea', SNIPPET = 'snippet', AI = 'ai',
  REWRITE = 'rewrite', REVIEW = 'review', SEARCH = 'search', SYNC = 'sync'
}

enum EditorFile { MAIN = 'main.cpp', IDEA = 'idea.md', REWRITE = 'rewrite.cpp' }

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
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new InMemoryDraftRepository());
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

  aboutToAppear(): void {
    this.selectedId = this.viewModel.ensureStarterDraft();
    this.loadSelectedDraft();
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
      this.editorController.setTextSelection(safeStart, safeEnd);
      this.editorController.caretPosition(safeEnd);
    }, 60);
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

  @Builder
  FileTab(file: EditorFile, label: string) {
    Button(`${label}${!this.saved && this.activeFile === file ? ' *' : ''}`)
      .height(34).padding({ left: 11, right: 11 }).fontSize(10)
      .fontColor(this.activeFile === file ? '#F4F6F3' : '#9BA39D')
      .backgroundColor(this.activeFile === file ? '#323A36' : Color.Transparent)
      .borderRadius(4).onClick(() => this.selectFile(file))
  }

  @Builder
  ToolButton(label: string, tool: WorkspaceTool) {
    Button(label).height(36).padding({ left: 13, right: 13 }).fontSize(10)
      .fontColor(this.activeTool === tool ? '#FFFFFF' : '#3E4942')
      .backgroundColor(this.activeTool === tool ? '#4F6F5A' : Color.Transparent)
      .borderRadius(5).onClick(() => this.toggleTool(tool))
  }

  @Builder
  ModeButton(label: string, value: AIMode) {
    Button(label).layoutWeight(1).height(34).fontSize(10)
      .fontColor(this.mode === value ? '#FFFFFF' : '#344038')
      .backgroundColor(this.mode === value ? '#4F6F5A' : '#E6EBE7')
      .borderRadius(4).onClick(() => this.chooseMode(value))
  }

  @Builder
  EditorHeader() {
    Row() {
      Text(this.activeFile === EditorFile.IDEA ? 'TEXT' : 'C++').fontSize(9).fontWeight(FontWeight.Bold)
        .fontColor('#BBD2C1').backgroundColor('#34453B').borderRadius(3)
        .padding({ left: 6, right: 6, top: 3, bottom: 3 })
      Text(this.activeFile).fontSize(12).fontWeight(FontWeight.Medium).fontColor('#E9ECEA').margin({ left: 9 })
      if (!this.saved) {
        Circle().width(6).height(6).fill('#E5A875').margin({ left: 7 })
      }
      Blank()
      Text(`${this.currentValue().split('\n').length} 行`).fontSize(9).fontColor('#929B95')
      if (this.isCppFile()) {
        Text(`${this.reviewIssues.length} 项检查`).fontSize(9).fontColor('#929B95').margin({ left: 10 })
      }
    }.width('100%').height(38).padding({ left: 12, right: 12 }).backgroundColor('#202622')
  }

  @Builder
  EditorSurface() {
    Stack({ alignContent: Alignment.TopStart }) {
      Row() {
        Column() {
          Text(this.lineNumbers()).width('100%').padding({ top: 12, right: 9 })
            .fontSize(13).lineHeight(22).fontFamily('monospace').fontColor('#6F7972')
            .textAlign(TextAlign.End).translate({ y: -this.scrollY })
        }.width(40).height('100%').clip(true).backgroundColor('#1C211E')
        Blank().layoutWeight(1).height('100%').backgroundColor('#242A26')
      }.width('100%').height('100%')

      Row() {
        Blank().width(40)
        Blank().layoutWeight(1).height(22).border({ width: 1, color: '#607C68' })
          .backgroundColor('#2A332D').margin({ right: 8 })
      }.width('100%').height(22).position({ x: 0, y: 12 + this.activeLine * 22 - this.scrollY })

      Row() {
        Blank().width(40).height('100%')
        TextArea({ text: this.currentValue(), placeholder: this.placeholder(), controller: this.editorController })
          .layoutWeight(1).height('100%').padding({ top: 12, bottom: 12, left: 0, right: 8 })
          .fontSize(13).lineHeight(22).fontFamily('monospace').fontColor('#E8ECE9')
          .caretColor('#E8ECE9').selectedBackgroundColor('#46594D')
          .backgroundColor(Color.Transparent).border({ width: 0 }).borderRadius(0)
          .onTextSelectionChange((start: number, end: number) => this.updateSelection(start, end))
          .onContentScroll((_offsetX: number, offsetY: number) => { this.scrollY = this.getUIContext().px2vp(offsetY); })
          .onKeyEvent((event: KeyEvent) => this.handleEditorKey(event))
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
    }.width('100%').layoutWeight(1).clip(true).backgroundColor('#242A26')
  }

  @Builder
  FilesPanel() {
    Column({ space: 8 }) {
      Row() {
        Text('草稿').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#263129')
        Blank()
        Button('新建').height(30).fontSize(10).fontColor('#FFFFFF').backgroundColor('#4F6F5A').borderRadius(4).onClick(() => this.createDraft())
        Button('删除').height(30).fontSize(10).fontColor('#9B4F42').backgroundColor('#F4E5DF').borderRadius(4).margin({ left: 7 }).onClick(() => this.deleteDraft())
      }.width('100%')
      Scroll() {
        Column({ space: 5 }) {
          ForEach(this.drafts, (draft: Draft) => {
            Button(`${draft.title} · v${draft.version}`).width('100%').height(34).fontSize(10)
              .fontColor(draft.id === this.selectedId ? '#FFFFFF' : '#344038')
              .backgroundColor(draft.id === this.selectedId ? '#4F6F5A' : '#E9ECE9')
              .borderRadius(4).onClick(() => this.selectDraft(draft.id))
          }, (draft: Draft) => draft.id)
        }
      }.width('100%').height(130).scrollBar(BarState.Auto)
      TextInput({ text: this.title, placeholder: '草稿标题' }).width('100%').height(36).fontSize(11)
        .backgroundColor('#FFFFFF').border({ width: 1, color: '#C7CEC9' }).borderRadius(4)
        .onChange((value: string) => { this.title = value; this.saved = false; })
    }.width('100%')
  }

  @Builder
  IdeaPanel() {
    Column() {
      Text('思路来源').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#263129')
      Text('编辑 idea.md 后，每个非空行保留稳定来源 ID。').fontSize(10).fontColor('#657069').margin({ top: 3, bottom: 9 })
      Button('打开 idea.md').height(34).fontSize(10).fontColor('#FFFFFF').backgroundColor('#4F6F5A').borderRadius(4)
        .onClick(() => { this.selectFile(EditorFile.IDEA); this.activeTool = WorkspaceTool.NONE; })
      if (this.segments.length > 0) {
        Scroll() {
          Row({ space: 6 }) {
            ForEach(this.segments, (segment: IdeaSegment) => {
              Text(`S${segment.position + 1}`).height(28).padding({ left: 9, right: 9 })
                .fontSize(10).fontColor('#385443').backgroundColor('#DCE8DF').borderRadius(4)
            }, (segment: IdeaSegment) => segment.id)
          }
        }.width('100%').height(36).margin({ top: 10 }).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off)
      }
    }.width('100%')
  }

  @Builder
  SnippetPanel() {
    Column() {
      Text('独立短代码').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#263129')
      Text('该内容不会覆盖 main.cpp。').fontSize(10).fontColor('#657069').margin({ top: 3, bottom: 8 })
      TextArea({ text: this.shortCode, placeholder: '// 局部 C++ 片段' }).width('100%').height(145)
        .fontSize(12).lineHeight(20).fontFamily('monospace').fontColor('#E8ECE9').backgroundColor('#242A26')
        .borderRadius(4).onChange((value: string) => { this.shortCode = value; this.saved = false; })
    }.width('100%')
  }

  @Builder
  AIPanel() {
    Column({ space: 7 }) {
      Text('AI 模式').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#263129')
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
          Text('AI 未启用').fontSize(12).fontWeight(FontWeight.Bold).fontColor('#263129')
          Text('未配置模型服务，不生成模拟结果。').fontSize(10).fontColor('#657069').margin({ top: 2 })
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Button(this.artifactHidden ? '显示结果区' : '隐藏结果区').height(32).fontSize(10)
          .fontColor('#385443').backgroundColor('#DCE8DF').borderRadius(4).onClick(() => this.toggleArtifact())
      }.width('100%').margin({ top: 4 })
    }.width('100%')
  }

  @Builder
  RewritePanel() {
    Column() {
      Text('独立复写').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#263129')
      Text('复写文件与 main.cpp 分开保存。').fontSize(10).fontColor('#657069').margin({ top: 3, bottom: 9 })
      Button('打开 rewrite.cpp').height(34).fontSize(10).fontColor('#FFFFFF').backgroundColor('#4F6F5A').borderRadius(4)
        .onClick(() => { this.selectFile(EditorFile.REWRITE); this.activeTool = WorkspaceTool.NONE; })
    }.width('100%')
  }

  @Builder
  ReviewPanel() {
    Column() {
      Row({ space: 7 }) {
        Button('复制行').height(30).fontSize(10).fontColor('#385443').backgroundColor('#DCE8DF').borderRadius(4).onClick(() => this.duplicateLine())
        Button('删除行').height(30).fontSize(10).fontColor('#9B4F42').backgroundColor('#F4E5DF').borderRadius(4).onClick(() => this.deleteLine())
        Button('格式化').height(30).fontSize(10).fontColor('#385443').backgroundColor('#DCE8DF').borderRadius(4).onClick(() => this.formatDocument())
      }.width('100%').margin({ bottom: 8 })
      if (!this.isCppFile()) {
        Text('当前文件不是 C++ 文档。').fontSize(11).fontColor('#657069')
      } else if (this.reviewIssues.length === 0) {
        Text('基础检查通过').fontSize(12).fontWeight(FontWeight.Bold).fontColor('#4F6F5A')
        Text('未发现括号、入口或头文件基础问题。').fontSize(10).fontColor('#657069').margin({ top: 4 })
      } else {
        Scroll() {
          Column() {
            ForEach(this.reviewIssues, (issue: ReviewIssue) => {
              Button(`第 ${issue.line} 行 · ${issue.message}`).width('100%').height(31).fontSize(10)
                .fontColor(issue.severity === 'error' ? '#9B4F42' : '#4F5B53')
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
      Text('当前文件搜索').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#263129')
      Row({ space: 7 }) {
        TextInput({ text: this.searchQuery, placeholder: '输入关键词' }).layoutWeight(1).height(36).fontSize(11)
          .backgroundColor('#FFFFFF').border({ width: 1, color: '#C7CEC9' }).borderRadius(4)
          .onChange((value: string) => { this.searchQuery = value; this.updateSearchCount(); })
        Button('下一个').height(36).fontSize(10).fontColor('#FFFFFF').backgroundColor('#4F6F5A').borderRadius(4).onClick(() => this.jumpToNextMatch())
      }.width('100%').margin({ top: 8 })
      Text(this.searchQuery.length === 0 ? '输入关键词开始搜索。' : `找到 ${this.searchCount} 处`).fontSize(10).fontColor('#657069').margin({ top: 8 })
    }.width('100%')
  }

  @Builder
  SyncPanel() {
    Column() {
      Text('保存与同步').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#263129')
      Text('当前仓储只保证应用会话内保存，数据库和跨端同步尚未接入。').fontSize(10).lineHeight(17).fontColor('#657069').margin({ top: 5, bottom: 10 })
      Row() {
        Text(this.statusLabel()).fontSize(11).fontWeight(FontWeight.Bold).fontColor(this.saved ? '#4F6F5A' : '#9B4F42')
        Blank()
        Text(`v${this.viewModel.getDraft(this.selectedId)?.version ?? 0}`).fontSize(10).fontColor('#657069')
      }.width('100%')
      Button('保存当前内容').width('100%').height(36).fontSize(11).fontColor('#FFFFFF')
        .backgroundColor('#4F6F5A').borderRadius(4).margin({ top: 12 }).onClick(() => this.saveDraft())
    }.width('100%')
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
      .backgroundColor('#F5F7F4').border({ width: { top: 1 }, color: '#C7CEC9' })
  }

  build() {
    Column() {
      Row() {
        Row({ space: 9 }) {
          Text('AF').width(30).height(30).fontSize(10).fontWeight(FontWeight.Bold).textAlign(TextAlign.Center)
            .fontColor('#F5F7F4').backgroundColor('#30443A').borderRadius(5)
          Column() {
            Text(this.title.length > 18 ? `${this.title.substring(0, 18)}...` : this.title).fontSize(13).fontWeight(FontWeight.Bold).fontColor('#263129')
            Text('手机代码工作台').fontSize(9).fontColor('#657069').margin({ top: 2 })
          }.alignItems(HorizontalAlign.Start)
        }
        Blank()
        Circle().width(7).height(7).fill(this.saved ? '#4F6F5A' : '#D07A56')
        Text(this.statusLabel()).fontSize(10).fontColor('#657069').margin({ left: 6 })
      }.width('100%').height(54).padding({ left: 13, right: 13 }).backgroundColor('#F5F7F4')
        .border({ width: { bottom: 1 }, color: '#C7CEC9' })

      Scroll() {
        Row({ space: 3 }) {
          this.FileTab(EditorFile.MAIN, 'main.cpp')
          this.FileTab(EditorFile.IDEA, 'idea.md')
          this.FileTab(EditorFile.REWRITE, 'rewrite.cpp')
        }.padding({ left: 8, right: 8 })
      }.width('100%').height(42).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).backgroundColor('#1C211E')

      this.EditorHeader()
      this.EditorSurface()

      Row() {
        Text(this.activeFile).fontSize(9).fontColor('#D8E4DC')
        Blank()
        Text(`Ln ${this.activeLine + 1}, Col ${this.activeColumn + 1}`).fontSize(9).fontColor('#D8E4DC')
        Text('UTF-8').fontSize(9).fontColor('#D8E4DC').margin({ left: 12 })
        Text(this.modeLabel()).fontSize(9).fontColor('#D8E4DC').margin({ left: 12 })
      }.width('100%').height(28).padding({ left: 12, right: 12 }).backgroundColor('#4F6F5A')

      Scroll() {
        Row({ space: 2 }) {
          this.ToolButton('草稿', WorkspaceTool.FILES)
          this.ToolButton('思路', WorkspaceTool.IDEA)
          this.ToolButton('短代码', WorkspaceTool.SNIPPET)
          this.ToolButton('AI', WorkspaceTool.AI)
          this.ToolButton('复写', WorkspaceTool.REWRITE)
          this.ToolButton('检查', WorkspaceTool.REVIEW)
          this.ToolButton('搜索', WorkspaceTool.SEARCH)
          this.ToolButton('同步', WorkspaceTool.SYNC)
        }.padding({ left: 7, right: 7 })
      }.width('100%').height(48).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).backgroundColor('#F5F7F4')

      if (this.activeTool !== WorkspaceTool.NONE) {
        this.ToolPanel()
      }
    }.width('100%').height('100%').backgroundColor('#242A26')
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
