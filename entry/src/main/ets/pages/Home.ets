import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { Draft, draftRenderKey, SyncStatus } from '../domain/Models';
import { RdbDraftRepository } from '../platform/RdbDraftRepository';
import { ResourceIcon, ResourceIconName } from '../components/ResourceIcon';
import { publishCardSnapshot } from '../platform/CardSnapshot';
import { CARD_REQUEST_KEY, CardAction, decodeCardRequest, openEditor, openPlaceholder } from '../navigation/AppRoutes';

@Entry
@Component
struct Home {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new RdbDraftRepository(getContext(this)));
  private handlingCard: boolean = false;

  @State drafts: Draft[] = [];
  @State ready: boolean = false;
  @State message: string = '';
  @StorageProp(CARD_REQUEST_KEY) @Watch('onCardRequest') cardRequest: string = '';

  aboutToAppear(): void {
    this.initializeWorkspace();
  }

  onPageShow(): void {
    // Index keeps its own repository instance; reload so drafts edited there
    // are current when returning to Home.
    if (this.ready && !this.handlingCard) this.reloadWorkspace().catch(() => {});
  }

  private async initializeWorkspace(): Promise<void> {
    try {
      await this.reloadWorkspace();
      this.ready = true;
      publishCardSnapshot(getContext(this), this.viewModel.listDrafts());
      await this.handleCardRequest();
    } catch (error) {
      this.message = '工作区暂时无法打开，请重试';
      console.error(`[AlgoFlow] Home initialization failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private async reloadWorkspace(): Promise<void> {
    const repository = new RdbDraftRepository(getContext(this));
    const viewModel = new DraftWorkspaceViewModel(repository, repository);
    await viewModel.initialize();
    this.viewModel = viewModel;
    this.drafts = viewModel.listDrafts();
  }

  onCardRequest(): void {
    this.handleCardRequest().catch((error: Error) => {
      console.error(`[AlgoFlow] card request failed: ${error.message}`);
    });
  }

  // Card taps never create or revive a draft implicitly: a missing draft keeps
  // the user on Home, and only the explicit new-draft action calls createDraft.
  private async handleCardRequest(): Promise<void> {
    if (!this.ready || this.handlingCard) return;
    const request = decodeCardRequest(AppStorage.get<string>(CARD_REQUEST_KEY));
    if (request.action === CardAction.NONE) return;
    AppStorage.setOrCreate<string>(CARD_REQUEST_KEY, '');
    this.handlingCard = true;
    try {
      await this.reloadWorkspace();
      if (request.action === CardAction.NEW_DRAFT) {
        await this.createDraft();
      } else if (request.action === CardAction.OPEN_DRAFT) {
        const draft = this.viewModel.getDraft(request.draftId);
        if (draft !== undefined) await this.openDraft(draft.id);
        else {
          this.message = '卡片中的草稿已删除或不存在';
          publishCardSnapshot(getContext(this), this.viewModel.listDrafts());
        }
      }
    } finally {
      this.handlingCard = false;
    }
  }

  private async openDraft(draftId: string): Promise<void> {
    if (!this.ready) return;
    await openEditor(draftId);
  }

  private async createDraft(): Promise<void> {
    if (!this.ready) return;
    const draftId = this.viewModel.createDraft();
    this.drafts = this.viewModel.listDrafts();
    await this.openDraft(draftId);
  }

  private async openStarterDraft(): Promise<void> {
    if (!this.ready) return;
    const draftId = this.viewModel.ensureStarterDraft();
    this.drafts = this.viewModel.listDrafts();
    await this.openDraft(draftId);
  }

  private async deleteDraft(draftId: string): Promise<void> {
    if (!this.ready) return;
    this.viewModel.deleteDraft(draftId);
    this.drafts = this.viewModel.listDrafts();
    publishCardSnapshot(getContext(this), this.drafts);
    this.message = '草稿已删除，仍保留同步墓碑';
  }

  private async openReservedPage(title: string, detail: string): Promise<void> {
    await openPlaceholder(title, detail);
  }

  private recentDrafts(): Draft[] {
    return this.drafts.slice(0, 3);
  }

  private syncedCount(): number {
    return this.drafts.filter((draft: Draft) => draft.syncStatus === SyncStatus.SYNCED).length;
  }

  private localCount(): number {
    return this.drafts.filter((draft: Draft) => draft.syncStatus !== SyncStatus.SYNCED).length;
  }

  private todayLabel(): string {
    const now = new Date();
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${now.getMonth() + 1}.${now.getDate()}/${weekdays[now.getDay()]}`;
  }

  private summary(draft: Draft): string {
    const ideaLine = draft.idea.split('\n').find((line: string) => line.trim().length > 0);
    if (ideaLine !== undefined) return ideaLine.trim();
    if (draft.code.trim().length > 0) return '已有 main.cpp 代码内容';
    return '从一个还不完整的想法开始';
  }

  private updatedLabel(draft: Draft): string {
    if (draft.updatedAt.length < 16) return '刚刚更新';
    return draft.updatedAt.substring(0, 16).replace('T', ' ');
  }

  private statusLabel(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return '已同步';
    if (status === SyncStatus.SYNCING) return '同步中';
    if (status === SyncStatus.CONFLICT) return '有冲突';
    if (status === SyncStatus.FAILED) return '同步失败';
    return '仅本地';
  }

  private statusColor(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return '#55745F';
    if (status === SyncStatus.CONFLICT || status === SyncStatus.FAILED) return '#B5674D';
    return '#A87732';
  }

  private statusIcon(status: SyncStatus): ResourceIconName {
    if (status === SyncStatus.SYNCED || status === SyncStatus.SYNCING) return ResourceIconName.REFRESH;
    if (status === SyncStatus.CONFLICT || status === SyncStatus.FAILED) return ResourceIconName.QUERY;
    return ResourceIconName.DOCUMENT;
  }

  @Builder
  BrandIcon() {
    Row() {
      ResourceIcon({ name: ResourceIconName.FILES, iconSize: 19 })
    }.width(38).height(38).justifyContent(FlexAlign.Center)
      .backgroundColor('#25352C').borderRadius(12);
  }

  @Builder
  NotificationButton() {
    Button() {
      ResourceIcon({ name: ResourceIconName.QUERY, iconSize: 18, tint: '#5E645D' })
    }.type(ButtonType.Normal).width(36).height(36)
      .backgroundColor('#FFFFFF').border({ width: 1, color: '#E2E8E3' }).borderRadius(18)
      .onClick(() => { this.openReservedPage('通知', '通知中心尚未接入，当前入口仅作预留。'); });
  }

  @Builder
  StatTile(value: string, label: string, icon: ResourceIconName, background: string, tint: string) {
    Column({ space: 8 }) {
      ResourceIcon({ name: icon, iconSize: 18, tint: tint })
      Text(value).fontSize(20).fontWeight(FontWeight.Bold).fontColor('#253029')
      Text(label).fontSize(10).fontColor('#68736C')
    }.layoutWeight(1).padding(12).alignItems(HorizontalAlign.Start)
      .backgroundColor(background).borderRadius(20)
      .constraintSize({ minHeight: 106 });
  }

  @Builder
  DraftCard(draft: Draft) {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Column({ space: 7 }) {
          Row({ space: 6 }) {
            Circle().width(7).height(7).fill(this.statusColor(draft.syncStatus))
            Text(this.statusLabel(draft.syncStatus)).fontSize(10).fontWeight(FontWeight.Bold)
              .fontColor(this.statusColor(draft.syncStatus))
            Text(`· v${draft.version}`).fontSize(10).fontColor('#8A938D')
          }
          Text(draft.title).fontSize(15).fontWeight(FontWeight.Bold).fontColor('#253029')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.summary(draft)).fontSize(11).fontColor('#68736C')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Button() {
          ResourceIcon({ name: ResourceIconName.CODE, iconSize: 16, tint: '#55745F' })
        }.type(ButtonType.Normal).width(36).height(36).backgroundColor('#EEF6F3').borderRadius(10)
          .onClick(() => { this.openDraft(draft.id); })
      }.width('100%').alignItems(VerticalAlign.Top)

      Divider().color('#EDF0ED')

      Row() {
        Row({ space: 5 }) {
          ResourceIcon({ name: this.statusIcon(draft.syncStatus), iconSize: 13, tint: this.statusColor(draft.syncStatus) })
          Text(`${this.statusLabel(draft.syncStatus)} · ${this.updatedLabel(draft)}`)
            .fontSize(10).fontColor('#8A938D')
        }.layoutWeight(1)
        Button('归档')
          .height(26).fontSize(10).fontColor('#68736C').backgroundColor(Color.Transparent)
          .onClick(() => { this.openReservedPage('归档草稿', '归档状态与恢复流程尚未接入，当前入口仅作预留。'); })
        Button('删除')
          .height(26).fontSize(10).fontColor('#B5674D').backgroundColor(Color.Transparent)
          .onClick(() => { this.deleteDraft(draft.id); })
      }.width('100%')
    }.width('100%').padding(14).backgroundColor('#FFFFFF')
      .border({ width: 1, color: '#E2E8E3' }).borderRadius(16);
  }

  @Builder
  CreateDraftCard() {
    Button() {
      Row({ space: 12 }) {
        Row() {
          ResourceIcon({ name: ResourceIconName.PLUS, iconSize: 20 })
        }.width(40).height(40).justifyContent(FlexAlign.Center).backgroundColor('#3C5C4B').borderRadius(12)
        Column({ space: 3 }) {
          Text('创建新草稿').fontSize(14).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
          Text('从一个还不完整的想法开始').fontSize(10).fontColor('#C7D8CD')
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        ResourceIcon({ name: ResourceIconName.SOURCE, iconSize: 20, tint: '#C7D8CD' })
      }.width('100%').padding({ left: 14, right: 14 })
    }.width('100%').height(76).backgroundColor('#25352C').borderRadius(16)
      .onClick(() => { this.createDraft(); });
  }

  @Builder
  NavItem(label: string, icon: ResourceIconName, active: boolean) {
    Column({ space: 4 }) {
      ResourceIcon({ name: icon, iconSize: 21, tint: active ? '#55745F' : '#9AA39D' })
      Text(label).fontSize(10).fontWeight(active ? FontWeight.Bold : FontWeight.Medium)
        .fontColor(active ? '#55745F' : '#8A938D')
    }.layoutWeight(1).height(58).justifyContent(FlexAlign.Center)
      .onClick(() => {
        if (label === '写思路') this.openStarterDraft();
        if (label === 'AI 转换') this.openReservedPage('AI 转换', 'AI Gateway 尚未接入，当前入口仅作预留。');
        if (label === '设置') this.openReservedPage('设置', '设置项尚未完成，当前入口仅作预留。');
      });
  }

  build() {
    Column() {
      Row({ space: 10 }) {
        this.BrandIcon()
        Column({ space: 2 }) {
          Text('思流').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#253029')
          Text('IDEA FLOW / WORKSPACE').fontSize(10).fontColor('#8A938D').letterSpacing(0.5)
        }.alignItems(HorizontalAlign.Start)
        Blank()
        this.NotificationButton()
      }.width('100%').padding({ left: 20, right: 20, top: 16, bottom: 12 })

      Column({ space: 6 }) {
        Text('把灵感变成').fontSize(36).fontWeight(FontWeight.Bold).fontColor('#253029').lineHeight(42)
        Text('可复用的思路').fontSize(22).fontWeight(FontWeight.Bold).fontColor('#55745F').lineHeight(30)
        Text(this.todayLabel()).fontSize(12).fontStyle(FontStyle.Italic).fontColor('#55745F').margin({ top: 4 })
      }.width('100%').padding({ left: 20, right: 20, top: 8, bottom: 6 }).alignItems(HorizontalAlign.Start)

      Scroll() {
        Column({ space: 16 }) {
          Column({ space: 12 }) {
            Row() {
              Text('工作区状态').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#253029')
              Blank()
              Text('本地优先').fontSize(10).fontWeight(FontWeight.Bold).fontColor('#8A938D')
            }.width('100%')
            Row({ space: 8 }) {
              this.StatTile(`${this.syncedCount()}`, '已同步草稿', ResourceIconName.REFRESH, '#E5F1EB', '#55745F')
              this.StatTile(`${this.localCount()}`, '仅本地', ResourceIconName.DOCUMENT, '#FAF3DC', '#A87732')
              this.StatTile('待接入', '历史版本', ResourceIconName.VERSIONS, '#E9EEF4', '#61758A')
            }.width('100%')
          }.width('100%')

          this.CreateDraftCard()

          Column({ space: 12 }) {
            Row() {
              Text('最近草稿').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#253029')
              Blank()
              Button('查看全部')
                .height(28).fontSize(11).fontWeight(FontWeight.Bold).fontColor('#55745F')
                .backgroundColor(Color.Transparent)
                .onClick(() => { this.openReservedPage('全部草稿', '全部草稿列表尚未拆分为独立页面，当前入口仅作预留。'); })
            }.width('100%')
            if (this.recentDrafts().length === 0) {
              Column({ space: 6 }) {
                Text('还没有草稿').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#253029')
                Text('先记录一个不完整的想法。').fontSize(11).fontColor('#68736C')
              }.width('100%').padding(16).backgroundColor('#FFFFFF').borderRadius(16)
                .alignItems(HorizontalAlign.Start)
            } else {
              ForEach(this.recentDrafts(), (draft: Draft) => {
                this.DraftCard(draft)
              }, (draft: Draft) => draftRenderKey(draft))
            }
          }.width('100%')

          if (this.message.length > 0) {
            Text(this.message).fontSize(11).fontColor('#55745F').width('100%')
          }
        }.width('100%').padding({ left: 20, right: 20, top: 14, bottom: 18 })
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off)

      Row() {
        this.NavItem('工作区', ResourceIconName.FILES, true)
        this.NavItem('写思路', ResourceIconName.DOCUMENT, false)
        this.NavItem('AI 转换', ResourceIconName.AI, false)
        this.NavItem('设置', ResourceIconName.MENU, false)
      }.width('100%').height(74).padding({ left: 16, right: 16, top: 7, bottom: 7 })
        .backgroundColor('#FFFFFF').border({ width: { top: 1 }, color: '#E2E8E3' })
    }.width('100%').height('100%').backgroundColor('#F7F8F6')
  }
}
