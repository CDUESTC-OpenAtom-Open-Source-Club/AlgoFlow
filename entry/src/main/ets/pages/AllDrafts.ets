import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { Draft, SyncStatus } from '../domain/Models';
import { RdbDraftRepository } from '../platform/RdbDraftRepository';
import { ResourceIcon, ResourceIconName } from '../components/ResourceIcon';
import { goBack, openEditor } from '../navigation/AppRoutes';

enum DraftFilter {
  ALL = 'all',
  SYNCED = 'synced',
  LOCAL = 'local',
  CONFLICT = 'conflict',
  ARCHIVED = 'archived'
}

@Entry
@Component
struct AllDrafts {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new RdbDraftRepository(getContext(this)));

  @State drafts: Draft[] = [];
  @State filter: string = DraftFilter.ALL;
  @State ready: boolean = false;
  @State failed: boolean = false;
  @State message: string = '';

  aboutToAppear(): void {
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const repository = new RdbDraftRepository(getContext(this));
      this.viewModel = new DraftWorkspaceViewModel(repository, repository);
      await this.viewModel.initialize();
      this.drafts = this.viewModel.listAllDrafts();
      this.ready = true;
    } catch (error) {
      this.failed = true;
      this.message = '草稿列表加载失败，请重试';
      console.error(`[AlgoFlow] AllDrafts initialization failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private filteredDrafts(): Draft[] {
    if (this.filter === DraftFilter.SYNCED) {
      return this.drafts.filter((draft: Draft) => draft.syncStatus === SyncStatus.SYNCED);
    }
    if (this.filter === DraftFilter.LOCAL) {
      return this.drafts.filter((draft: Draft) =>
        draft.syncStatus !== SyncStatus.SYNCED && draft.syncStatus !== SyncStatus.CONFLICT && !draft.archived);
    }
    if (this.filter === DraftFilter.CONFLICT) {
      return this.drafts.filter((draft: Draft) => draft.syncStatus === SyncStatus.CONFLICT);
    }
    if (this.filter === DraftFilter.ARCHIVED) {
      return this.drafts.filter((draft: Draft) => draft.archived);
    }
    return this.drafts.filter((draft: Draft) => !draft.archived);
  }

  private refresh(): void {
    this.drafts = this.viewModel.listAllDrafts();
  }

  private async openDraft(draftId: string): Promise<void> {
    await openEditor(draftId);
  }

  private archiveDraft(draftId: string): void {
    this.viewModel.archiveDraft(draftId);
    this.refresh();
    this.message = '草稿已归档';
  }

  private restoreDraft(draftId: string): void {
    this.viewModel.restoreDraft(draftId);
    this.refresh();
    this.message = '草稿已恢复';
  }

  private deleteDraft(draftId: string): void {
    this.viewModel.deleteDraft(draftId);
    this.refresh();
    this.message = '草稿已删除，仍保留同步墓碑';
  }

  private statusLabel(draft: Draft): string {
    if (draft.archived) return '已归档';
    if (draft.syncStatus === SyncStatus.SYNCED) return '已同步';
    if (draft.syncStatus === SyncStatus.SYNCING) return '同步中';
    if (draft.syncStatus === SyncStatus.CONFLICT) return '有冲突';
    if (draft.syncStatus === SyncStatus.FAILED) return '同步失败';
    return '仅本地';
  }

  private statusColor(draft: Draft): string {
    if (draft.archived) return '#61758A';
    if (draft.syncStatus === SyncStatus.SYNCED) return '#55745F';
    if (draft.syncStatus === SyncStatus.CONFLICT || draft.syncStatus === SyncStatus.FAILED) return '#B5674D';
    return '#A87732';
  }

  private summary(draft: Draft): string {
    const ideaLine = draft.idea.split('\n').find((line: string) => line.trim().length > 0);
    if (ideaLine !== undefined) return ideaLine.trim();
    if (draft.code.trim().length > 0) return '已有 main.cpp 代码内容';
    return '从一个还不完整的想法开始';
  }

  private filterLabel(filter: string): string {
    if (filter === DraftFilter.SYNCED) return '已同步';
    if (filter === DraftFilter.LOCAL) return '仅本地';
    if (filter === DraftFilter.CONFLICT) return '有冲突';
    if (filter === DraftFilter.ARCHIVED) return '已归档';
    return '全部';
  }

  @Builder
  FilterChip(label: string, value: string) {
    Text(label).fontSize(11).fontWeight(this.filter === value ? FontWeight.Bold : FontWeight.Medium)
      .fontColor(this.filter === value ? '#FFFFFF' : '#68736C')
      .padding({ left: 14, right: 14, top: 7, bottom: 7 })
      .backgroundColor(this.filter === value ? '#55745F' : '#EDF1ED').borderRadius(16)
      .onClick(() => {
        this.filter = value;
      });
  }

  @Builder
  DraftRow(draft: Draft) {
    Column({ space: 8 }) {
      Row({ space: 10 }) {
        Column({ space: 5 }) {
          Row({ space: 6 }) {
            Circle().width(7).height(7).fill(this.statusColor(draft))
            Text(this.statusLabel(draft)).fontSize(10).fontWeight(FontWeight.Bold).fontColor(this.statusColor(draft))
            Text(`· v${draft.version}`).fontSize(10).fontColor('#8A938D')
          }
          Text(draft.title).fontSize(15).fontWeight(FontWeight.Bold).fontColor('#253029')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.summary(draft)).fontSize(11).fontColor('#68736C')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)

        Button() {
          ResourceIcon({ name: ResourceIconName.CODE, iconSize: 16, tint: '#55745F' })
        }.type(ButtonType.Normal).width(34).height(34).backgroundColor('#EEF6F3').borderRadius(10)
          .onClick(() => { this.openDraft(draft.id); })
      }.width('100%').alignItems(VerticalAlign.Top)

      Row() {
        if (draft.archived) {
          Button('恢复')
            .height(28).fontSize(11).fontColor('#55745F').backgroundColor(Color.Transparent)
            .onClick(() => { this.restoreDraft(draft.id); })
        } else {
          Button('归档')
            .height(28).fontSize(11).fontColor('#61758A').backgroundColor(Color.Transparent)
            .onClick(() => { this.archiveDraft(draft.id); })
        }
        Button('删除')
          .height(28).fontSize(11).fontColor('#B5674D').backgroundColor(Color.Transparent)
          .onClick(() => { this.deleteDraft(draft.id); })
        Blank()
      }.width('100%')
    }.width('100%').padding(14).backgroundColor('#FFFFFF')
      .border({ width: 1, color: '#E2E8E3' }).borderRadius(16);
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .height(34).fontSize(12).fontColor('#55745F').backgroundColor(Color.Transparent)
          .onClick(() => { goBack(); })
        Blank()
        Text('全部草稿').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#253029')
        Blank()
        Row().width(44)
      }.width('100%').padding({ left: 14, right: 14, top: 16, bottom: 8 })

      Scroll() {
        Row({ space: 8 }) {
          this.FilterChip('全部', DraftFilter.ALL)
          this.FilterChip('已同步', DraftFilter.SYNCED)
          this.FilterChip('仅本地', DraftFilter.LOCAL)
          this.FilterChip('有冲突', DraftFilter.CONFLICT)
          this.FilterChip('已归档', DraftFilter.ARCHIVED)
        }.padding({ left: 20, right: 20 })
      }.scrollable(ScrollDirection.Horizontal).width('100%').scrollBar(BarState.Off).margin({ bottom: 12 })

      Scroll() {
        Column({ space: 12 }) {
          if (!this.ready && !this.failed) {
            Text('正在加载草稿…').fontSize(12).fontColor('#8A938D').margin({ top: 40 })
          } else if (this.failed) {
            Column({ space: 12 }) {
              Text(this.message).fontSize(13).fontWeight(FontWeight.Bold).fontColor('#B5674D')
              Button('重新加载')
                .height(34).fontSize(12).fontColor('#FFFFFF').backgroundColor('#55745F')
                .onClick(() => {
                  this.failed = false;
                  this.initialize();
                })
            }.width('100%').padding(20).alignItems(HorizontalAlign.Center)
          } else if (this.filteredDrafts().length === 0) {
            Column({ space: 6 }) {
              Text('没有符合条件的草稿').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#253029')
              Text(this.filter === DraftFilter.ARCHIVED ? '归档的草稿会出现在这里。' : '先记录一个不完整的想法。')
                .fontSize(11).fontColor('#68736C')
            }.width('100%').padding(20).alignItems(HorizontalAlign.Center).margin({ top: 24 })
          } else {
            ForEach(this.filteredDrafts(), (draft: Draft) => {
              this.DraftRow(draft)
            }, (draft: Draft) => `${draft.id}-${draft.archived}`)
          }

          if (this.message.length > 0) {
            Text(this.message).fontSize(11).fontColor('#55745F').width('100%')
          }
        }.width('100%').padding({ left: 20, right: 20, top: 8, bottom: 18 })
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off)
    }.width('100%').height('100%').backgroundColor('#F7F8F6')
  }
}
