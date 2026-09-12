import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { RdbDraftRepository } from '../platform/RdbDraftRepository';
import { SyncRunResult, SyncRunStatus } from '../platform/PhoneSyncService';
import { ResourceIcon, ResourceIconName } from '../components/ResourceIcon';
import { goBack } from '../navigation/AppRoutes';

@Entry
@Component
struct Settings {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new RdbDraftRepository(getContext(this)));

  @State baseUrl: string = '';
  @State ready: boolean = false;
  @State syncing: boolean = false;
  @State syncMessage: string = '';
  @State syncFailed: boolean = false;

  aboutToAppear(): void {
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const repository = new RdbDraftRepository(getContext(this));
      this.viewModel = new DraftWorkspaceViewModel(repository, repository);
      await this.viewModel.initialize();
      this.baseUrl = this.viewModel.getSyncBaseUrl();
      this.ready = true;
    } catch (error) {
      console.error(`[AlgoFlow] Settings initialization failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private saveBaseUrl(): void {
    this.viewModel.setSyncBaseUrl(this.baseUrl.trim());
    this.syncMessage = '同步服务地址已保存';
    this.syncFailed = false;
  }

  private async syncNow(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.syncMessage = '同步中…';
    this.syncFailed = false;
    try {
      const result = await this.viewModel.synchronize();
      if (result === undefined) {
        this.syncMessage = '同步服务未连接';
        this.syncFailed = true;
        return;
      }
      this.applyResult(result);
    } catch (error) {
      this.syncMessage = '同步请求失败，请检查网络后重试';
      this.syncFailed = true;
    } finally {
      this.syncing = false;
    }
  }

  private applyResult(result: SyncRunResult): void {
    if (result.status === SyncRunStatus.SYNCED) {
      this.syncMessage = '同步完成';
      this.syncFailed = false;
    } else if (result.status === SyncRunStatus.LOCAL_ONLY) {
      this.syncMessage = '仍有本地改动未同步';
      this.syncFailed = false;
    } else if (result.status === SyncRunStatus.CONFLICT) {
      this.syncMessage = '发现冲突，已保留服务器版本与本地副本';
      this.syncFailed = true;
    } else {
      this.syncMessage = result.message.length > 0 ? result.message : '同步失败';
      this.syncFailed = true;
    }
  }

  private statusColor(): string {
    if (!this.ready) return '#8A938D';
    if (this.syncFailed) return '#B5674D';
    return '#55745F';
  }

  @Builder
  SectionTitle(label: string) {
    Text(label).fontSize(13).fontWeight(FontWeight.Bold).fontColor('#253029').width('100%')
  }

  @Builder
  SettingRow(label: string, value: string) {
    Row() {
      Text(label).fontSize(13).fontColor('#253029').layoutWeight(1)
      Text(value).fontSize(12).fontColor('#8A938D').maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
    }.width('100%').padding(14).backgroundColor('#FFFFFF')
      .border({ width: 1, color: '#E2E8E3' }).borderRadius(14)
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .height(34).fontSize(12).fontColor('#55745F').backgroundColor(Color.Transparent)
          .onClick(() => { goBack(); })
        Blank()
        Text('设置').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#253029')
        Blank()
        Row().width(44)
      }.width('100%').padding({ left: 14, right: 14, top: 16, bottom: 8 })

      Scroll() {
        Column({ space: 16 }) {
          Column({ space: 10 }) {
            this.SectionTitle('同步服务')
            TextInput({ placeholder: 'http://127.0.0.1:8787', text: this.baseUrl })
              .height(44).fontSize(13).fontColor('#253029')
              .onChange((value: string) => { this.baseUrl = value; })
            Button('保存地址')
              .width('100%').height(38).fontSize(13).fontColor('#FFFFFF').backgroundColor('#55745F')
              .onClick(() => { this.saveBaseUrl(); })
          }.width('100%').alignItems(HorizontalAlign.Start)

          Column({ space: 10 }) {
            this.SectionTitle('状态')
            Row({ space: 8 }) {
              Circle().width(8).height(8).fill(this.statusColor())
              Text(this.syncMessage.length > 0 ? this.syncMessage : '尚未同步').fontSize(12).fontColor('#68736C')
            }.width('100%')
            Button('立即同步')
              .width('100%').height(38).fontSize(13).fontColor('#FFFFFF')
              .backgroundColor(this.syncing ? '#9AA39D' : '#25352C')
              .onClick(() => { this.syncNow(); })
            if (this.syncFailed) {
              Button('重试')
                .width('100%').height(38).fontSize(13).fontColor('#B5674D')
                .backgroundColor('#F6ECE7')
                .onClick(() => { this.syncNow(); })
            }
          }.width('100%').alignItems(HorizontalAlign.Start)

          Column({ space: 10 }) {
            this.SectionTitle('关于')
            this.SettingRow('应用', 'AlgoFlow 算法随想')
            this.SettingRow('数据说明', '草稿本地优先，归档与删除均参与同步')
          }.width('100%').alignItems(HorizontalAlign.Start)
        }.width('100%').padding({ left: 20, right: 20, top: 8, bottom: 18 })
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off)
    }.width('100%').height('100%').backgroundColor('#F7F8F6')
  }
}
