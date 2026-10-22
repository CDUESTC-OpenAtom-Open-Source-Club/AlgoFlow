// Static card. Fields are pushed by EntryFormAbility / CardSnapshot through
// formBindingData and must match CardFormData in platform/CardSnapshot.ets.
const storage = new LocalStorage();

class CardLinkParams {
  card_action: string = '';
  draft_id: string = '';

  constructor(action: string, draftId: string) {
    this.card_action = action;
    this.draft_id = draftId;
  }
}

@Entry(storage)
@Component
struct WidgetCard {
  @LocalStorageProp('title') title: string = '暂无草稿';
  @LocalStorageProp('draftId') draftId: string = '';
  @LocalStorageProp('syncLabel') syncLabel: string = '点击新建思路开始记录';
  @LocalStorageProp('hasDraft') hasDraft: boolean = false;

  build() {
    Column() {
      FormLink({
        action: 'router',
        abilityName: 'EntryAbility',
        params: new CardLinkParams(this.hasDraft ? 'open_draft' : 'open_home', this.draftId)
      }) {
        Column({ space: 6 }) {
          Text('最近草稿').fontSize(11).fontColor('#657069')
          Text(this.title).fontSize(16).fontWeight(FontWeight.Bold).fontColor('#263129')
            .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.syncLabel).fontSize(11).fontColor(this.hasDraft ? '#4F6F5A' : '#657069')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        }.width('100%').alignItems(HorizontalAlign.Start)
      }.width('100%').layoutWeight(1)

      FormLink({
        action: 'router',
        abilityName: 'EntryAbility',
        params: new CardLinkParams('new_draft', '')
      }) {
        Row() {
          Text('+ 新建思路').fontSize(13).fontWeight(FontWeight.Medium).fontColor('#FFFFFF')
        }.width('100%').height(36).justifyContent(FlexAlign.Center)
          .backgroundColor('#25352C').borderRadius(18)
      }.width('100%')
    }.width('100%').height('100%').padding(14).backgroundColor('#F5F7F4')
  }
}
