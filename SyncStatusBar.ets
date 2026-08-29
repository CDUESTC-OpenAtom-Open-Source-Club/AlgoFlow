import { SyncStatus } from '../domain/Models';

/**
 * 同步状态栏：显示保存/同步状态并触发同步。
 * 状态仅使用契约中的五个值；普通云同步不包装成分布式能力。
 */
@Component
export struct SyncStatusBar {
  @Prop syncStatus: SyncStatus = SyncStatus.LOCAL_ONLY;
  @Prop running: boolean = false;
  onSync: () => void = (): void => {};
  onCancel: () => void = (): void => {};

  private statusText(): string {
    if (this.syncStatus === SyncStatus.LOCAL_ONLY) {
      return '仅本地 · 更改保存在本地';
    }
    if (this.syncStatus === SyncStatus.SYNCING) {
      return '同步中';
    }
    if (this.syncStatus === SyncStatus.SYNCED) {
      return '已同步';
    }
    if (this.syncStatus === SyncStatus.CONFLICT) {
      return '有冲突 · 请处理冲突副本';
    }
    return '同步失败 · 请重试';
  }

  private statusColor(): string {
    if (this.syncStatus === SyncStatus.CONFLICT || this.syncStatus === SyncStatus.FAILED) {
      return '#A33A3A';
    }
    return '#087F68';
  }

  build() {
    Row({ space: 6 }) {
      Circle().width(7).height(7).fill(this.statusColor())
      Text(this.statusText()).fontSize(11).fontColor('#697570')
      Blank()
      Button(this.running ? '取消' : '同步')
        .height(28).fontSize(11).fontColor('#17201D').backgroundColor('#FFFFFF')
        .border({ width: 1, color: '#D9E1DD' }).borderRadius(5)
        .onClick(() => {
          if (this.running) {
            this.onCancel();
          } else {
            this.onSync();
          }
        })
    }.width('100%')
  }
}
