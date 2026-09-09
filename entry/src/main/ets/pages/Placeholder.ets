import { ResourceIcon, ResourceIconName } from '../components/ResourceIcon';
import { goBack } from '../navigation/AppRoutes';

@Entry
@Component
struct Placeholder {
  @State title: string = '功能预留';
  @State detail: string = '该页面尚未完成。';

  aboutToAppear(): void {
    const storedTitle = AppStorage.get<string>('placeholderTitle');
    const storedDetail = AppStorage.get<string>('placeholderDetail');
    if (storedTitle !== undefined && storedTitle.length > 0) this.title = storedTitle;
    if (storedDetail !== undefined && storedDetail.length > 0) this.detail = storedDetail;
  }

  build() {
    Column({ space: 20 }) {
      Row() {
        Button('返回')
          .height(34).fontSize(11).fontColor('#55745F').backgroundColor(Color.Transparent)
          .onClick(() => { goBack(); })
        Blank()
        Text(this.title).fontSize(16).fontWeight(FontWeight.Bold).fontColor('#253029')
        Blank()
        Row().width(48)
      }.width('100%').padding({ left: 18, right: 18, top: 18 })

      Column({ space: 12 }) {
        Row() {
          ResourceIcon({ name: ResourceIconName.MENU, iconSize: 22 })
        }.width(52).height(52).justifyContent(FlexAlign.Center).backgroundColor('#55745F').borderRadius(14)
        Text('功能预留').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#253029')
        Text(this.detail).fontSize(12).fontColor('#68736C').textAlign(TextAlign.Center)
          .width('82%').lineHeight(20)
      }.layoutWeight(1).width('100%').justifyContent(FlexAlign.Center)

      Text('当前版本保留入口，不生成模拟数据。').fontSize(10).fontColor('#8A938D').margin({ bottom: 28 })
    }.width('100%').height('100%').backgroundColor('#F7F8F6')
  }
}
