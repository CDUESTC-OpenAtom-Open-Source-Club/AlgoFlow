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

  // Chip colours are derived from the status label CardSnapshot already
  // publishes; the card never receives idea text or code.
  private chipBackground(): string {
    if (this.syncLabel === '已同步') return '#E5F1EB';
    if (this.syncLabel === '同步中') return '#E9EEF4';
    if (this.syncLabel === '有冲突') return '#FAF3DC';
    if (this.syncLabel === '同步失败') return '#F6E3DC';
    return '#E5E2D9';
  }

  private chipText(): string {
    if (this.syncLabel === '已同步') return '#20372A';
    if (this.syncLabel === '同步中') return '#3E5672';
    if (this.syncLabel === '有冲突') return '#7A5A17';
    if (this.syncLabel === '同步失败') return '#8A4532';
    return '#5E645D';
  }

  private chipDot(): string {
    if (this.syncLabel === '已同步') return '#55745F';
    if (this.syncLabel === '同步中') return '#6E8AAE';
    if (this.syncLabel === '有冲突') return '#B98A2E';
    if (this.syncLabel === '同步失败') return '#B5674D';
    return '#777C73';
  }

  build() {
    Column() {
      FormLink({
        action: 'router',
        abilityName: 'EntryAbility',
        params: new CardLinkParams(this.hasDraft ? 'open_draft' : 'open_home', this.draftId)
      }) {
        Column({ space: 8 }) {
          Row() {
            Text('AlgoFlow').fontSize(11).fontWeight(FontWeight.Medium).fontColor('#5E645D')
            Blank()
            if (this.hasDraft) {
              Row({ space: 4 }) {
                Circle().width(6).height(6).fill(this.chipDot())
                Text(this.syncLabel).fontSize(10).fontColor(this.chipText()).maxLines(1)
              }.height(20).padding({ left: 7, right: 7 }).backgroundColor(this.chipBackground()).borderRadius(10)
            }
          }.width('100%')
          Text(this.hasDraft ? this.title : '还没有草稿').fontSize(16).fontWeight(FontWeight.Bold)
            .fontColor(this.hasDraft ? '#252A26' : '#5E645D')
            .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
          if (!this.hasDraft) {
            Text(this.syncLabel).fontSize(11).fontColor('#5E645D')
              .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          }
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
    }.width('100%').height('100%').padding(14).backgroundColor('#FBF9F4')
  }
}
