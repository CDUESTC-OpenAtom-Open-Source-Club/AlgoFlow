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
  @State statusExpanded: boolean = false;
  @State expandedDraftId: string = '';

  aboutToAppear(): void {
    this.initializeWorkspace();
  }

  onPageShow(): void {
    // Index and Placeholder keep their own repository instances; reload so
    // drafts created, deleted or synced there are current when returning.
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
    if (this.expandedDraftId === draftId) {
      this.expandedDraftId = '';
    }
    this.message = '草稿已删除，仍保留同步墓碑';
  }

  private toggleDraftActions(draftId: string): void {
    this.expandedDraftId = this.expandedDraftId === draftId ? '' : draftId;
  }

  private async openReservedPage(title: string, detail: string, draftId: string = ''): Promise<void> {
    await openPlaceholder(title, detail, draftId);
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

  private versionSnapshotCount(): number {
    let total = 0;
    this.drafts.forEach((draft: Draft) => {
      total += this.viewModel.getDraftSourceVersions(draft.id).length;
    });
    return total;
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
    return draft.updatedAt.substring(5, 16).replace('T', ' ');
  }

  private badgeLabel(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return '编辑中';
    if (status === SyncStatus.SYNCING) return '同步中';
    if (status === SyncStatus.CONFLICT) return '有冲突';
    if (status === SyncStatus.FAILED) return '同步失败';
    return '离线编辑';
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
    return '#D97706';
  }

  private actionButtonBg(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return '#EEF6F3';
    if (status === SyncStatus.CONFLICT || status === SyncStatus.FAILED) return '#FDF2EF';
    return '#FEF3C7';
  }

  private statusIcon(status: SyncStatus): ResourceIconName {
    if (status === SyncStatus.SYNCED || status === SyncStatus.SYNCING) return ResourceIconName.REFRESH;
    if (status === SyncStatus.CONFLICT || status === SyncStatus.FAILED) return ResourceIconName.QUERY;
    return ResourceIconName.DOCUMENT;
  }

  @Builder
  BrandIcon() {
    Image($r('app.media.af_logo')).width(36).height(36).objectFit(ImageFit.Contain);
  }

  @Builder
  NotificationButton() {
    Button() {
      ResourceIcon({ name: ResourceIconName.QUERY, iconSize: 18, tint: '#475569' })
    }.type(ButtonType.Normal).width(36).height(36)
      .backgroundColor('#FFFFFF').border({ width: 1, color: '#E2E8F0' }).borderRadius(18)
      .onClick(() => { this.openReservedPage('同步与队列', '查看本地待同步操作队列、同步游标与草稿同步状态。'); });
  }

  @Builder
  StatTile(value: string, label: string, icon: ResourceIconName, background: string, tint: string) {
    Column({ space: 6 }) {
      ResourceIcon({ name: icon, iconSize: 18, tint: tint })
      Text(value).fontSize(18).fontWeight(FontWeight.Bold).fontColor('#0F172A').margin({ top: 2 })
      Text(label).fontSize(10).fontColor('#64748B')
    }.layoutWeight(1).padding({ left: 12, right: 12, top: 12, bottom: 12 }).alignItems(HorizontalAlign.Start)
      .backgroundColor(background).borderRadius(20)
      .constraintSize({ minHeight: 92 });
  }

  @Builder
  StatusCollapsibleSection() {
    Column({ space: 10 }) {
      Button() {
        Row({ space: 8 }) {
          Text('工作区状态').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#0F172A')
          Row({ space: 6 }) {
            Row({ space: 4 }) {
              Circle().width(6).height(6).fill('#55745F')
              Text(`${this.syncedCount()} 已同步`).fontSize(10).fontWeight(FontWeight.Medium).fontColor('#55745F')
            }.padding({ left: 7, right: 7, top: 3, bottom: 3 }).backgroundColor('#E5F6F2').borderRadius(10)
            Row({ space: 4 }) {
              Circle().width(6).height(6).fill('#D97706')
              Text(`${this.localCount()} 本地`).fontSize(10).fontWeight(FontWeight.Medium).fontColor('#D97706')
            }.padding({ left: 7, right: 7, top: 3, bottom: 3 }).backgroundColor('#FAF3DC').borderRadius(10)
          }
          Blank()
          Text(this.statusExpanded ? '收起 · 本地优先' : '展开 · 本地优先')
            .fontSize(10).fontWeight(FontWeight.Bold).fontColor('#94A3B8')
        }.width('100%').alignItems(VerticalAlign.Center)
      }.type(ButtonType.Normal).width('100%').height(32).backgroundColor(Color.Transparent)
        .onClick(() => { this.statusExpanded = !this.statusExpanded; })

      if (this.statusExpanded) {
        Row({ space: 8 }) {
          Column() {
            this.StatTile(`${this.syncedCount()}`, '已同步草稿', ResourceIconName.REFRESH, '#E5F6F2', '#55745F')
          }.layoutWeight(1).onClick(() => {
            this.openReservedPage('全部草稿', '按状态筛选、搜索与同步本地/云端草稿。');
          })
          Column() {
            this.StatTile(`${this.localCount()}`, '仅本地', ResourceIconName.DOCUMENT, '#FAF3DC', '#D97706')
          }.layoutWeight(1).onClick(() => {
            this.openReservedPage('全部草稿', '按状态筛选、搜索与同步本地/云端草稿。');
          })
          Column() {
            this.StatTile(`${this.versionSnapshotCount()}`, '版本快照', ResourceIconName.VERSIONS, '#E3EDFD', '#475569')
          }.layoutWeight(1).onClick(() => {
            this.openReservedPage('历史版本', '查看 RDB 本地已保存的草稿源码与思路片段快照。');
          })
        }.width('100%')
      }
    }.width('100%')
  }

  @Builder
  DraftCard(draft: Draft) {
    Column({ space: 0 }) {
      Row({ space: 12 }) {
        Column({ space: 6 }) {
          Row({ space: 6 }) {
            Circle().width(7).height(7).fill(this.statusColor(draft.syncStatus))
            Text(this.badgeLabel(draft.syncStatus)).fontSize(10).fontWeight(FontWeight.Bold)
              .fontColor(this.statusColor(draft.syncStatus))
            Text(`· v${draft.version}`).fontSize(10).fontFamily('monospace').fontColor('#94A3B8')
            if (draft.ideaSegments.length > 0) {
              Text(`· ${draft.ideaSegments.length} 步思路`).fontSize(10).fontColor('#64748B')
            }
          }
          Text(draft.title.length === 0 ? '未命名思路' : draft.title)
            .fontSize(15).fontWeight(FontWeight.Bold).fontColor('#0F172A')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.summary(draft)).fontSize(12).fontColor('#64748B')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Button() {
          ResourceIcon({ name: ResourceIconName.CODE, iconSize: 16, tint: this.statusColor(draft.syncStatus) })
        }.type(ButtonType.Normal).width(36).height(36)
          .backgroundColor(this.actionButtonBg(draft.syncStatus)).borderRadius(12)
          .onClick(() => { this.openDraft(draft.id); })
      }.width('100%').alignItems(VerticalAlign.Top)
        .onClick(() => { this.openDraft(draft.id); })

      Divider().color('#F1F5F9').margin({ top: 12, bottom: 8 })

      Row() {
        Row({ space: 5 }) {
          ResourceIcon({ name: this.statusIcon(draft.syncStatus), iconSize: 13, tint: this.statusColor(draft.syncStatus) })
          Text(`${this.statusLabel(draft.syncStatus)} · ${this.updatedLabel(draft)}`)
            .fontSize(10).fontFamily('monospace').fontColor('#94A3B8')
        }.layoutWeight(1)

        Button() {
          Row({ space: 4 }) {
            Text(this.expandedDraftId === draft.id ? '收起操作' : '更多操作')
              .fontSize(10).fontWeight(FontWeight.Medium)
              .fontColor(this.expandedDraftId === draft.id ? '#55745F' : '#64748B')
          }
        }.type(ButtonType.Normal).height(26).padding({ left: 8, right: 8 })
          .backgroundColor(this.expandedDraftId === draft.id ? '#EEF6F3' : '#F8FAFC')
          .borderRadius(8)
          .onClick(() => { this.toggleDraftActions(draft.id); })
      }.width('100%').alignItems(VerticalAlign.Center)

      if (this.expandedDraftId === draft.id) {
        Row({ space: 8 }) {
          Button('进入编辑')
            .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Medium)
            .fontColor('#55745F').backgroundColor('#EEF6F3').borderRadius(8)
            .onClick(() => { this.openDraft(draft.id); })
          Button(`快照 v${draft.version}`)
            .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Medium)
            .fontColor('#64748B').backgroundColor('#F1F5F9').borderRadius(8)
            .onClick(() => { this.openReservedPage('历史版本', '查看草稿本地持久化的源码与思路快照。', draft.id); })
          Button('AI 转换')
            .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Medium)
            .fontColor('#55745F').backgroundColor('#E5F6F2').borderRadius(8)
            .onClick(() => { this.openReservedPage('AI 转换', '基于已同步草稿执行忠实转换、代码审查与缓存检视。', draft.id); })
          Button('删除')
            .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Medium)
            .fontColor('#B5674D').backgroundColor('#FDF2EF').borderRadius(8)
            .onClick(() => { this.deleteDraft(draft.id); })
        }.width('100%').margin({ top: 8 })
      }
    }.width('100%').padding(16).backgroundColor('#FFFFFF')
      .border({ width: 1, color: '#E5E9F0' }).borderRadius(16);
  }

  @Builder
  CreateDraftCard() {
    Button() {
      Row({ space: 12 }) {
        Row() {
          ResourceIcon({ name: ResourceIconName.PLUS, iconSize: 20 })
        }.width(40).height(40).justifyContent(FlexAlign.Center).backgroundColor('#243044').borderRadius(12)
        Column({ space: 3 }) {
          Text('创建新草稿').fontSize(14).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
          Text('从一个还不完整的想法开始').fontSize(11).fontColor('#CBD5E1')
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        ResourceIcon({ name: ResourceIconName.SOURCE, iconSize: 19, tint: '#CBD5E1' })
      }.width('100%').padding({ left: 16, right: 16 })
    }.type(ButtonType.Normal).width('100%').height(74).backgroundColor('#0F172A').borderRadius(16)
      .onClick(() => { this.createDraft(); });
  }

  @Builder
  NavItem(label: string, icon: ResourceIconName, active: boolean) {
    Column({ space: 4 }) {
      ResourceIcon({ name: icon, iconSize: 21, tint: active ? '#55745F' : '#94A3B8' })
      Text(label).fontSize(10).fontWeight(active ? FontWeight.Bold : FontWeight.Medium)
        .fontColor(active ? '#55745F' : '#94A3B8')
    }.layoutWeight(1).height(58).justifyContent(FlexAlign.Center)
      .onClick(() => {
        if (label === '写思路') this.openStarterDraft();
        if (label === 'AI 转换') this.openReservedPage('AI 转换', '基于已同步草稿执行忠实转换、代码审查与本地 AI 缓存检视。');
        if (label === '设置') this.openReservedPage('设置', '配置 Sync API 与 AI Gateway 端点、查看设备与版本契约状态。');
      });
  }

  build() {
    Column() {
      Row({ space: 10 }) {
        this.BrandIcon()
        Column({ space: 2 }) {
          Text('思流').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#0F172A')
          Text('IDEA FLOW / WORKSPACE').fontSize(10).fontColor('#94A3B8').letterSpacing(0.5)
        }.alignItems(HorizontalAlign.Start)
        Blank()
        this.NotificationButton()
      }.width('100%').padding({ left: 20, right: 20, top: 16, bottom: 8 })

      Row() {
        Column({ space: 4 }) {
          Text('把灵感变成').fontSize(32).fontWeight(FontWeight.Bold).fontColor('#0F172A').lineHeight(38)
          Text('可复用的思路').fontSize(21).fontWeight(FontWeight.Bold).fontColor('#55745F').lineHeight(28)
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Text(this.todayLabel()).fontSize(12).fontStyle(FontStyle.Italic).fontColor('#55745F').margin({ bottom: 4 })
      }.width('100%').padding({ left: 20, right: 20, top: 6, bottom: 10 }).alignItems(VerticalAlign.Bottom)

      Scroll() {
        Column({ space: 16 }) {
          this.CreateDraftCard()

          this.StatusCollapsibleSection()

          Column({ space: 12 }) {
            Row() {
              Text('最近草稿').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#0F172A')
              Blank()
              Button('查看全部')
                .type(ButtonType.Normal).height(26).padding({ left: 6, right: 6 })
                .fontSize(11).fontWeight(FontWeight.Bold).fontColor('#55745F')
                .backgroundColor(Color.Transparent)
                .onClick(() => { this.openReservedPage('全部草稿', '按状态筛选、搜索与同步本地/云端草稿。'); })
            }.width('100%').alignItems(VerticalAlign.Center)
            if (this.recentDrafts().length === 0) {
              Column({ space: 6 }) {
                Text('还没有草稿').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#0F172A')
                Text('先记录一个不完整的想法。').fontSize(11).fontColor('#64748B')
              }.width('100%').padding(16).backgroundColor('#FFFFFF')
                .border({ width: 1, color: '#E5E9F0' }).borderRadius(16)
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
        }.width('100%').padding({ left: 20, right: 20, top: 6, bottom: 20 })
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off)

      Row() {
        this.NavItem('工作区', ResourceIconName.FILES, true)
        this.NavItem('写思路', ResourceIconName.DOCUMENT, false)
        this.NavItem('AI 转换', ResourceIconName.AI, false)
        this.NavItem('设置', ResourceIconName.MENU, false)
      }.width('100%').height(74).padding({ left: 16, right: 16, top: 7, bottom: 7 })
        .backgroundColor('#FFFFFF').border({ width: { top: 1 }, color: '#E5E9F0' })
    }.width('100%').height('100%').backgroundColor('#F7F8FA')
  }
}
