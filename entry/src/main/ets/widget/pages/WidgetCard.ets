@Entry
@Component
struct WidgetCard {
  @State title: string = 'AlgoFlow';
  @State draftId: string = 'latest';
  @State syncStatus: string = '待预研';
  @State stage: string = '开发中';

  build() {
    FormLink({
      action: 'router',
      abilityName: 'EntryAbility',
      params: { draft_id: this.draftId }
    }) {
      Column({ space: 8 }) {
        Text(this.title).fontSize(18).fontWeight(FontWeight.Bold).fontColor('#263129')
        Text('最近草稿').fontSize(11).fontColor('#657069')
        Text(`同步状态：${this.syncStatus}`).fontSize(12).fontColor('#4F6F5A')
        Text(`阶段：${this.stage}`).fontSize(10).fontColor('#657069')
        Text('点击返回工作台').fontSize(10).fontColor('#657069')
      }.width('100%').height('100%').padding(16).backgroundColor('#F5F7F4')
    }
  }
}
