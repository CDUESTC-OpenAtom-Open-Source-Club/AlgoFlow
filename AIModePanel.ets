import { AIMode } from '../domain/Models';

/**
 * AI 模式面板：四种模式显式切换，当前模式高亮。
 * 完整解题只能由用户主动选择，不通过模型自动升级。
 */
@Component
export struct AIModePanel {
  @Prop mode: AIMode = AIMode.FAITHFUL_TRANSFORM;
  onSelect: (mode: AIMode) => void = (_mode: AIMode): void => {};

  @Builder
  ModeButton(label: string, value: AIMode) {
    Button(label)
      .height(34)
      .fontSize(12)
      .fontColor(this.mode === value ? '#FFFFFF' : '#4F5D58')
      .backgroundColor(this.mode === value ? '#087F68' : '#EDF2EF')
      .borderRadius(5)
      .margin({ right: 6, bottom: 6 })
      .onClick(() => this.onSelect(value))
  }

  build() {
    Column() {
      Text('AI 模式').width('100%').fontSize(10).fontWeight(FontWeight.Bold).fontColor('#087F68')
      Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
        this.ModeButton('忠实转换', AIMode.FAITHFUL_TRANSFORM)
        this.ModeButton('可行性', AIMode.FEASIBILITY_ANALYSIS)
        this.ModeButton('渐进提示', AIMode.PROGRESSIVE_HINT)
        this.ModeButton('完整解题', AIMode.FULL_SOLUTION)
      }.width('100%').margin({ top: 10 })
    }.width('100%').alignItems(HorizontalAlign.Start)
  }
}
