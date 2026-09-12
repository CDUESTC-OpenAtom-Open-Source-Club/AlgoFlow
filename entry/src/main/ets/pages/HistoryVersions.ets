import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { Draft, DraftVersion } from '../domain/Models';
import { RdbDraftRepository } from '../platform/RdbDraftRepository';
import { ResourceIcon, ResourceIconName } from '../components/ResourceIcon';
import { goBack } from '../navigation/AppRoutes';

@Entry
@Component
struct HistoryVersions {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new RdbDraftRepository(getContext(this)));

  @State versions: DraftVersion[] = [];
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
      this.versions = this.viewModel.allVersions();
      this.ready = true;
    } catch (error) {
      this.failed = true;
      console.error(`[AlgoFlow] HistoryVersions initialization failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  private draftTitle(version: DraftVersion): string {
    const draft = this.viewModel.getDraft(version.draftId);
    if (draft === undefined) return '已删除草稿';
    return draft.title;
  }

  private timeLabel(createdAt: string): string {
    if (createdAt.length < 16) return '刚刚';
    return createdAt.substring(0, 16).replace('T', ' ');
  }

  build() {
    Column() {
      Row() {
        Button('返回')
          .height(34).fontSize(12).fontColor('#55745F').backgroundColor(Color.Transparent)
          .onClick(() => { goBack(); })
        Blank()
        Text('历史版本').fontSize(16).fontWeight(FontWeight.Bold).fontColor('#253029')
        Blank()
        Row().width(44)
      }.width('100%').padding({ left: 14, right: 14, top: 16, bottom: 8 })

      Scroll() {
        Column({ space: 12 }) {
          if (this.failed) {
            Text('历史版本加载失败，请返回重试').fontSize(12).fontColor('#B5674D').margin({ top: 40 })
          } else if (!this.ready) {
            Text('正在加载版本记录…').fontSize(12).fontColor('#8A938D').margin({ top: 40 })
          } else if (this.versions.length === 0) {
            Column({ space: 6 }) {
              ResourceIcon({ name: ResourceIconName.VERSIONS, iconSize: 24, tint: '#9AA39D' })
              Text('还没有历史版本').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#253029')
              Text('保存草稿内容后，这里会记录真实的版本快照。').fontSize(11).fontColor('#68736C')
            }.width('100%').padding(20).alignItems(HorizontalAlign.Center).margin({ top: 24 })
          } else {
            ForEach(this.versions, (version: DraftVersion) => {
              Column({ space: 6 }) {
                Row({ space: 8 }) {
                  Text(this.draftTitle(version)).fontSize(14).fontWeight(FontWeight.Bold).fontColor('#253029')
                    .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
                  if (version.archived) {
                    Text('已归档').fontSize(9).fontColor('#61758A').padding({ left: 6, right: 6, top: 2, bottom: 2 })
                      .backgroundColor('#E9EEF4').borderRadius(6)
                  }
                }.width('100%')
                Row() {
                  Text(`版本 v${version.version}`).fontSize(11).fontWeight(FontWeight.Bold).fontColor('#55745F')
                  Text(` · ${this.timeLabel(version.createdAt)}`).fontSize(11).fontColor('#8A938D')
                }.width('100%')
              }.width('100%').padding(14).backgroundColor('#FFFFFF')
                .border({ width: 1, color: '#E2E8E3' }).borderRadius(16)
                .alignItems(HorizontalAlign.Start)
            }, (version: DraftVersion) => version.id)
          }
        }.width('100%').padding({ left: 20, right: 20, top: 8, bottom: 18 })
      }.layoutWeight(1).width('100%').scrollBar(BarState.Off)
    }.width('100%').height('100%').backgroundColor('#F7F8F6')
  }
}
