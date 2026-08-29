import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { AIMode, Draft, SyncStatus } from '../domain/Models';
import { InMemoryDraftRepository } from '../platform/InMemoryDraftRepository';
import { DisabledAIProvider } from '../platform/DisabledAIProvider';
import { LocalSyncEngine } from '../platform/LocalSyncEngine';
import { DraftListBar } from '../components/DraftListBar';
import { EditorsPanel } from '../components/EditorsPanel';
import { AIModePanel } from '../components/AIModePanel';
import { AIResultArea } from '../components/AIResultArea';
import { SyncStatusBar } from '../components/SyncStatusBar';

/**
 * 主页：组装用户闭环流程。
 * 依赖方向：Page -> ViewModel -> Repository / AIProvider / SyncPort。
 * 页面不直接访问 RDB、网络或 AI SDK。
 */
@Entry
@Component
struct Index {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(
    new InMemoryDraftRepository(), new DisabledAIProvider(), new LocalSyncEngine(), 'phone-local');

  @State drafts: Draft[] = [];
  @State selectedId: string = '';
  @State title: string = '';
  @State idea: string = '';
  @State code: string = '';
  @State rewrite: string = '';
  @State mode: AIMode = AIMode.FAITHFUL_TRANSFORM;
  @State artifactHidden: boolean = false;
  @State syncStatus: SyncStatus = SyncStatus.LOCAL_ONLY;
  @State hasConflict: boolean = false;
  @State aiLoading: boolean = false;
  @State syncRunning: boolean = false;
  @State aiMessage: string = '';
  @State aiError: string = '';

  aboutToAppear(): void {
    this.selectedId = this.viewModel.ensureStarterDraft();
    this.refresh();
  }

  private refresh(): void {
    this.drafts = this.viewModel.listDrafts();
    const draft = this.viewModel.getDraft(this.selectedId);
    if (draft === undefined) {
      return;
    }
    this.title = draft.title;
    this.idea = draft.ideaText;
    this.code = this.viewModel.getUserCodeText(this.selectedId);
    this.rewrite = this.viewModel.getRewriteText(this.selectedId);
    this.artifactHidden = draft.artifactHidden;
    this.syncStatus = draft.syncStatus;
    this.hasConflict = this.viewModel.hasConflict(this.selectedId);
    this.aiLoading = this.viewModel.aiLoading;
    this.syncRunning = this.viewModel.syncRunning;
    this.aiMessage = this.viewModel.lastInfo;
    this.aiError = this.viewModel.lastError;
  }

  private save(): void {
    this.viewModel.update(this.selectedId, this.title, this.idea, this.code, this.rewrite);
    this.syncStatus = SyncStatus.LOCAL_ONLY;
  }

  private chooseMode(mode: AIMode): void {
    this.mode = mode;
  }

  private async generate(): Promise<void> {
    await this.viewModel.requestAI(this.selectedId, this.mode);
    this.refresh();
  }

  private async doSync(): Promise<void> {
    await this.viewModel.syncAll();
    this.refresh();
  }

  private toggleArtifact(): void {
    this.viewModel.toggleArtifact(this.selectedId);
    this.refresh();
  }

  private modeLabel(mode: AIMode): string {
    if (mode === AIMode.FAITHFUL_TRANSFORM) {
      return '忠实转换';
    }
    if (mode === AIMode.FEASIBILITY_ANALYSIS) {
      return '可行性分析';
    }
    if (mode === AIMode.PROGRESSIVE_HINT) {
      return '渐进提示';
    }
    return '完整解题';
  }

  build() {
    Column() {
      Row() {
        Text('AF')
          .width(30).height(30).textAlign(TextAlign.Center).fontSize(11).fontWeight(FontWeight.Bold)
          .fontColor('#FFFFFF').backgroundColor('#17201D').borderRadius(6)
        Column() {
          Text('AlgoFlow').fontSize(15).fontWeight(FontWeight.Bold)
          Text('算法随想').fontSize(10).fontColor('#697570')
        }.alignItems(HorizontalAlign.Start).margin({ left: 9 })
        Blank()
        Text('手机端').fontSize(11).fontColor('#087F68')
      }
      .width('100%').height(58).padding({ left: 16, right: 16 })
      .border({ width: { bottom: 1 }, color: '#D9E1DD' })

      Scroll() {
        Column() {
          DraftListBar({
            drafts: this.drafts,
            selectedId: this.selectedId,
            onSelect: (id: string): void => {
              this.selectedId = id;
              this.refresh();
            },
            onCreate: (): void => {
              this.selectedId = this.viewModel.createDraft();
              this.refresh();
            }
          })

          EditorsPanel({
            title: this.title,
            idea: this.idea,
            code: this.code,
            rewrite: this.rewrite,
            onTitleChange: (v: string): void => {
              this.title = v;
              this.save();
            },
            onIdeaChange: (v: string): void => {
              this.idea = v;
              this.save();
            },
            onCodeChange: (v: string): void => {
              this.code = v;
              this.save();
            },
            onRewriteChange: (v: string): void => {
              this.rewrite = v;
              this.save();
            }
          })

          SyncStatusBar({
            syncStatus: this.syncStatus,
            running: this.syncRunning,
            onSync: (): void => {
              this.doSync();
            },
            onCancel: (): void => {
              this.viewModel.cancelSync();
              this.refresh();
            }
          })

          Divider().color('#D9E1DD').margin({ top: 20, bottom: 20 })

          AIModePanel({
            mode: this.mode,
            onSelect: (m: AIMode): void => {
              this.chooseMode(m);
            }
          })

          AIResultArea({
            modeLabel: this.modeLabel(this.mode),
            hidden: this.artifactHidden,
            loading: this.aiLoading,
            message: this.aiMessage,
            error: this.aiError,
            hasConflict: this.hasConflict,
            onToggleArtifact: (): void => {
              this.toggleArtifact();
            },
            onGenerate: (): void => {
              this.generate();
            },
            onCancel: (): void => {
              this.viewModel.cancelAI();
              this.refresh();
            },
            onResolveServer: (): void => {
              this.viewModel.resolveConflict(this.selectedId, true);
              this.refresh();
            },
            onResolveLocal: (): void => {
              this.viewModel.resolveConflict(this.selectedId, false);
              this.refresh();
            }
          })

          Button('删除草稿')
            .height(36).fontSize(12).fontColor('#A33A3A').backgroundColor('#FFFFFF')
            .border({ width: 1, color: '#E1BCBC' }).borderRadius(5).margin({ top: 22, bottom: 36 })
            .onClick((): void => {
              this.selectedId = this.viewModel.deleteDraft(this.selectedId);
              this.refresh();
            })
        }
        .width('100%').padding({ left: 18, right: 18 }).alignItems(HorizontalAlign.Start)
      }
      .layoutWeight(1).scrollBar(BarState.Auto)
    }
    .width('100%').height('100%').backgroundColor('#FFFFFF')
  }
}
