import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { AIMode, Draft, IdeaSegment, SyncStatus } from '../domain/Models';
import { InMemoryDraftRepository } from '../platform/InMemoryDraftRepository';

enum WorkspaceTool {
  NONE = 'none',
  DRAFTS = 'drafts',
  IDEA = 'idea',
  SNIPPET = 'snippet',
  AI = 'ai',
  REWRITE = 'rewrite',
  SYNC = 'sync'
}

@Entry
@Component
struct Index {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new InMemoryDraftRepository());
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
  @State activeTool: WorkspaceTool = WorkspaceTool.NONE;
  @State activeCodeLine: number = 0;
  @State editorScrollY: number = 0;

  aboutToAppear(): void {
    this.selectedId = this.viewModel.ensureStarterDraft();
    this.refreshSelectedDraft();
  }

  private refreshSelectedDraft(): void {
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
    this.activeCodeLine = 0;
    this.editorScrollY = 0;
  }

  private persistDraft(): void {
    this.viewModel.update(this.selectedId, this.title, this.idea, this.code, this.shortCode, this.rewrite);
    this.drafts = this.viewModel.listDrafts();
    const savedDraft = this.viewModel.getDraft(this.selectedId);
    if (savedDraft !== undefined) this.segments = savedDraft.ideaSegments;
    this.syncStatus = SyncStatus.LOCAL_ONLY;
  }

  private createDraft(): void {
    this.selectedId = this.viewModel.createDraft();
    this.refreshSelectedDraft();
  }

  private selectDraft(id: string): void {
    this.selectedId = id;
    this.refreshSelectedDraft();
  }

  private deleteSelectedDraft(): void {
    this.selectedId = this.viewModel.deleteDraft(this.selectedId);
    this.refreshSelectedDraft();
  }

  private chooseMode(nextMode: AIMode): void {
    this.viewModel.setMode(this.selectedId, nextMode);
    this.mode = nextMode;
    this.syncStatus = SyncStatus.LOCAL_ONLY;
  }

  private toggleArtifact(): void {
    this.viewModel.toggleArtifact(this.selectedId);
    this.artifactHidden = !this.artifactHidden;
    this.syncStatus = SyncStatus.LOCAL_ONLY;
  }

  private toggleTool(tool: WorkspaceTool): void {
    this.activeTool = this.activeTool === tool ? WorkspaceTool.NONE : tool;
  }

  private statusLabel(): string {
    switch (this.syncStatus) {
      case SyncStatus.SYNCING:
        return '同步中';
      case SyncStatus.SYNCED:
        return '已同步';
      case SyncStatus.CONFLICT:
        return '有冲突';
      case SyncStatus.FAILED:
        return '同步失败';
      default:
        return '仅本地';
    }
  }

  private modeLabel(): string {
    switch (this.mode) {
      case AIMode.FEASIBILITY_ANALYSIS:
        return '可行性分析';
      case AIMode.PROGRESSIVE_HINT:
        return '渐进提示';
      case AIMode.FULL_SOLUTION:
        return '完整解题';
      default:
        return '忠实转换';
    }
  }

  private lineNumbers(): string {
    const lineCount = Math.max(1, this.code.split('\n').length);
    const numbers: string[] = [];
    for (let index = 1; index <= lineCount; index++) {
      numbers.push(index.toString().padStart(2, '0'));
    }
    return numbers.join('\n');
  }

  private updateActiveCodeLine(selectionStart: number): void {
    const safePosition = Math.max(0, Math.min(selectionStart, this.code.length));
    this.activeCodeLine = this.code.substring(0, safePosition).split('\n').length - 1;
  }

  @Builder
  StatusIndicator() {
    Row({ space: 5 }) {
      Circle().width(7).height(7)
        .fill(this.syncStatus === SyncStatus.FAILED || this.syncStatus === SyncStatus.CONFLICT ? '#B5674D' : '#55745F')
      Text(this.statusLabel()).fontSize(10).fontColor('#5E645D')
    }
  }

  @Builder
  ToolButton(label: string, tool: WorkspaceTool) {
    Button(label)
      .height(36)
      .fontSize(11)
      .fontColor(this.activeTool === tool ? '#FFFFFF' : '#5E645D')
      .backgroundColor(this.activeTool === tool ? '#55745F' : Color.Transparent)
      .borderRadius(6)
      .padding({ left: 12, right: 12 })
      .onClick(() => this.toggleTool(tool))
  }

  @Builder
  ModeButton(label: string, value: AIMode) {
    Button(label)
      .height(36)
      .fontSize(11)
      .fontColor(this.mode === value ? '#FFFFFF' : '#252A26')
      .backgroundColor(this.mode === value ? '#55745F' : '#EEEAE1')
      .borderRadius(6)
      .layoutWeight(1)
      .margin({ right: 6, bottom: 6 })
      .onClick(() => this.chooseMode(value))
  }

  @Builder
  PanelHeader(title: string, detail: string) {
    Row() {
      Column() {
        Text(title).fontSize(14).fontWeight(FontWeight.Bold).fontColor('#252A26')
        Text(detail).fontSize(10).fontColor('#5E645D').margin({ top: 2 })
      }.alignItems(HorizontalAlign.Start)
      Blank()
      Button('关闭')
        .height(30).fontSize(10).fontColor('#5E645D').backgroundColor(Color.Transparent)
        .onClick(() => { this.activeTool = WorkspaceTool.NONE; })
    }.width('100%').margin({ bottom: 10 })
  }

  @Builder
  DraftPanel() {
    Column() {
      this.PanelHeader('草稿', '切换当前工作区或新建文件')
      Row({ space: 8 }) {
        Button('新建草稿')
          .height(34).fontSize(11).fontColor('#FFFFFF').backgroundColor('#55745F').borderRadius(6)
          .onClick(() => this.createDraft())
        Button('删除当前')
          .height(34).fontSize(11).fontColor('#B5674D').backgroundColor('#FFFFFF')
          .border({ width: 1, color: '#D7B3A6' }).borderRadius(6).onClick(() => this.deleteSelectedDraft())
      }.width('100%')
      Scroll() {
        Row({ space: 8 }) {
          ForEach(this.drafts, (draft: Draft) => {
            Button(draft.title.length > 12 ? `${draft.title.substring(0, 12)}…` : draft.title)
              .height(34).fontSize(11)
              .fontColor(this.selectedId === draft.id ? '#FFFFFF' : '#252A26')
              .backgroundColor(this.selectedId === draft.id ? '#55745F' : '#EEEAE1')
              .borderRadius(6).onClick(() => this.selectDraft(draft.id))
          }, (draft: Draft) => draft.id)
        }
      }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).width('100%').height(45).margin({ top: 10 })
      TextInput({ text: this.title, placeholder: '草稿标题' })
        .height(42).fontSize(14).backgroundColor('#FFFFFF').borderRadius(6)
        .onChange((value: string) => { this.title = value; this.persistDraft(); })
    }.width('100%')
  }

  @Builder
  IdeaPanel() {
    Column() {
      this.PanelHeader('思路', '每行生成一个稳定来源片段')
      TextArea({ text: this.idea, placeholder: '每行记录一个思路步骤' })
        .width('100%').height(110).fontSize(13).fontColor('#252A26').backgroundColor('#FFFFFF')
        .border({ width: 1, color: '#C8C9BF' }).borderRadius(6)
        .onChange((value: string) => { this.idea = value; this.persistDraft(); })
      if (this.segments.length > 0) {
        Scroll() {
          Row({ space: 7 }) {
            ForEach(this.segments, (segment: IdeaSegment) => {
              Text(`S${segment.position + 1}`)
                .height(27).fontSize(10).fontWeight(FontWeight.Bold).fontColor('#55745F')
                .backgroundColor('#DBE8DC').borderRadius(5).padding({ left: 9, right: 9 })
            }, (segment: IdeaSegment) => segment.id)
          }
        }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).width('100%').height(34).margin({ top: 7 })
      }
    }.width('100%')
  }

  @Builder
  SnippetPanel() {
    Column() {
      this.PanelHeader('短代码', '独立于 main.cpp 的 C++ 思路片段')
      TextArea({ text: this.shortCode, placeholder: '// 记录局部实现或待验证片段' })
        .width('100%').height(140).fontSize(12).fontFamily('monospace').fontColor('#F2F5F0')
        .backgroundColor('#202522').borderRadius(6)
        .onChange((value: string) => { this.shortCode = value; this.persistDraft(); })
    }.width('100%')
  }

  @Builder
  AIPanel() {
    Column() {
      this.PanelHeader('AI', `${this.modeLabel()} · 结果按模式隔离`)
      Row() {
        this.ModeButton('忠实转换', AIMode.FAITHFUL_TRANSFORM)
        this.ModeButton('可行性', AIMode.FEASIBILITY_ANALYSIS)
      }.width('100%')
      Row() {
        this.ModeButton('渐进提示', AIMode.PROGRESSIVE_HINT)
        this.ModeButton('完整解题', AIMode.FULL_SOLUTION)
      }.width('100%')
      Row() {
        Column() {
          Text('AI 未启用').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#252A26')
          Text('未配置模型服务，不生成假结果。').fontSize(10).fontColor('#5E645D').margin({ top: 3 })
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Button(this.artifactHidden ? '显示区域' : '隐藏区域')
          .height(32).fontSize(10).fontColor('#252A26').backgroundColor('#FFFFFF')
          .border({ width: 1, color: '#C8C9BF' }).borderRadius(6).onClick(() => this.toggleArtifact())
      }.width('100%').padding({ top: 10, bottom: 10, left: 11, right: 11 }).backgroundColor('#EEEAE1').borderRadius(6)
    }.width('100%')
  }

  @Builder
  RewritePanel() {
    Column() {
      this.PanelHeader('独立复写', '不会覆盖 main.cpp、思路或 AI 产物')
      TextArea({ text: this.rewrite, placeholder: '隐藏参考后，在这里独立复写' })
        .width('100%').height(140).fontSize(13).fontFamily('monospace').fontColor('#252A26')
        .backgroundColor('#FFFFFF').border({ width: 1, color: '#C8C9BF' }).borderRadius(6)
        .onChange((value: string) => { this.rewrite = value; this.persistDraft(); })
    }.width('100%')
  }

  @Builder
  SyncPanel() {
    Column() {
      this.PanelHeader('保存与同步', '当前使用内存适配器')
      Row() {
        this.StatusIndicator()
        Blank()
        Text(`草稿版本 ${this.viewModel.getDraft(this.selectedId)?.version ?? 0}`).fontSize(10).fontColor('#5E645D')
      }.width('100%')
      Text('修改已保存到当前应用会话。数据库持久化、离线队列和云同步尚未实现。')
        .width('100%').fontSize(11).fontColor('#5E645D').margin({ top: 10 })
      Button('保存当前内容')
        .height(36).fontSize(11).fontColor('#FFFFFF').backgroundColor('#55745F').borderRadius(6)
        .margin({ top: 12 }).onClick(() => this.persistDraft())
    }.width('100%')
  }

  @Builder
  ActiveToolPanel() {
    Column() {
      if (this.activeTool === WorkspaceTool.DRAFTS) {
        this.DraftPanel()
      } else if (this.activeTool === WorkspaceTool.IDEA) {
        this.IdeaPanel()
      } else if (this.activeTool === WorkspaceTool.SNIPPET) {
        this.SnippetPanel()
      } else if (this.activeTool === WorkspaceTool.AI) {
        this.AIPanel()
      } else if (this.activeTool === WorkspaceTool.REWRITE) {
        this.RewritePanel()
      } else if (this.activeTool === WorkspaceTool.SYNC) {
        this.SyncPanel()
      }
    }
    .width('100%').height(245).padding({ top: 12, bottom: 12, left: 14, right: 14 })
    .backgroundColor('#FBF9F4').border({ width: { top: 1 }, color: '#C8C9BF' })
  }

  build() {
    Column() {
      Row() {
        Row({ space: 8 }) {
          Text('AF').width(30).height(30).textAlign(TextAlign.Center).fontSize(10).fontWeight(FontWeight.Bold)
            .fontColor('#FFFFFF').backgroundColor('#252A26').borderRadius(6)
          Column() {
            Text(this.title.length > 18 ? `${this.title.substring(0, 18)}…` : this.title)
              .fontSize(14).fontWeight(FontWeight.Bold).fontColor('#252A26')
            Text('手机代码工作台').fontSize(9).fontColor('#5E645D').margin({ top: 2 })
          }.alignItems(HorizontalAlign.Start)
        }
        Blank()
        this.StatusIndicator()
      }
      .width('100%').height(56).padding({ left: 14, right: 14 }).backgroundColor('#FBF9F4')
      .border({ width: { bottom: 1 }, color: '#C8C9BF' })

      Row() {
        Row({ space: 8 }) {
          Text('C++').fontSize(9).fontWeight(FontWeight.Bold).fontColor('#55745F')
            .backgroundColor('#DBE8DC').borderRadius(4).padding({ left: 6, right: 6, top: 3, bottom: 3 })
          Text('main.cpp').fontSize(12).fontWeight(FontWeight.Medium).fontColor('#252A26')
          Circle().width(6).height(6).fill('#55745F')
        }
        Blank()
        Text(`${this.code.split('\n').length} 行`).fontSize(9).fontColor('#5E645D')
      }
      .width('100%').height(40).padding({ left: 14, right: 14 }).backgroundColor('#EEEAE1')

      Stack({ alignContent: Alignment.TopStart }) {
        Row() {
          Column() {
            Text(this.lineNumbers())
              .width('100%').padding({ top: 12, right: 10 }).textAlign(TextAlign.End)
              .fontSize(13).lineHeight(22).fontFamily('monospace').fontColor('#68736B')
              .translate({ y: -this.editorScrollY })
          }
          .width(30).height('100%').clip(true).backgroundColor('#1A1F1C')
          Blank().layoutWeight(1).height('100%').backgroundColor('#202522')
        }.width('100%').height('100%')

        Row() {
          Blank().width(30)
          Blank().layoutWeight(1).height(22)
            .border({ width: 1, color: '#78947E' }).borderRadius(2).margin({ right: 10 })
        }
        .width('100%').height(22)
        .position({ x: 0, y: 12 + this.activeCodeLine * 22 - this.editorScrollY })

        Row() {
          Blank().width(30).height('100%')
          TextArea({ text: this.code, placeholder: '// 在 main.cpp 中继续编辑' })
            .layoutWeight(1).height('100%').fontSize(13).lineHeight(22).fontFamily('monospace').fontColor('#F2F5F0')
            .backgroundColor(Color.Transparent).border({ width: 0 }).borderRadius(0)
            .padding({ top: 12, bottom: 12, left: 0, right: 10 })
            .selectedBackgroundColor('#45604D')
            .onTextSelectionChange((selectionStart: number) => this.updateActiveCodeLine(selectionStart))
            .onContentScroll((_totalOffsetX: number, totalOffsetY: number) => {
              this.editorScrollY = this.getUIContext().px2vp(totalOffsetY);
            })
            .onChange((value: string) => { this.code = value; this.persistDraft(); })
        }.width('100%').height('100%')
      }
      .width('100%').layoutWeight(1).clip(true).backgroundColor('#202522')

      Row() {
        Text('main.cpp').fontSize(9).fontColor('#D8E2DB')
        Blank()
        Text(this.modeLabel()).fontSize(9).fontColor('#D8E2DB')
        Text('UTF-8').fontSize(9).fontColor('#D8E2DB').margin({ left: 12 })
      }
      .width('100%').height(28).padding({ left: 13, right: 13 }).backgroundColor('#55745F')

      Scroll() {
        Row({ space: 2 }) {
          this.ToolButton('草稿', WorkspaceTool.DRAFTS)
          this.ToolButton('思路', WorkspaceTool.IDEA)
          this.ToolButton('短代码', WorkspaceTool.SNIPPET)
          this.ToolButton('AI', WorkspaceTool.AI)
          this.ToolButton('复写', WorkspaceTool.REWRITE)
          this.ToolButton('同步', WorkspaceTool.SYNC)
        }.padding({ left: 8, right: 8 })
      }
      .scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off)
      .width('100%').height(50).backgroundColor('#FBF9F4')

      if (this.activeTool !== WorkspaceTool.NONE) {
        this.ActiveToolPanel()
      }
    }
    .width('100%').height('100%').backgroundColor('#202522')
  }
}
