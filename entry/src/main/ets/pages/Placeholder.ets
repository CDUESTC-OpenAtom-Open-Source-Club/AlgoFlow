import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { AIMode, Draft, draftRenderKey, IdeaSegment, SyncStatus } from '../domain/Models';
import { IDECapability, IDERecord, IDEState, ReviewKind } from '../domain/IDEAIModels';
import { SyncOperation } from '../domain/SyncModels';
import { RdbDraftRepository } from '../platform/RdbDraftRepository';
import { ResourceIcon, ResourceIconName } from '../components/ResourceIcon';
import { goBack, openEditor, openHome, PLACEHOLDER_DETAIL_KEY, PLACEHOLDER_DRAFT_ID_KEY, PLACEHOLDER_TITLE_KEY } from '../navigation/AppRoutes';
import { DEBUG } from 'BuildProfile';
import { manualPairingInvitation, PairingError, PairingErrorCode, PairingInvitation, PairingRoute, pairingErrorMessage,
  parsePairingInvitation } from '../domain/PairingContract';
import { canScanPairingCode, scanPairingCode } from '../platform/PairingScanner';

enum HubTab {
  DRAFTS = 'drafts',
  AI = 'ai',
  VERSIONS = 'versions',
  SYNC = 'sync',
  SETTINGS = 'settings'
}

enum DraftFilter {
  ALL = 'all',
  SYNCED = 'synced',
  LOCAL = 'local',
  ISSUE = 'issue'
}

@Entry
@Component
struct Placeholder {
  private repository: RdbDraftRepository | null = null;
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new RdbDraftRepository(getContext(this)));

  @State title: string = '工作区面板';
  @State detail: string = '';
  @State activeTab: HubTab = HubTab.DRAFTS;
  @State ready: boolean = false;
  @State drafts: Draft[] = [];
  @State selectedDraftId: string = '';
  @State searchQuery: string = '';
  @State draftFilter: DraftFilter = DraftFilter.ALL;
  @State expandedDraftId: string = '';

  // Version snapshot state
  @State availableVersions: number[] = [];
  @State selectedVersion: number = 0;
  @State snapshotCode: string = '';
  @State snapshotSegments: IdeaSegment[] = [];

  // AI Transform & Review state
  @State aiRecords: IDERecord[] = [];
  @State aiLoading: boolean = false;
  @State aiStatusText: string = '';
  @State allowTestData: boolean = false;

  // Sync & Settings state
  @State pendingOps: SyncOperation[] = [];
  @State syncBaseUrl: string = 'http://127.0.0.1:8787';
  @State aiBaseUrl: string = 'http://127.0.0.1:8788';
  @State clientId: string = '';
  @State syncCursor: string = '0';
  @State syncing: boolean = false;
  @State feedbackMessage: string = '';
  @State advancedExpanded: boolean = false;
  @State pairMode: string = 'scan'; // 'scan' | 'code' | 'paste' | 'endpoints'
  @State pairing: boolean = false;
  private scanAvailable: boolean = canScanPairingCode();
  @State pairRoute: string = 'lan'; // 'lan' | 'relay'
  @State pairShortCode: string = '';
  @State pairHostIp: string = '127.0.0.1';
  @State pairInvitationText: string = '';
  @State pairedComputerName: string = 'AlgoFlow-Desktop';

  aboutToAppear(): void {
    const savedTitle = AppStorage.get<string>(PLACEHOLDER_TITLE_KEY);
    const savedDetail = AppStorage.get<string>(PLACEHOLDER_DETAIL_KEY);
    const routedDraftId = AppStorage.get<string>(PLACEHOLDER_DRAFT_ID_KEY);
    if (savedTitle !== undefined && savedTitle.length > 0) this.title = savedTitle;
    if (savedDetail !== undefined && savedDetail.length > 0) this.detail = savedDetail;
    if (routedDraftId !== undefined && routedDraftId.length > 0) this.selectedDraftId = routedDraftId;
    this.activeTab = this.resolveInitialTab(this.title);
    this.initializeHub();
  }

  private resolveInitialTab(title: string): HubTab {
    if (title.includes('AI')) return HubTab.AI;
    if (title.includes('版本') || title.includes('快照')) return HubTab.VERSIONS;
    if (title.includes('同步') || title.includes('通知') || title.includes('队列')) return HubTab.SYNC;
    if (title.includes('设置')) return HubTab.SETTINGS;
    return HubTab.DRAFTS;
  }

  private async initializeHub(): Promise<void> {
    try {
      const repo = new RdbDraftRepository(getContext(this));
      this.repository = repo;
      this.viewModel = new DraftWorkspaceViewModel(repo, repo);
      await this.viewModel.initialize();
      this.viewModel.configureAI(repo.aiResults(this.allowTestData), this.allowTestData);
      if (this.viewModel.aiSession !== null) {
        this.viewModel.aiSession.onChange = () => { this.syncAIState(); };
      }
      this.refreshWorkspaceData();
      this.ready = true;
    } catch (error) {
      this.feedbackMessage = '本地数据库读取失败，请返回重试';
    }
  }

  private refreshWorkspaceData(): void {
    this.drafts = this.viewModel.listDrafts();
    if (this.selectedDraftId.length === 0 || this.viewModel.getDraft(this.selectedDraftId) === undefined) {
      this.selectedDraftId = this.drafts.length > 0 ? this.drafts[0].id : '';
    }
    this.syncBaseUrl = this.viewModel.getSyncBaseUrl();
    this.aiBaseUrl = this.viewModel.getAIBaseUrl();
    this.clientId = this.viewModel.getClientId();
    this.syncCursor = this.viewModel.getSyncCursor();
    this.pendingOps = this.repository?.listPendingOperations() ?? [];
    this.loadSelectedDraftContext();
  }

  private loadSelectedDraftContext(): void {
    if (this.selectedDraftId.length === 0) {
      this.availableVersions = [];
      this.selectedVersion = 0;
      this.snapshotCode = '';
      this.snapshotSegments = [];
      this.aiRecords = [];
      return;
    }
    const versions = this.viewModel.getDraftSourceVersions(this.selectedDraftId);
    const currentDraft = this.viewModel.getDraft(this.selectedDraftId);
    if (versions.length === 0 && currentDraft !== undefined && currentDraft.version > 0) {
      this.availableVersions = [currentDraft.version];
    } else {
      this.availableVersions = versions;
    }
    this.selectedVersion = this.availableVersions.length > 0
      ? this.availableVersions[0]
      : (currentDraft?.version ?? 0);
    this.loadVersionSnapshot(this.selectedVersion);
    this.viewModel.selectAIContext(this.selectedDraftId, 'main.cpp');
    this.syncAIState();
  }

  private loadVersionSnapshot(version: number): void {
    this.selectedVersion = version;
    const currentDraft = this.viewModel.getDraft(this.selectedDraftId);
    const code = this.viewModel.getDraftSourceCode(this.selectedDraftId, version);
    const segments = this.viewModel.getDraftSourceSegments(this.selectedDraftId, version);
    this.snapshotCode = code !== undefined ? code : (currentDraft?.code ?? '');
    this.snapshotSegments = segments !== undefined ? segments : (currentDraft?.ideaSegments ?? []);
  }

  private syncAIState(): void {
    const session = this.viewModel.aiSession;
    if (session === null) return;
    this.aiRecords = session.records.slice().reverse();
    this.aiLoading = session.records.some((record: IDERecord) => record.state === IDEState.LOADING);
    this.aiStatusText = session.storageError;
  }

  private selectDraft(draftId: string): void {
    this.selectedDraftId = draftId;
    this.loadSelectedDraftContext();
  }

  private filteredDrafts(): Draft[] {
    const query = this.searchQuery.trim().toLowerCase();
    return this.drafts.filter((draft: Draft) => {
      if (this.draftFilter === DraftFilter.SYNCED && draft.syncStatus !== SyncStatus.SYNCED) return false;
      if (this.draftFilter === DraftFilter.LOCAL && draft.syncStatus !== SyncStatus.LOCAL_ONLY) return false;
      if (this.draftFilter === DraftFilter.ISSUE &&
        draft.syncStatus !== SyncStatus.CONFLICT && draft.syncStatus !== SyncStatus.FAILED) return false;
      if (query.length === 0) return true;
      return draft.title.toLowerCase().includes(query) ||
        draft.idea.toLowerCase().includes(query) ||
        draft.code.toLowerCase().includes(query) ||
        draft.id.toLowerCase().includes(query);
    });
  }

  private async runSyncNow(): Promise<void> {
    if (!this.ready || this.syncing) return;
    this.syncing = true;
    this.feedbackMessage = '正在执行增量同步 (push -> pull)...';
    try {
      const result = await this.viewModel.synchronize();
      this.refreshWorkspaceData();
      this.feedbackMessage = result !== undefined ? `${result.message} [cursor=${this.syncCursor}]` : '同步未执行';
    } catch (error) {
      this.feedbackMessage = '同步异常，本地副本已安全保留';
    } finally {
      this.syncing = false;
    }
  }

  private async triggerAI(capability: IDECapability, kind: ReviewKind = ReviewKind.EXPLANATION): Promise<void> {
    if (!this.ready || this.selectedDraftId.length === 0) return;
    this.viewModel.selectAIContext(this.selectedDraftId, 'main.cpp');
    await this.viewModel.aiSession?.request(capability, kind);
    this.syncAIState();
    this.pendingOps = this.repository?.listPendingOperations() ?? [];
  }

  private saveEndpoints(): void {
    if (!this.ready) return;
    this.viewModel.setSyncBaseUrl(this.syncBaseUrl);
    this.viewModel.setAIBaseUrl(this.aiBaseUrl, DEBUG && this.allowTestData);
    if (this.repository !== null) {
      this.viewModel.configureAI(this.repository.aiResults(DEBUG && this.allowTestData), DEBUG && this.allowTestData);
      if (this.viewModel.aiSession !== null) {
        this.viewModel.aiSession.onChange = () => { this.syncAIState(); };
      }
      this.loadSelectedDraftContext();
    }
    this.syncBaseUrl = this.viewModel.getSyncBaseUrl();
    this.aiBaseUrl = this.viewModel.getAIBaseUrl();
    this.feedbackMessage = '端点配置已写入 RDB sync_state';
  }

  private resetDefaultEndpoints(): void {
    this.syncBaseUrl = 'http://127.0.0.1:8787';
    this.aiBaseUrl = 'http://127.0.0.1:8788';
    this.pairHostIp = '127.0.0.1';
    this.saveEndpoints();
  }

  // Scan, manual code and paste all end here: the desktop's sync-api validates
  // the single-use code and returns the endpoints; only then are they written.
  private async pairWith(invitation: PairingInvitation): Promise<void> {
    if (!this.ready || this.pairing) return;
    this.pairing = true;
    this.feedbackMessage = '正在向电脑校验配对码...';
    try {
      const claim = await this.viewModel.claimPairing(invitation);
      this.syncBaseUrl = claim.syncApi;
      this.aiBaseUrl = claim.aiGateway;
      this.pairedComputerName = claim.computerName.length > 0 ? claim.computerName : 'AlgoFlow-Desktop';
      this.pairRoute = claim.route === PairingRoute.RELAY ? 'relay' : 'lan';
      this.pairShortCode = '';
      this.pairInvitationText = '';
      this.saveEndpoints();
    } catch (error) {
      this.feedbackMessage = pairingErrorMessage(error instanceof PairingError ? error.code : PairingErrorCode.NETWORK);
      return;
    } finally {
      this.pairing = false;
    }
    this.feedbackMessage = `已与「${this.pairedComputerName}」配对，正在执行首次同步...`;
    await this.runSyncNow();
  }

  private async applyScanPairing(): Promise<void> {
    if (this.pairing) return;
    let text = '';
    try {
      text = await scanPairingCode(getContext(this));
    } catch (error) {
      this.feedbackMessage = '无法打开扫码，请改用「8 位配对码」或「粘贴配对信息」';
      return;
    }
    if (text.length === 0) return;
    const parsed = parsePairingInvitation(text);
    if (parsed.invitation === undefined) {
      this.feedbackMessage = parsed.error;
      return;
    }
    await this.pairWith(parsed.invitation);
  }

  private async applyShortCodePairing(): Promise<void> {
    const parsed = manualPairingInvitation(this.pairHostIp, this.pairShortCode);
    if (parsed.invitation === undefined) {
      this.feedbackMessage = parsed.error;
      return;
    }
    await this.pairWith(parsed.invitation);
  }

  private async applyPastedInvitation(): Promise<void> {
    if (this.pairInvitationText.trim().length === 0) {
      this.feedbackMessage = '请先粘贴电脑端「复制配对信息」的内容';
      return;
    }
    const parsed = parsePairingInvitation(this.pairInvitationText);
    if (parsed.invitation === undefined) {
      this.feedbackMessage = parsed.error;
      return;
    }
    await this.pairWith(parsed.invitation);
  }

  private statusLabel(status: SyncStatus): string {
    if (status === SyncStatus.SYNCED) return 'SYNCED';
    if (status === SyncStatus.SYNCING) return 'SYNCING';
    if (status === SyncStatus.CONFLICT) return 'CONFLICT';
    if (status === SyncStatus.FAILED) return 'FAILED';
    return 'LOCAL';
  }

  private statusCnLabel(status: SyncStatus): string {
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

  private modeName(mode: AIMode): string {
    if (mode === AIMode.FEASIBILITY_ANALYSIS) return '可行性分析';
    if (mode === AIMode.PROGRESSIVE_HINT) return '渐进提示';
    if (mode === AIMode.FULL_SOLUTION) return '完整解题';
    return '忠实转换';
  }

  private capabilityTag(record: IDERecord): string {
    if (record.capability === IDECapability.TRANSFORM) return 'TRANSFORM · 伪代码';
    if (record.capability === IDECapability.COMPLETION) return 'COMPLETION · 补全';
    return `REVIEW · ${record.reviewKind.toUpperCase()}`;
  }

  private recordSummary(record: IDERecord): string {
    if (record.state === IDEState.LOADING) return '正在请求 AI Gateway...';
    if (record.state === IDEState.ERROR || record.state === IDEState.CANCELLED) {
      return record.message.length > 0 ? record.message : record.errorCode;
    }
    const parsed = this.viewModel.aiSession?.result(record) ?? null;
    if (parsed === null) return '结果已隔离缓存';
    if (record.capability === IDECapability.TRANSFORM) {
      return parsed.transformText.length > 0 ? parsed.transformText : '已生成忠实转换结果';
    }
    if (record.capability === IDECapability.REVIEW) {
      if (parsed.diagnostics.length === 0) return '审查通过，未发现明显风险或偏差';
      return parsed.diagnostics.map(d => `[${d.level.toUpperCase()}] ${d.problem} → ${d.suggestion}`).join('\n');
    }
    return parsed.suggestion;
  }

  @Builder
  TopHeader() {
    Row({ space: 10 }) {
      Button() {
        Row({ space: 4 }) {
          Text('←').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#0F172A')
          Text('返回').fontSize(11).fontWeight(FontWeight.Bold).fontColor('#0F172A')
        }
      }.type(ButtonType.Normal).height(34).padding({ left: 12, right: 12 })
        .backgroundColor('#FFFFFF').border({ width: 1, color: '#E2E8F0' }).borderRadius(10)
        .onClick(() => { goBack(); })

      Column({ space: 1 }) {
        Text(this.title).fontSize(15).fontWeight(FontWeight.Bold).fontColor('#0F172A')
        Text('ALGOFLOW // WORKSPACE CONSOLE').fontSize(9).fontFamily('monospace').fontColor('#94A3B8')
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)

      Button() {
        Row({ space: 4 }) {
          ResourceIcon({ name: ResourceIconName.REFRESH, iconSize: 13, tint: '#55745F' })
          Text(this.syncing ? 'SYNC...' : '同步').fontSize(10).fontWeight(FontWeight.Bold).fontColor('#55745F')
        }
      }.type(ButtonType.Normal).height(34).padding({ left: 10, right: 10 })
        .backgroundColor('#EEF6F3').borderRadius(10)
        .onClick(() => { this.runSyncNow(); })
    }.width('100%').padding({ left: 20, right: 20, top: 16, bottom: 10 })
  }

  @Builder
  TabChip(label: string, code: string, tab: HubTab) {
    Button() {
      Row({ space: 5 }) {
        Text(label).fontSize(11).fontWeight(this.activeTab === tab ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.activeTab === tab ? '#FFFFFF' : '#475569')
        Text(code).fontSize(9).fontFamily('monospace')
          .fontColor(this.activeTab === tab ? '#A7F3D0' : '#94A3B8')
      }
    }.type(ButtonType.Normal).height(32).padding({ left: 11, right: 11 })
      .backgroundColor(this.activeTab === tab ? '#0F172A' : '#FFFFFF')
      .border({ width: 1, color: this.activeTab === tab ? '#0F172A' : '#E2E8F0' })
      .borderRadius(10)
      .onClick(() => {
        this.activeTab = tab;
        if (tab === HubTab.DRAFTS) this.title = '全部草稿';
        if (tab === HubTab.AI) this.title = 'AI 转换与审查';
        if (tab === HubTab.VERSIONS) this.title = '历史版本快照';
        if (tab === HubTab.SYNC) this.title = '同步与操作队列';
        if (tab === HubTab.SETTINGS) this.title = '工作台设置';
      })
  }

  @Builder
  DraftSelectorStrip() {
    if (this.drafts.length > 0) {
      Column({ space: 6 }) {
        Row() {
          Text('TARGET DRAFT // 当前目标草稿').fontSize(9).fontFamily('monospace').fontWeight(FontWeight.Bold)
            .fontColor('#64748B')
          Blank()
          Text(`共 ${this.drafts.length} 篇`).fontSize(9).fontFamily('monospace').fontColor('#94A3B8')
        }.width('100%')
        Scroll() {
          Row({ space: 8 }) {
            ForEach(this.drafts, (draft: Draft) => {
              Button() {
                Row({ space: 6 }) {
                  Circle().width(6).height(6).fill(this.statusColor(draft.syncStatus))
                  Text(draft.title.length === 0 ? '未命名思路' : draft.title)
                    .fontSize(11).fontWeight(draft.id === this.selectedDraftId ? FontWeight.Bold : FontWeight.Medium)
                    .fontColor(draft.id === this.selectedDraftId ? '#0F172A' : '#64748B')
                    .maxLines(1)
                  Text(`v${draft.version}`).fontSize(9).fontFamily('monospace').fontColor('#94A3B8')
                }
              }.type(ButtonType.Normal).height(30).padding({ left: 10, right: 10 })
                .backgroundColor(draft.id === this.selectedDraftId ? '#EEF6F3' : '#FFFFFF')
                .border({ width: 1, color: draft.id === this.selectedDraftId ? '#55745F' : '#E2E8F0' })
                .borderRadius(8)
                .onClick(() => { this.selectDraft(draft.id); })
            }, (draft: Draft) => draftRenderKey(draft))
          }
        }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).width('100%')
      }.width('100%').padding(12).backgroundColor('#FFFFFF')
        .border({ width: 1, color: '#E5E9F0' }).borderRadius(14)
    }
  }

  @Builder
  FilterPill(label: string, filter: DraftFilter, count: number) {
    Button() {
      Row({ space: 4 }) {
        Text(label).fontSize(10).fontWeight(this.draftFilter === filter ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.draftFilter === filter ? '#55745F' : '#64748B')
        Text(`${count}`).fontSize(9).fontFamily('monospace')
          .fontColor(this.draftFilter === filter ? '#55745F' : '#94A3B8')
      }
    }.type(ButtonType.Normal).height(28).padding({ left: 10, right: 10 })
      .backgroundColor(this.draftFilter === filter ? '#EEF6F3' : '#FFFFFF')
      .border({ width: 1, color: this.draftFilter === filter ? '#55745F' : '#E2E8F0' })
      .borderRadius(8)
      .onClick(() => { this.draftFilter = filter; })
  }

  @Builder
  AllDraftsView() {
    Column({ space: 12 }) {
      // Search & New draft bar
      Row({ space: 8 }) {
        Row({ space: 8 }) {
          ResourceIcon({ name: ResourceIconName.SEARCH, iconSize: 15, tint: '#94A3B8' })
          TextInput({ text: this.searchQuery, placeholder: '搜索标题 / 思路片段 / main.cpp...' })
            .layoutWeight(1).height(36).fontSize(12).fontColor('#0F172A')
            .placeholderColor('#94A3B8').backgroundColor(Color.Transparent)
            .padding(0)
            .onChange((value: string) => { this.searchQuery = value; })
        }.layoutWeight(1).height(38).padding({ left: 12, right: 12 })
          .backgroundColor('#FFFFFF').border({ width: 1, color: '#E2E8F0' }).borderRadius(12)

        Button() {
          Row({ space: 4 }) {
            ResourceIcon({ name: ResourceIconName.PLUS, iconSize: 14 })
            Text('新建').fontSize(11).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
          }
        }.type(ButtonType.Normal).height(38).padding({ left: 12, right: 12 })
          .backgroundColor('#0F172A').borderRadius(12)
          .onClick(() => {
            const id = this.viewModel.createDraft();
            this.refreshWorkspaceData();
            openEditor(id);
          })
      }.width('100%')

      // Status filter pills
      Row({ space: 6 }) {
        this.FilterPill('全部', DraftFilter.ALL, this.drafts.length)
        this.FilterPill('已同步', DraftFilter.SYNCED,
          this.drafts.filter((d: Draft) => d.syncStatus === SyncStatus.SYNCED).length)
        this.FilterPill('仅本地', DraftFilter.LOCAL,
          this.drafts.filter((d: Draft) => d.syncStatus === SyncStatus.LOCAL_ONLY).length)
        this.FilterPill('冲突/异常', DraftFilter.ISSUE,
          this.drafts.filter((d: Draft) => d.syncStatus === SyncStatus.CONFLICT || d.syncStatus === SyncStatus.FAILED).length)
      }.width('100%')

      if (this.filteredDrafts().length === 0) {
        Column({ space: 8 }) {
          Text('NO MATCHING DRAFTS').fontSize(10).fontFamily('monospace').fontColor('#94A3B8')
          Text('没有符合筛选条件的草稿').fontSize(14).fontWeight(FontWeight.Bold).fontColor('#0F172A')
          Text('尝试清空搜索词或直接创建新草稿。').fontSize(11).fontColor('#64748B')
        }.width('100%').padding(20).backgroundColor('#FFFFFF')
          .border({ width: 1, color: '#E5E9F0' }).borderRadius(16).alignItems(HorizontalAlign.Start)
      } else {
        ForEach(this.filteredDrafts(), (draft: Draft) => {
          Column({ space: 10 }) {
            Row({ space: 10 }) {
              Column({ space: 5 }) {
                Row({ space: 6 }) {
                  Text(this.statusLabel(draft.syncStatus)).fontSize(9).fontFamily('monospace').fontWeight(FontWeight.Bold)
                    .fontColor(this.statusColor(draft.syncStatus))
                    .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                    .backgroundColor('#F8FAFC').borderRadius(4)
                  Text(`v${draft.version}`).fontSize(10).fontFamily('monospace').fontColor('#64748B')
                  Text(`· ${draft.ideaSegments.length} segs`).fontSize(10).fontFamily('monospace').fontColor('#94A3B8')
                  Text(`· ${draft.code.length} chars`).fontSize(10).fontFamily('monospace').fontColor('#94A3B8')
                }
                Text(draft.title.length === 0 ? '未命名思路' : draft.title)
                  .fontSize(15).fontWeight(FontWeight.Bold).fontColor('#0F172A')
                  .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                Text(draft.idea.trim().length > 0 ? draft.idea.trim() : '尚未记录思路片段')
                  .fontSize(11).fontColor('#64748B').maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)

              Button() {
                ResourceIcon({ name: ResourceIconName.CODE, iconSize: 16, tint: '#55745F' })
              }.type(ButtonType.Normal).width(36).height(36).backgroundColor('#EEF6F3').borderRadius(10)
                .onClick(() => { openEditor(draft.id); })
            }.width('100%').onClick(() => { openEditor(draft.id); })

            Row() {
              Text(`ID: ${draft.id}`).fontSize(9).fontFamily('monospace').fontColor('#94A3B8')
                .layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
              Button(this.expandedDraftId === draft.id ? '收起' : '操作')
                .type(ButtonType.Normal).height(24).padding({ left: 8, right: 8 })
                .fontSize(10).fontColor('#55745F').backgroundColor('#F1F5F9').borderRadius(6)
                .onClick(() => {
                  this.expandedDraftId = this.expandedDraftId === draft.id ? '' : draft.id;
                })
            }.width('100%').alignItems(VerticalAlign.Center)

            if (this.expandedDraftId === draft.id) {
              Row({ space: 6 }) {
                Button('打开 IDE')
                  .type(ButtonType.Normal).layoutWeight(1).height(28).fontSize(10)
                  .fontColor('#55745F').backgroundColor('#EEF6F3').borderRadius(6)
                  .onClick(() => { openEditor(draft.id); })
                Button('版本快照')
                  .type(ButtonType.Normal).layoutWeight(1).height(28).fontSize(10)
                  .fontColor('#475569').backgroundColor('#F1F5F9').borderRadius(6)
                  .onClick(() => {
                    this.selectDraft(draft.id);
                    this.activeTab = HubTab.VERSIONS;
                  })
                Button('AI 转换')
                  .type(ButtonType.Normal).layoutWeight(1).height(28).fontSize(10)
                  .fontColor('#475569').backgroundColor('#F1F5F9').borderRadius(6)
                  .onClick(() => {
                    this.selectDraft(draft.id);
                    this.activeTab = HubTab.AI;
                  })
                Button('删除')
                  .type(ButtonType.Normal).layoutWeight(1).height(28).fontSize(10)
                  .fontColor('#B5674D').backgroundColor('#FDF2EF').borderRadius(6)
                  .onClick(() => {
                    this.viewModel.deleteDraft(draft.id);
                    this.refreshWorkspaceData();
                    this.feedbackMessage = '草稿已标记删除并排入同步墓碑队列';
                  })
              }.width('100%')
            }
          }.width('100%').padding(14).backgroundColor('#FFFFFF')
            .border({ width: 1, color: '#E5E9F0' }).borderRadius(14)
        }, (draft: Draft) => draftRenderKey(draft))
      }
    }.width('100%')
  }

  @Builder
  AIHubView() {
    Column({ space: 12 }) {
      this.DraftSelectorStrip()

      if (this.selectedDraftId.length > 0) {
        Column({ space: 10 }) {
          Row() {
            Text('AI PIPELINE // 忠实转换与代码审查').fontSize(10).fontFamily('monospace')
              .fontWeight(FontWeight.Bold).fontColor('#9BE7A9')
            Blank()
            Text(this.modeName(this.viewModel.getDraft(this.selectedDraftId)?.aiMode ?? AIMode.FAITHFUL_TRANSFORM))
              .fontSize(10).fontFamily('monospace').fontColor('#CBD5E1')
          }.width('100%')

          Text(`当前草稿状态：${this.statusCnLabel(this.viewModel.getDraft(this.selectedDraftId)?.syncStatus ?? SyncStatus.LOCAL_ONLY)} · 思路片段 ${this.viewModel.getDraft(this.selectedDraftId)?.ideaSegments.length ?? 0} 条`)
            .fontSize(11).fontColor('#94A3B8')

          Row({ space: 8 }) {
            Button('忠实转换 (伪代码)')
              .type(ButtonType.Normal).layoutWeight(1).height(34).fontSize(10).fontWeight(FontWeight.Bold)
              .fontColor('#07110A').backgroundColor('#30D158').borderRadius(8)
              .onClick(() => { this.triggerAI(IDECapability.TRANSFORM); })
            Button('逻辑与风险审查')
              .type(ButtonType.Normal).layoutWeight(1).height(34).fontSize(10).fontWeight(FontWeight.Bold)
              .fontColor('#E2E8F0').backgroundColor('#1E293B').borderRadius(8)
              .onClick(() => { this.triggerAI(IDECapability.REVIEW, ReviewKind.RISK); })
            Button('复杂度审查')
              .type(ButtonType.Normal).layoutWeight(1).height(34).fontSize(10).fontWeight(FontWeight.Bold)
              .fontColor('#E2E8F0').backgroundColor('#1E293B').borderRadius(8)
              .onClick(() => { this.triggerAI(IDECapability.REVIEW, ReviewKind.COMPLEXITY); })
          }.width('100%')

          if (this.aiLoading) {
            Row({ space: 8 }) {
              Text('RUNNING // 正在等待 AI Gateway 响应...').fontSize(10).fontFamily('monospace').fontColor('#9BE7A9')
              Blank()
              Button('取消')
                .type(ButtonType.Normal).height(24).fontSize(10).fontColor('#FCA5A5')
                .backgroundColor('#3F1D24').borderRadius(6)
                .onClick(() => { this.viewModel.cancelAI(); this.syncAIState(); })
            }.width('100%')
          }
        }.width('100%').padding(14).backgroundColor('#0F172A').borderRadius(16)
          .alignItems(HorizontalAlign.Start)

        // Cached AI Records
        Column({ space: 8 }) {
          Row() {
            Text(`本地隔离 AI 产物 (${this.aiRecords.length})`).fontSize(13).fontWeight(FontWeight.Bold).fontColor('#0F172A')
            Blank()
            Button('在 IDE 中打开')
              .type(ButtonType.Normal).height(26).fontSize(10).fontWeight(FontWeight.Bold)
              .fontColor('#55745F').backgroundColor('#EEF6F3').borderRadius(6)
              .onClick(() => { openEditor(this.selectedDraftId); })
          }.width('100%')

          if (this.aiRecords.length === 0) {
            Column({ space: 6 }) {
              Text('EMPTY AI CACHE // 暂无记录').fontSize(10).fontFamily('monospace').fontColor('#94A3B8')
              Text('当前草稿尚无 AI 转换或审查记录。请确保草稿已同步且包含思路片段后发起请求。')
                .fontSize(11).fontColor('#64748B').lineHeight(17)
            }.width('100%').padding(16).backgroundColor('#FFFFFF')
              .border({ width: 1, color: '#E5E9F0' }).borderRadius(14).alignItems(HorizontalAlign.Start)
          } else {
            ForEach(this.aiRecords, (record: IDERecord) => {
              Column({ space: 8 }) {
                Row({ space: 6 }) {
                  Text(this.capabilityTag(record)).fontSize(9).fontFamily('monospace').fontWeight(FontWeight.Bold)
                    .fontColor('#55745F').padding({ left: 6, right: 6, top: 2, bottom: 2 })
                    .backgroundColor('#EEF6F3').borderRadius(4)
                  Text(`src:v${record.context.version}`).fontSize(9).fontFamily('monospace').fontColor('#64748B')
                  if (record.stale) {
                    Text('STALE').fontSize(9).fontFamily('monospace').fontColor('#D97706')
                  }
                  if (record.isTestData) {
                    Text('TEST').fontSize(9).fontFamily('monospace').fontColor('#B5674D')
                  }
                  Blank()
                  Button(record.hidden ? '显示' : '隐藏')
                    .type(ButtonType.Normal).height(22).padding({ left: 6, right: 6 })
                    .fontSize(9).fontColor('#64748B').backgroundColor('#F1F5F9').borderRadius(4)
                    .onClick(() => {
                      this.viewModel.aiSession?.setHidden(record.id, !record.hidden);
                      this.syncAIState();
                    })
                }.width('100%')

                if (!record.hidden) {
                  Text(this.recordSummary(record))
                    .fontSize(11).fontFamily('monospace').fontColor('#1E293B').lineHeight(17)
                    .width('100%').padding(10).backgroundColor('#F8FAFC').borderRadius(8)
                }
              }.width('100%').padding(12).backgroundColor('#FFFFFF')
                .border({ width: 1, color: '#E5E9F0' }).borderRadius(14).alignItems(HorizontalAlign.Start)
            }, (record: IDERecord) => record.id)
          }
        }.width('100%')
      }
    }.width('100%')
  }

  @Builder
  VersionsView() {
    Column({ space: 12 }) {
      this.DraftSelectorStrip()

      Column({ space: 10 }) {
        Row() {
          Text('RDB SOURCE SNAPSHOTS // 源码与思路快照').fontSize(10).fontFamily('monospace')
            .fontWeight(FontWeight.Bold).fontColor('#0F172A')
          Blank()
          Text(`共 ${this.availableVersions.length} 个快照`).fontSize(10).fontFamily('monospace').fontColor('#64748B')
        }.width('100%')

        if (this.availableVersions.length === 0) {
          Column({ space: 6 }) {
            Text('v0 LOCAL DRAFT // 尚无已落盘历史版本').fontSize(10).fontFamily('monospace').fontColor('#D97706')
            Text('当前草稿处于 v0 初始态，完成首次云端同步或版本演进后将自动在 draft_source_history 表中记录不可变快照。')
              .fontSize(11).fontColor('#64748B').lineHeight(17)
          }.width('100%').padding(12).backgroundColor('#FAF3DC').borderRadius(12).alignItems(HorizontalAlign.Start)
        } else {
          Row({ space: 6 }) {
            ForEach(this.availableVersions, (ver: number) => {
              Button(`v${ver}`)
                .type(ButtonType.Normal).height(28).padding({ left: 10, right: 10 })
                .fontSize(10).fontFamily('monospace').fontWeight(FontWeight.Bold)
                .fontColor(this.selectedVersion === ver ? '#FFFFFF' : '#0F172A')
                .backgroundColor(this.selectedVersion === ver ? '#0F172A' : '#F1F5F9')
                .borderRadius(8)
                .onClick(() => { this.loadVersionSnapshot(ver); })
            }, (ver: number) => `${ver}`)
          }.width('100%')
        }

        // Snapshot segments preview
        Column({ space: 6 }) {
          Text(`IDEA SEGMENTS (${this.snapshotSegments.length})`).fontSize(9).fontFamily('monospace')
            .fontWeight(FontWeight.Bold).fontColor('#64748B')
          if (this.snapshotSegments.length === 0) {
            Text('// 无思路片段').fontSize(11).fontFamily('monospace').fontColor('#94A3B8')
          } else {
            ForEach(this.snapshotSegments, (seg: IdeaSegment) => {
              Row({ space: 6 }) {
                Text(`[#${seg.position + 1}]`).fontSize(10).fontFamily('monospace').fontColor('#55745F')
                Text(seg.content).fontSize(11).fontColor('#0F172A').layoutWeight(1)
              }.width('100%')
            }, (seg: IdeaSegment) => seg.id)
          }
        }.width('100%').padding(12).backgroundColor('#F8FAFC').borderRadius(10).alignItems(HorizontalAlign.Start)

        // Snapshot C++ code terminal preview
        Column({ space: 6 }) {
          Row() {
            Text(`main.cpp @ v${this.selectedVersion}`).fontSize(10).fontFamily('monospace')
              .fontWeight(FontWeight.Bold).fontColor('#9BE7A9')
            Blank()
            Button('进入编辑器')
              .type(ButtonType.Normal).height(22).padding({ left: 8, right: 8 })
              .fontSize(9).fontColor('#07110A').backgroundColor('#30D158').borderRadius(5)
              .onClick(() => { openEditor(this.selectedDraftId); })
          }.width('100%')
          Text(this.snapshotCode.trim().length > 0 ? this.snapshotCode : '// 空代码文档')
            .fontSize(11).fontFamily('monospace').fontColor('#E2E8F0').lineHeight(17).width('100%')
        }.width('100%').padding(12).backgroundColor('#0F172A').borderRadius(12).alignItems(HorizontalAlign.Start)
      }.width('100%').padding(14).backgroundColor('#FFFFFF')
        .border({ width: 1, color: '#E5E9F0' }).borderRadius(16).alignItems(HorizontalAlign.Start)
    }.width('100%')
  }

  @Builder
  SyncQueueView() {
    Column({ space: 12 }) {
      // Telemetry Card
      Column({ space: 8 }) {
        Row() {
          Text('SYNC TELEMETRY // 同步遥测').fontSize(10).fontFamily('monospace')
            .fontWeight(FontWeight.Bold).fontColor('#9BE7A9')
          Blank()
          Text(`CURSOR: ${this.syncCursor}`).fontSize(10).fontFamily('monospace').fontColor('#38BDF8')
        }.width('100%')
        Text(`CLIENT_ID: ${this.clientId}`).fontSize(10).fontFamily('monospace').fontColor('#94A3B8')
        Text(`SYNC_API : ${this.syncBaseUrl}`).fontSize(10).fontFamily('monospace').fontColor('#CBD5E1')
        Text(`PENDING  : ${this.pendingOps.length} operations queued`).fontSize(10).fontFamily('monospace').fontColor('#FDE68A')

        Button(this.syncing ? '正在执行增量同步...' : '立即执行 Push & Pull 同步')
          .type(ButtonType.Normal).width('100%').height(36).fontSize(11).fontWeight(FontWeight.Bold)
          .fontColor('#07110A').backgroundColor('#30D158').borderRadius(8).margin({ top: 4 })
          .onClick(() => { this.runSyncNow(); })
      }.width('100%').padding(14).backgroundColor('#0F172A').borderRadius(16).alignItems(HorizontalAlign.Start)

      // Pending Operations List
      Column({ space: 8 }) {
        Text(`待上行操作队列 (${this.pendingOps.length})`).fontSize(13).fontWeight(FontWeight.Bold).fontColor('#0F172A')
        if (this.pendingOps.length === 0) {
          Column({ space: 4 }) {
            Text('QUEUE CLEAN // 队列已清空').fontSize(10).fontFamily('monospace').fontColor('#55745F')
            Text('所有非空变更均已同步或尚无待推送操作。').fontSize(11).fontColor('#64748B')
          }.width('100%').padding(14).backgroundColor('#FFFFFF')
            .border({ width: 1, color: '#E5E9F0' }).borderRadius(14).alignItems(HorizontalAlign.Start)
        } else {
          ForEach(this.pendingOps, (op: SyncOperation) => {
            Row({ space: 8 }) {
              Column({ space: 3 }) {
                Row({ space: 6 }) {
                  Text(op.operation_type.toUpperCase()).fontSize(9).fontFamily('monospace').fontWeight(FontWeight.Bold)
                    .fontColor('#D97706').padding({ left: 5, right: 5, top: 2, bottom: 2 })
                    .backgroundColor('#FAF3DC').borderRadius(4)
                  Text(op.entity_type).fontSize(10).fontFamily('monospace').fontColor('#475569')
                  Text(`base:v${op.base_version}`).fontSize(10).fontFamily('monospace').fontColor('#94A3B8')
                }
                Text(`entity: ${op.entity_id}`).fontSize(10).fontFamily('monospace').fontColor('#0F172A')
                  .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                Text(op.occurred_at).fontSize(9).fontFamily('monospace').fontColor('#94A3B8')
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            }.width('100%').padding(12).backgroundColor('#FFFFFF')
              .border({ width: 1, color: '#E5E9F0' }).borderRadius(12)
          }, (op: SyncOperation) => op.operation_id)
        }
      }.width('100%').alignItems(HorizontalAlign.Start)
    }.width('100%')
  }

  @Builder
  PairModeTab(label: string, mode: string) {
    Button(label)
      .type(ButtonType.Normal).layoutWeight(1).height(32).fontSize(11)
      .fontWeight(this.pairMode === mode ? FontWeight.Bold : FontWeight.Medium)
      .fontColor(this.pairMode === mode ? '#55745F' : '#64748B')
      .backgroundColor(this.pairMode === mode ? '#EEF6F3' : '#F8FAFC')
      .border({ width: 1, color: this.pairMode === mode ? '#55745F' : '#E2E8F0' }).borderRadius(8)
      .onClick(() => { this.pairMode = mode; })
  }

  @Builder
  SettingsView() {
    Column({ space: 12 }) {
      // Pebrel-style Computer Connection Hero Card
      Column({ space: 12 }) {
        Row() {
          Column({ space: 2 }) {
            Text('CONNECT COMPUTER // 连接电脑').fontSize(9).fontFamily('monospace')
              .fontWeight(FontWeight.Bold).fontColor('#9BE7A9')
            Text(this.pairedComputerName).fontSize(16).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
          }.alignItems(HorizontalAlign.Start).layoutWeight(1)

          Row({ space: 5 }) {
            Circle().width(6).height(6).fill('#30D158')
            Text(this.pairRoute === 'lan' ? '局域网 / USB' : '服务器中转').fontSize(10).fontFamily('monospace')
              .fontColor('#9BE7A9')
          }.padding({ left: 8, right: 8, top: 4, bottom: 4 })
            .backgroundColor('#1E3A27').borderRadius(99)
        }.width('100%')

        Text('在电脑上打开 AlgoFlow Web 端，点击顶部「手机远程」，扫描二维码或输入 8 位配对码。')
          .fontSize(11).fontColor('#94A3B8').lineHeight(17)

        // Route segmented toggle: 局域网 vs 服务器中转
        Row({ space: 4 }) {
          Button('局域网 / USB 转发')
            .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Bold)
            .fontColor(this.pairRoute === 'lan' ? '#0F172A' : '#CBD5E1')
            .backgroundColor(this.pairRoute === 'lan' ? '#FFFFFF' : Color.Transparent)
            .borderRadius(7)
            .onClick(() => { this.pairRoute = 'lan'; })
          Button('服务器中转 (Relay)')
            .type(ButtonType.Normal).layoutWeight(1).height(30).fontSize(10).fontWeight(FontWeight.Bold)
            .fontColor(this.pairRoute === 'relay' ? '#0F172A' : '#CBD5E1')
            .backgroundColor(this.pairRoute === 'relay' ? '#FFFFFF' : Color.Transparent)
            .borderRadius(7)
            .onClick(() => { this.pairRoute = 'relay'; })
        }.width('100%').padding(3).backgroundColor('#1E293B').borderRadius(9)

        // Pebrel 3-step summary
        Row({ space: 8 }) {
          Row({ space: 4 }) {
            Text('1').fontSize(9).fontFamily('monospace').fontWeight(FontWeight.Bold).fontColor('#07110A')
              .width(15).height(15).textAlign(TextAlign.Center).backgroundColor('#30D158').borderRadius(8)
            Text('找到电脑').fontSize(10).fontColor('#E2E8F0')
          }
          Text('→').fontSize(10).fontColor('#64748B')
          Row({ space: 4 }) {
            Text('2').fontSize(9).fontFamily('monospace').fontWeight(FontWeight.Bold).fontColor('#07110A')
              .width(15).height(15).textAlign(TextAlign.Center).backgroundColor('#30D158').borderRadius(8)
            Text('核对配对码').fontSize(10).fontColor('#E2E8F0')
          }
          Text('→').fontSize(10).fontColor('#64748B')
          Row({ space: 4 }) {
            Text('3').fontSize(9).fontFamily('monospace').fontWeight(FontWeight.Bold).fontColor('#07110A')
              .width(15).height(15).textAlign(TextAlign.Center).backgroundColor('#30D158').borderRadius(8)
            Text('同步草稿流').fontSize(10).fontColor('#E2E8F0')
          }
        }.width('100%')
      }.width('100%').padding(16).backgroundColor('#0F172A').borderRadius(16).alignItems(HorizontalAlign.Start)

      // Pairing Method Tabs: 扫码 | 8位配对码 | 粘贴配对信息 | 手动端点
      Column({ space: 12 }) {
        Row({ space: 5 }) {
          this.PairModeTab('扫码', 'scan')
          this.PairModeTab('配对码', 'code')
          this.PairModeTab('粘贴', 'paste')
          this.PairModeTab('手动端点', 'endpoints')
        }.width('100%')

        if (this.pairMode === 'scan') {
          Column({ space: 10 }) {
            Text('扫描电脑端「手机远程」窗口中的二维码。配对码 10 分钟内有效、只能使用一次，由电脑的同步服务校验。')
              .fontSize(11).fontColor('#64748B').lineHeight(17)
            if (this.scanAvailable) {
              Button(this.pairing ? '正在校验配对码...' : '扫描电脑二维码')
                .type(ButtonType.Normal).width('100%').height(42).fontSize(13).fontWeight(FontWeight.Bold)
                .fontColor('#FFFFFF').backgroundColor('#0F172A').borderRadius(10)
                .enabled(!this.pairing)
                .onClick(() => { this.applyScanPairing(); })
              Text('扫码使用 HarmonyOS 系统扫码能力（ScanKit），也可从相册选择二维码图片。')
                .fontSize(10).fontColor('#94A3B8')
            } else {
              Text('当前设备不支持系统扫码，请使用「配对码」或「粘贴」。')
                .fontSize(11).fontColor('#B5674D')
            }
          }.width('100%').alignItems(HorizontalAlign.Start)
        } else if (this.pairMode === 'code') {
          Column({ space: 10 }) {
            Text('输入电脑地址和「手机远程」窗口中的 8 位配对码，由电脑的同步服务校验：')
              .fontSize(11).fontColor('#64748B')

            Column({ space: 4 }) {
              Text('8 位配对码 (例如 4829 1034)').fontSize(10).fontFamily('monospace').fontColor('#475569')
              TextInput({ text: this.pairShortCode, placeholder: '0000 0000' })
                .width('100%').height(40).fontSize(15).fontFamily('monospace').fontWeight(FontWeight.Bold)
                .fontColor('#0F172A').backgroundColor('#F8FAFC')
                .border({ width: 1, color: '#E2E8F0' }).borderRadius(10)
                .onChange((val: string) => { this.pairShortCode = val; })
            }.width('100%').alignItems(HorizontalAlign.Start)

            Column({ space: 4 }) {
              Text(this.pairRoute === 'lan'
                ? '电脑同步服务地址：局域网 IP、IP:端口，或 hdc rport 后的 127.0.0.1'
                : '中转同步服务地址 (Relay URL，需自行提供)').fontSize(10).fontColor('#64748B')
              TextInput({ text: this.pairHostIp, placeholder: '127.0.0.1 或 192.168.x.x' })
                .width('100%').height(38).fontSize(12).fontFamily('monospace').fontColor('#0F172A')
                .backgroundColor('#F8FAFC').border({ width: 1, color: '#E2E8F0' }).borderRadius(10)
                .onChange((val: string) => { this.pairHostIp = val; })
            }.width('100%').alignItems(HorizontalAlign.Start)

            Button(this.pairing ? '正在校验配对码...' : '配对这台电脑并同步')
              .type(ButtonType.Normal).width('100%').height(38).fontSize(12).fontWeight(FontWeight.Bold)
              .fontColor('#FFFFFF').backgroundColor('#0F172A').borderRadius(10)
              .enabled(!this.pairing)
              .onClick(() => { this.applyShortCodePairing(); })
          }.width('100%').alignItems(HorizontalAlign.Start)
        } else if (this.pairMode === 'paste') {
          Column({ space: 10 }) {
            Text('粘贴电脑端「复制配对信息」的内容（与二维码内容相同）：')
              .fontSize(11).fontColor('#64748B')

            TextInput({
              text: this.pairInvitationText,
              placeholder: '{"type":"algoflow-pair-v1","sync_api":"http://192.168.x.x:8787","code":"00000000"}'
            })
              .width('100%').height(42).fontSize(11).fontFamily('monospace').fontColor('#0F172A')
              .backgroundColor('#F8FAFC').border({ width: 1, color: '#E2E8F0' }).borderRadius(10)
              .onChange((val: string) => { this.pairInvitationText = val; })

            Button(this.pairing ? '正在校验配对码...' : '读取配置并连接电脑')
              .type(ButtonType.Normal).width('100%').height(38).fontSize(12).fontWeight(FontWeight.Bold)
              .fontColor('#FFFFFF').backgroundColor('#55745F').borderRadius(10)
              .enabled(!this.pairing)
              .onClick(() => { this.applyPastedInvitation(); })
          }.width('100%').alignItems(HorizontalAlign.Start)
        } else {
          Column({ space: 10 }) {
            Column({ space: 4 }) {
              Text('Sync API Base URL (真机使用 hdc rport tcp:8787 tcp:8787)').fontSize(10).fontColor('#64748B')
              TextInput({ text: this.syncBaseUrl, placeholder: 'http://127.0.0.1:8787' })
                .width('100%').height(38).fontSize(12).fontFamily('monospace').fontColor('#0F172A')
                .backgroundColor('#F8FAFC').border({ width: 1, color: '#E2E8F0' }).borderRadius(10)
                .onChange((val: string) => { this.syncBaseUrl = val; })
            }.width('100%').alignItems(HorizontalAlign.Start)

            Column({ space: 4 }) {
              Text('AI Gateway Base URL (真机使用 hdc rport tcp:8788 tcp:8788)').fontSize(10).fontColor('#64748B')
              TextInput({ text: this.aiBaseUrl, placeholder: 'http://127.0.0.1:8788' })
                .width('100%').height(38).fontSize(12).fontFamily('monospace').fontColor('#0F172A')
                .backgroundColor('#F8FAFC').border({ width: 1, color: '#E2E8F0' }).borderRadius(10)
                .onChange((val: string) => { this.aiBaseUrl = val; })
            }.width('100%').alignItems(HorizontalAlign.Start)

            Row({ space: 8 }) {
              Button('保存端点配置')
                .type(ButtonType.Normal).layoutWeight(1).height(36).fontSize(11).fontWeight(FontWeight.Bold)
                .fontColor('#FFFFFF').backgroundColor('#0F172A').borderRadius(10)
                .onClick(() => { this.saveEndpoints(); })
              Button('恢复默认回环')
                .type(ButtonType.Normal).layoutWeight(1).height(36).fontSize(11).fontWeight(FontWeight.Medium)
                .fontColor('#475569').backgroundColor('#F1F5F9').borderRadius(10)
                .onClick(() => { this.resetDefaultEndpoints(); })
            }.width('100%').margin({ top: 2 })
          }.width('100%').alignItems(HorizontalAlign.Start)
        }
      }.width('100%').padding(14).backgroundColor('#FFFFFF')
        .border({ width: 1, color: '#E5E9F0' }).borderRadius(16).alignItems(HorizontalAlign.Start)

      // Collapsible Geek Diagnostics & Contract Info
      Column({ space: 8 }) {
        Button() {
          Row() {
            Text('SYSTEM DIAGNOSTICS // 契约与当前端点诊断').fontSize(10).fontFamily('monospace')
              .fontWeight(FontWeight.Bold).fontColor('#0F172A')
            Blank()
            Text(this.advancedExpanded ? '收起' : '展开').fontSize(10).fontColor('#55745F')
          }.width('100%')
        }.type(ButtonType.Normal).width('100%').height(32).backgroundColor(Color.Transparent)
          .onClick(() => { this.advancedExpanded = !this.advancedExpanded; })

        if (this.advancedExpanded) {
          Column({ space: 6 }) {
            Text(`SYNC API     : ${this.syncBaseUrl}`).fontSize(10).fontFamily('monospace').fontColor('#475569')
            Text(`AI GATEWAY   : ${this.aiBaseUrl}`).fontSize(10).fontFamily('monospace').fontColor('#475569')
            Text('RDB STORE    : algoflow_workspace.db (schema v3)').fontSize(10).fontFamily('monospace').fontColor('#475569')
            Text('AI RULE VER  : 1.0.0 (strict source_refs & range check)').fontSize(10).fontFamily('monospace').fontColor('#475569')
            Text(`CLIENT ID    : ${this.clientId}`).fontSize(10).fontFamily('monospace').fontColor('#475569')
            Text(`SYNC CURSOR  : ${this.syncCursor}`).fontSize(10).fontFamily('monospace').fontColor('#475569')
            if (DEBUG) {
              Row() {
                Text('允许接收标记为 is_test_data 的测试响应').fontSize(11).fontColor('#0F172A').layoutWeight(1)
                Button(this.allowTestData ? '已开启' : '已关闭')
                  .type(ButtonType.Normal).height(26).padding({ left: 10, right: 10 })
                  .fontSize(10).fontFamily('monospace')
                  .fontColor(this.allowTestData ? '#55745F' : '#64748B')
                  .backgroundColor(this.allowTestData ? '#EEF6F3' : '#F1F5F9').borderRadius(6)
                  .onClick(() => {
                    this.allowTestData = !this.allowTestData;
                    this.saveEndpoints();
                  })
              }.width('100%').margin({ top: 4 })
            }
          }.width('100%').padding(12).backgroundColor('#F8FAFC').borderRadius(10).alignItems(HorizontalAlign.Start)
        }
      }.width('100%').padding(14).backgroundColor('#FFFFFF')
        .border({ width: 1, color: '#E5E9F0' }).borderRadius(16)
    }.width('100%')
  }

  @Builder
  BottomNavBar() {
    Row() {
      Column({ space: 4 }) {
        ResourceIcon({ name: ResourceIconName.FILES, iconSize: 21,
          tint: this.activeTab === HubTab.DRAFTS ? '#55745F' : '#94A3B8' })
        Text('工作区').fontSize(10).fontWeight(this.activeTab === HubTab.DRAFTS ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.activeTab === HubTab.DRAFTS ? '#55745F' : '#94A3B8')
      }.layoutWeight(1).height(58).justifyContent(FlexAlign.Center)
        .onClick(() => { openHome(); })

      Column({ space: 4 }) {
        ResourceIcon({ name: ResourceIconName.DOCUMENT, iconSize: 21, tint: '#94A3B8' })
        Text('写思路').fontSize(10).fontWeight(FontWeight.Medium).fontColor('#94A3B8')
      }.layoutWeight(1).height(58).justifyContent(FlexAlign.Center)
        .onClick(() => {
          const id = this.selectedDraftId.length > 0 ? this.selectedDraftId : this.viewModel.ensureStarterDraft();
          openEditor(id);
        })

      Column({ space: 4 }) {
        ResourceIcon({ name: ResourceIconName.AI, iconSize: 21,
          tint: this.activeTab === HubTab.AI ? '#55745F' : '#94A3B8' })
        Text('AI 转换').fontSize(10).fontWeight(this.activeTab === HubTab.AI ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.activeTab === HubTab.AI ? '#55745F' : '#94A3B8')
      }.layoutWeight(1).height(58).justifyContent(FlexAlign.Center)
        .onClick(() => {
          this.activeTab = HubTab.AI;
          this.title = 'AI 转换与审查';
        })

      Column({ space: 4 }) {
        ResourceIcon({ name: ResourceIconName.MENU, iconSize: 21,
          tint: this.activeTab === HubTab.SETTINGS ? '#55745F' : '#94A3B8' })
        Text('设置').fontSize(10).fontWeight(this.activeTab === HubTab.SETTINGS ? FontWeight.Bold : FontWeight.Medium)
          .fontColor(this.activeTab === HubTab.SETTINGS ? '#55745F' : '#94A3B8')
      }.layoutWeight(1).height(58).justifyContent(FlexAlign.Center)
        .onClick(() => {
          this.activeTab = HubTab.SETTINGS;
          this.title = '工作台设置';
        })
    }.width('100%').height(74).padding({ left: 16, right: 16, top: 7, bottom: 7 })
      .backgroundColor('#FFFFFF').border({ width: { top: 1 }, color: '#E5E9F0' })
  }

  build() {
    Column() {
      this.TopHeader()

      // Geek mode switch strip
      Scroll() {
        Row({ space: 8 }) {
          this.TabChip('全部草稿', 'DRAFTS', HubTab.DRAFTS)
          this.TabChip('AI 转换', 'AI_HUB', HubTab.AI)
          this.TabChip('版本快照', 'SNAPS', HubTab.VERSIONS)
          this.TabChip('同步队列', 'QUEUE', HubTab.SYNC)
          this.TabChip('设置', 'CONFIG', HubTab.SETTINGS)
        }.padding({ left: 20, right: 20 })
      }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).width('100%')
        .margin({ bottom: 8 })

      if (this.feedbackMessage.length > 0) {
        Row({ space: 8 }) {
          Text(this.feedbackMessage).fontSize(10).fontFamily('monospace').fontColor('#55745F').layoutWeight(1)
          Button('×').type(ButtonType.Normal).height(20).fontSize(11).fontColor('#64748B')
            .backgroundColor(Color.Transparent).onClick(() => { this.feedbackMessage = ''; })
        }.width('100%').padding({ left: 20, right: 20, top: 4, bottom: 4 })
      }

      Scroll() {
        Column({ space: 14 }) {
          if (this.activeTab === HubTab.DRAFTS) {
            this.AllDraftsView()
          } else if (this.activeTab === HubTab.AI) {
            this.AIHubView()
          } else if (this.activeTab === HubTab.VERSIONS) {
            this.VersionsView()
          } else if (this.activeTab === HubTab.SYNC) {
            this.SyncQueueView()
          } else {
            this.SettingsView()
          }
        }.width('100%').padding({ left: 20, right: 20, top: 6, bottom: 20 })
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off)

      this.BottomNavBar()
    }.width('100%').height('100%').backgroundColor('#F7F8FA')
  }
}
