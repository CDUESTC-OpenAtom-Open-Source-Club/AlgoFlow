import { Draft } from '../domain/Models';

/**
 * 草稿列表栏：展示/选择草稿 + 新建。
 * 只通过回调与页面交互，不直接访问仓储、网络或 AI。
 */
@Component
export struct DraftListBar {
  @Prop drafts: Draft[] = [];
  @Prop selectedId: string = '';
  onSelect: (id: string) => void = (_id: string): void => {};
  onCreate: () => void = (): void => {};

  build() {
    Column() {
      Row() {
        Column() {
          Text('工作区').fontSize(10).fontWeight(FontWeight.Bold).fontColor('#087F68')
          Text('我的草稿').fontSize(21).fontWeight(FontWeight.Bold).margin({ top: 2 })
        }.alignItems(HorizontalAlign.Start)
        Blank()
        Button('+')
          .width(36).height(36).fontSize(22).fontColor('#17201D')
          .backgroundColor('#FFFFFF').borderRadius(6)
          .onClick(() => this.onCreate())
      }.width('100%')

      Scroll() {
        Row({ space: 8 }) {
          ForEach(this.drafts, (draft: Draft) => {
            Button(draft.title)
              .height(38).fontSize(12)
              .fontColor(this.selectedId === draft.id ? '#FFFFFF' : '#4F5D58')
              .backgroundColor(this.selectedId === draft.id ? '#087F68' : '#EDF2EF')
              .borderRadius(5)
              .onClick(() => this.onSelect(draft.id))
          }, (draft: Draft) => draft.id)
        }
      }.scrollable(ScrollDirection.Horizontal).width('100%').margin({ top: 14 })
    }.width('100%')
  }
}
