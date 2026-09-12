import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { Notification, NotificationKind } from '../domain/Models';
import { RdbDraftRepository } from '../platform/RdbDraftRepository';
import { ResourceIcon, ResourceIconName } from '../components/ResourceIcon';
import { goBack } from '../navigation/AppRoutes';

@Entry
@Component
struct Notifications {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new RdbDraftRepository(getContext(this)));

  @State notifications: Notification[] = [];
  @State ready: boolean = false;
  @State failed: boolean = false;

  aboutToAppear(): void {
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const repository = new RdbDraftRepository(getContext(this));
      this.viewModel = new DraftWorkspaceViewModel(repository, repository);
      await this.viewModel.initialize();
      this.notifications = this.viewModel.listNotifications();
      this.ready = true;
    } catch (error) {
      this.failed = true;
      console.error(`[AlgoFlow] Notifications initialization failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private kindIcon(kind: NotificationKind): ResourceIconName {
    if (kind === NotificationKind.CONFLICT) return ResourceIconName.QUERY;
    if (kind === NotificationKind.SYNC_FAILED) return ResourceIconName.CROSS;
    return ResourceIconName.REFRESH;
  }

  private kindColor(kind: NotificationKind): string {
    if (kind === NotificationKind.CONFLICT) return '#B5674D';
    if (kind === NotificationKind.SYNC_FAILED) return '#B5674D';
    return '#55745F';
  }

  private timeLabel(createdAt: string): string {
    if (createdAt.length < 16) return '刚刚';
    return createdAt.substring(0, 16).replace('T', ' ');
  }

  private markAll(): void {
    this.viewModel.markAllNotificationsRead();
    this.notifications = this.viewModel.listNotifications();
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .height(34).fontSize(12).fontColor('#55745F').backgroundColor(Color.Transparent)
          .onClick(() => { goBack(); })
        Blank()
        Text('通知').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#253029')
        Blank()
        Button('全部已读')
          .height(30).fontSize(11).fontColor('#55745F').backgroundColor(Color.Transparent)
          .onClick(() => { this.markAll(); })
      }.width('100%').padding({ left: 14, right: 14, top: 16, bottom: 8 })

      Scroll() {
        Column({ space: 12 }) {
          if (this.failed) {
            Text('通知加载失败，请返回重试').fontSize(12).fontColor('#B5674D').margin({ top: 40 })
          } else if (!this.ready) {
            Text('正在加载通知…').fontSize(12).fontColor('#8A938D').margin({ top: 40 })
          } else if (this.notifications.length === 0) {
            Column({ space: 6 }) {
              ResourceIcon({ name: ResourceIconName.QUERY, iconSize: 24, tint: '#9AA39D' })
              Text('没有新通知').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#253029')
              Text('同步失败或冲突时，会在这里提示可恢复的操作。').fontSize(11).fontColor('#68736C')
            }.width('100%').padding(20).alignItems(HorizontalAlign.Center).margin({ top: 24 })
          } else {
            ForEach(this.notifications, (notification: Notification) => {
              Row({ space: 12 }) {
                Row() {
                  ResourceIcon({ name: this.kindIcon(notification.kind), iconSize: 18, tint: this.kindColor(notification.kind) })
                }.width(38).height(38).justifyContent(FlexAlign.Center)
                  .backgroundColor(notification.read ? '#EDF1ED' : '#E5F1EB').borderRadius(10)
                Column({ space: 4 }) {
                  Text(notification.title).fontSize(13).fontWeight(notification.read ? FontWeight.Medium : FontWeight.Bold)
                    .fontColor('#253029')
                  Text(notification.message).fontSize(11).fontColor('#68736C')
                    .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(this.timeLabel(notification.createdAt)).fontSize(10).fontColor('#8A938D')
                }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                if (!notification.read) {
                  Circle().width(7).height(7).fill('#55745F')
                }
              }.width('100%').padding(14).backgroundColor('#FFFFFF')
                .border({ width: 1, color: '#E2E8E3' }).borderRadius(16)
                .onClick(() => {
                  this.viewModel.markNotificationRead(notification.id);
                  this.notifications = this.viewModel.listNotifications();
                })
            }, (notification: Notification) => notification.id)
          }
        }.width('100%').padding({ left: 20, right: 20, top: 8, bottom: 18 })
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off)
    }.width('100%').height('100%').backgroundColor('#F7F8F6')
  }
}
