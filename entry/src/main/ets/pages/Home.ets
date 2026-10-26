import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { Draft, draftRenderKey, SyncStatus } from '../domain/Models';
import { RdbDraftRepository } from '../platform/RdbDraftRepository';
import { ResourceIcon, ResourceIconName } from '../components/ResourceIcon';
import { publishCardSnapshot } from '../platform/CardSnapshot';
import { AI_ENTRY } from 'BuildProfile';
import { CARD_REQUEST_KEY, CardAction, decodeCardRequest, openEditor, openPlaceholder } from '../navigation/AppRoutes';

// Idea-segment colours cycle by segment position (S1/S2/S3, S4 = S1 ...).
const RAIL_COLORS: string[] = ['#8FBF9A', '#D9B36A', '#9DB4D4'];

class PeekLine {
  line: number;
  text: string;

  constructor(line: number, text: string) {
    this.line = line;
    this.text = text;
  }
}

@Entry
@Component
struct Home {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new RdbDraftRepository(getContext(this)));
  private handlingCard: boolean = false;

  @State drafts: Draft[] = [];
  @State ready: boolean = false;
  @State message: string = '';
  @StorageProp(CARD_REQUEST_KEY) @Watch('onCardRequest') cardRequest: string = '';
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

  // The first draft is shown in the "继续上次" card; the list holds the next three.
  private otherDrafts(): Draft[] {
    return this.drafts.slice(1, 4);
  }

  private pendingCount(): number {
    return this.drafts.filter((draft: Draft) =>
      draft.syncStatus === SyncStatus.CONFLICT || draft.syncStatus === SyncStatus.FAILED).length;
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
    return `${now.getMonth() + 1}.${now.getDate()} / ${weekdays[now.getDay()]}`;
  }

  private titleOf(draft: Draft): string {
    return draft.title.length === 0 ? '未命名思路' : draft.title;
  }

  // First three non-empty lines of main.cpp with their real line numbers.
  private peekLines(draft: Draft): PeekLine[] {
    const result: PeekLine[] = [];
    const lines = draft.code.split('\n');
    for (let index = 0; index < lines.length && result.length < 3; index++) {
      if (lines[index].trim().length > 0) result.push(new PeekLine(index + 1, lines[index]));
    }
    return result;
  }

  private segmentColors(draft: Draft): string[] {
    const colors: string[] = [];
    for (let index = 0; index < Math.min(draft.ideaSegments.length, 6); index++) {
      colors.push(RAIL_COLORS[index % RAIL_COLORS.length]);
    }
    return colors;
  }

  private updatedLabel(draft: Draft): string {
    if (draft.updatedAt.length < 16) return '刚刚更新';
    return draft.updatedAt.substring(5, 16).replace('T', ' ');
  }

  private statusLabel(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return '已同步';
    if (status === SyncStatus.SYNCING) return '同步中';
    if (status === SyncStatus.CONFLICT) return '有冲突';
    if (status === SyncStatus.FAILED) return '同步失败';
    return '仅本地';
  }

  // Fixed text per sync status; never derived from draft content.
  private statusHint(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return '最近一次同步成功';
    if (status === SyncStatus.SYNCING) return '正在同步';
    if (status === SyncStatus.CONFLICT) return '电脑上也改了 · 需要选择版本';
    if (status === SyncStatus.FAILED) return '未送达 · 已保留在本机';
    return '只保存在本机';
  }

  private chipBackground(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return '#E5F1EB';
    if (status === SyncStatus.SYNCING) return '#E9EEF4';
    if (status === SyncStatus.CONFLICT) return '#FAF3DC';
    if (status === SyncStatus.FAILED) return '#F6E3DC';
    return '#E5E2D9';
  }

  private chipText(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return '#20372A';
    if (status === SyncStatus.SYNCING) return '#3E5672';
    if (status === SyncStatus.CONFLICT) return '#7A5A17';
    if (status === SyncStatus.FAILED) return '#8A4532';
    return '#5E645D';
  }

  private chipDot(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return '#55745F';
    if (status === SyncStatus.SYNCING) return '#6E8AAE';
    if (status === SyncStatus.CONFLICT) return '#B98A2E';
    if (status === SyncStatus.FAILED) return '#B5674D';
    return '#777C73';
  }

  @Builder
  BrandIcon() {
    Image($r('app.media.af_logo')).width(36).height(36).objectFit(ImageFit.Contain);
  }

  @Builder
  NotificationButton() {
    Button() {
      ResourceIcon({ name: ResourceIconName.QUERY, iconSize: 18, tint: '#5E645D' })
    }.type(ButtonType.Normal).width(36).height(36)
      .backgroundColor('#FFFFFF').border({ width: 1, color: '#E5E2D9' }).borderRadius(18)
      .onClick(() => { this.openReservedPage('同步与队列', '查看本地待同步操作队列、同步游标与草稿同步状态。'); });
  }

  @Builder
  StatusChip(status: SyncStatus) {
    Row({ space: 5 }) {
      Circle().width(6).height(6).fill(this.chipDot(status))
      Text(this.statusLabel(status)).fontSize(10).fontWeight(FontWeight.Medium).fontColor(this.chipText(status))
    }.height(22).padding({ left: 8, right: 8 }).backgroundColor(this.chipBackground(status)).borderRadius(11)
  }

  @Builder
  MiniSegments(draft: Draft) {
    Row({ space: 2 }) {
      ForEach(this.segmentColors(draft), (color: string, index: number) => {
        Column().width(6).height(10).backgroundColor(color).borderRadius(2)
      }, (color: string, index: number) => `${index}-${color}`)
    }
  }

  @Builder
  DraftActions(draft: Draft, dark: boolean) {
    Row({ space: 6 }) {
      Button('进入编辑')
        .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Medium)
        .fontColor(dark ? '#DBE8DC' : '#55745F').backgroundColor(dark ? '#33463A' : '#E5F1EB').borderRadius(8)
        .onClick(() => { this.openDraft(draft.id); })
      Button(`快照 v${draft.version}`)
        .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Medium)
        .fontColor(dark ? '#DBE8DC' : '#5E645D').backgroundColor(dark ? '#33463A' : '#EFEDE6').borderRadius(8)
        .onClick(() => { this.openReservedPage('历史版本', '查看草稿本地持久化的源码与思路快照。', draft.id); })
      if (AI_ENTRY) {
        Button('AI 转换')
          .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Medium)
          .fontColor(dark ? '#DBE8DC' : '#55745F').backgroundColor(dark ? '#33463A' : '#E5F1EB').borderRadius(8)
          .onClick(() => { this.openReservedPage('AI 转换', '基于已同步草稿执行忠实转换、代码审查与缓存检视。', draft.id); })
      }
      Button('删除')
        .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Medium)
        .fontColor(dark ? '#F0B8A6' : '#B5674D').backgroundColor(dark ? '#4A3029' : '#F6E3DC').borderRadius(8)
        .onClick(() => { this.deleteDraft(draft.id); })
    }.width('100%').margin({ top: 10 })
  }

  @Builder
  ContinueCard(draft: Draft) {
    Column({ space: 0 }) {
      Row() {
        Text('继续上次').fontSize(11).fontWeight(FontWeight.Medium).fontColor('#A9BFAE')
        Blank()
        Row({ space: 5 }) {
          Circle().width(6).height(6).fill(draft.syncStatus === SyncStatus.SYNCED ? '#8FBF9A' : this.chipDot(draft.syncStatus))
          Text(this.statusLabel(draft.syncStatus)).fontSize(10).fontColor('#BFE0C6')
        }.height(22).padding({ left: 8, right: 8 }).backgroundColor('#2E4436').borderRadius(11)
      }.width('100%')

      Text(this.titleOf(draft)).fontSize(18).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).margin({ top: 10 })
      Text(`main.cpp · ${draft.ideaSegments.length} 段思路 · ${this.updatedLabel(draft)}`)
        .fontSize(11).fontColor('#A9BFAE').margin({ top: 4 })

      Column({ space: 2 }) {
        if (this.peekLines(draft).length === 0) {
          Text('main.cpp 还是空的').fontSize(11).fontColor('#7F9585').fontFamily('monospace')
        } else {
          ForEach(this.peekLines(draft), (line: PeekLine) => {
            Row({ space: 10 }) {
              Text(line.line.toString().padStart(2, '0')).width(20).fontSize(11).fontFamily('monospace')
                .fontColor('#6F8575').textAlign(TextAlign.End)
              Text(line.text).layoutWeight(1).fontSize(11).fontFamily('monospace').fontColor('#E3ECE5')
                .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            }.width('100%')
          }, (line: PeekLine) => `${line.line}-${line.text}`)
        }
      }.width('100%').padding({ left: 10, right: 10, top: 9, bottom: 9 }).margin({ top: 12 })
        .alignItems(HorizontalAlign.Start).backgroundColor('#1B261F').borderRadius(10)

      Row({ space: 8 }) {
        Button(this.expandedDraftId === draft.id ? '收起操作' : '更多操作')
          .type(ButtonType.Normal).layoutWeight(1).height(36).fontSize(12).fontColor('#DBE8DC')
          .backgroundColor('#25352C').border({ width: 1, color: '#4A5E50' }).borderRadius(18)
          .onClick(() => { this.toggleDraftActions(draft.id); })
        Button('打开 main.cpp')
          .type(ButtonType.Normal).layoutWeight(1).height(36).fontSize(12).fontWeight(FontWeight.Medium)
          .fontColor('#25352C').backgroundColor('#DBE8DC').borderRadius(18)
          .onClick(() => { this.openDraft(draft.id); })
      }.width('100%').margin({ top: 14 })

      if (this.expandedDraftId === draft.id) {
        this.DraftActions(draft, true)
      }
    }.width('100%').padding(16).backgroundColor('#25352C').borderRadius(20)
  }

  @Builder
  QuickCreate() {
    Button() {
      Row({ space: 12 }) {
        Row() {
          ResourceIcon({ name: ResourceIconName.PLUS, iconSize: 16, tint: '#55745F' })
        }.width(32).height(32).justifyContent(FlexAlign.Center).backgroundColor('#DBE8DC').borderRadius(16)
        Column({ space: 2 }) {
          Text('记下一个思路').fontSize(14).fontWeight(FontWeight.Bold).fontColor('#252A26')
          Text('先写想法，代码可以以后在电脑上补').fontSize(11).fontColor('#5E645D')
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      }.width('100%').padding({ left: 14, right: 14 })
    }.type(ButtonType.Normal).width('100%').height(64).backgroundColor('#FBF9F4')
      .border({ width: 1, color: '#C8C9BF', style: BorderStyle.Dashed }).borderRadius(16)
      .onClick(() => { this.createDraft(); });
  }

  @Builder
  DraftRow(draft: Draft) {
    Column({ space: 0 }) {
      Row({ space: 10 }) {
        Column({ space: 5 }) {
          Text(this.titleOf(draft)).fontSize(14).fontWeight(FontWeight.Bold).fontColor('#252A26')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Row({ space: 6 }) {
            this.MiniSegments(draft)
            Text(`${this.statusHint(draft.syncStatus)} · ${this.updatedLabel(draft)}`)
              .fontSize(11).fontColor('#5E645D').maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          }
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        this.StatusChip(draft.syncStatus)
      }.width('100%').alignItems(VerticalAlign.Center)
        .onClick(() => { this.openDraft(draft.id); })

      Row() {
        Text(`v${draft.version}`).fontSize(10).fontFamily('monospace').fontColor('#8A8F86')
        Blank()
        Button(this.expandedDraftId === draft.id ? '收起操作' : '更多操作')
          .type(ButtonType.Normal).height(24).padding({ left: 8, right: 8 })
          .fontSize(10).fontColor(this.expandedDraftId === draft.id ? '#55745F' : '#5E645D')
          .backgroundColor(this.expandedDraftId === draft.id ? '#E5F1EB' : Color.Transparent).borderRadius(8)
          .onClick(() => { this.toggleDraftActions(draft.id); })
      }.width('100%').margin({ top: 6 })

      if (this.expandedDraftId === draft.id) {
        this.DraftActions(draft, false)
      }
    }.width('100%').padding({ left: 14, right: 14, top: 12, bottom: 10 }).backgroundColor('#FFFFFF')
      .border({ width: 1, color: '#E5E2D9' }).borderRadius(16)
  }

  @Builder
  NavItem(label: string, icon: ResourceIconName, active: boolean) {
    Column({ space: 4 }) {
      ResourceIcon({ name: icon, iconSize: 21, tint: active ? '#55745F' : '#8A8F86' })
      Text(label).fontSize(10).fontWeight(active ? FontWeight.Bold : FontWeight.Medium)
        .fontColor(active ? '#55745F' : '#8A8F86')
    }.layoutWeight(1).height(58).justifyContent(FlexAlign.Center)
      .onClick(() => {
        if (label === '写思路') this.openStarterDraft();
        if (label === 'AI 转换') this.openReservedPage('AI 转换', '基于已同步草稿执行忠实转换、代码审查与本地 AI 缓存检视。');
        if (label === '设置') this.openReservedPage('设置', AI_ENTRY ? '配置 Sync API 与 AI Gateway 端点、查看设备与版本契约状态。' : '配置 Sync API 端点、查看设备与版本契约状态。');
      });
  }

  build() {
    Column() {
      Row({ space: 10 }) {
        this.BrandIcon()
        Column({ space: 2 }) {
          Text('算法随想').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#252A26')
          Text(`思流 · ${this.todayLabel()}`).fontSize(10).fontColor('#5E645D')
        }.alignItems(HorizontalAlign.Start)
        Blank()
        this.NotificationButton()
      }.width('100%').padding({ left: 20, right: 20, top: 16, bottom: 10 })

      Scroll() {
        Column({ space: 14 }) {
          // A @Builder argument passed by value does not re-render when drafts
          // reload, so key the card by draftRenderKey like the list below.
          ForEach(this.drafts.slice(0, 1), (draft: Draft) => {
            this.ContinueCard(draft)
          }, (draft: Draft) => draftRenderKey(draft))

          this.QuickCreate()

          Column({ space: 10 }) {
            Row() {
              Text('最近草稿').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#252A26')
              Text(`共 ${this.drafts.length} 个${this.pendingCount() > 0 ? ` · ${this.pendingCount()} 个待处理` : ''}`)
                .fontSize(11).fontColor('#5E645D').margin({ left: 8 })
              Blank()
              Button('查看全部')
                .type(ButtonType.Normal).height(26).padding({ left: 6, right: 6 })
                .fontSize(11).fontWeight(FontWeight.Bold).fontColor('#55745F')
                .backgroundColor(Color.Transparent)
                .onClick(() => { this.openReservedPage('全部草稿', '按状态筛选、搜索与同步本地及已连接端点的草稿。'); })
            }.width('100%').alignItems(VerticalAlign.Center)
            if (this.drafts.length === 0) {
              Column({ space: 6 }) {
                Text('还没有草稿').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#252A26')
                Text('先记录一个不完整的想法。').fontSize(11).fontColor('#5E645D')
              }.width('100%').padding(16).backgroundColor('#FFFFFF')
                .border({ width: 1, color: '#E5E2D9' }).borderRadius(16)
                .alignItems(HorizontalAlign.Start)
            } else if (this.otherDrafts().length === 0) {
              Text('只有上面这一个草稿。').fontSize(11).fontColor('#5E645D').width('100%')
            } else {
              ForEach(this.otherDrafts(), (draft: Draft) => {
                this.DraftRow(draft)
              }, (draft: Draft) => draftRenderKey(draft))
            }
          }.width('100%')

          Row() {
            Text(`${this.syncedCount()} 已同步 · ${this.localCount()} 本地`).fontSize(11).fontColor('#5E645D')
            Blank()
            Text(`${this.versionSnapshotCount()} 个版本快照 ›`).fontSize(11).fontColor('#55745F')
              .onClick(() => { this.openReservedPage('历史版本', '查看 RDB 本地已保存的草稿源码与思路片段快照。'); })
          }.width('100%')

          if (this.message.length > 0) {
            Text(this.message).fontSize(11).fontColor('#55745F').width('100%')
          }
        }.width('100%').padding({ left: 20, right: 20, top: 4, bottom: 20 })
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off).align(Alignment.Top)

      Row() {
        this.NavItem('工作区', ResourceIconName.FILES, true)
        this.NavItem('写思路', ResourceIconName.DOCUMENT, false)
        if (AI_ENTRY) {
          this.NavItem('AI 转换', ResourceIconName.AI, false)
        }
        this.NavItem('设置', ResourceIconName.MENU, false)
      }.width('100%').height(74).padding({ left: 16, right: 16, top: 7, bottom: 7 })
        .backgroundColor('#FBF9F4').border({ width: { top: 1 }, color: '#E5E2D9' })
    }.width('100%').height('100%').backgroundColor('#F3F1EA')
  }
}
