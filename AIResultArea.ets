/**
 * AI 结果区域：显示当前模式、未启用/结果/越界错误，支持隐藏复写与冲突解决。
 * 越界错误（越界：…）来自领域校验，UI 只负责展示，不直接拼装 AI 数据。
 */
@Component
export struct AIResultArea {
  @Prop modeLabel: string = '';
  @Prop hidden: boolean = false;
  @Prop loading: boolean = false;
  @Prop message: string = '';
  @Prop error: string = '';
  @Prop hasConflict: boolean = false;
  onToggleArtifact: () => void = (): void => {};
  onGenerate: () => void = (): void => {};
  onCancel: () => void = (): void => {};
  onResolveServer: () => void = (): void => {};
  onResolveLocal: () => void = (): void => {};

  build() {
    Column() {
      Row() {
        Text(`AI 结果 · ${this.modeLabel}`).fontSize(14).fontWeight(FontWeight.Bold)
        Blank()
        Button(this.loading ? '取消' : '生成')
          .height(30).fontSize(12).fontColor('#17201D').backgroundColor('#FFFFFF')
          .border({ width: 1, color: '#D9E1DD' }).borderRadius(5)
          .onClick(() => {
            if (this.loading) {
              this.onCancel();
            } else {
              this.onGenerate();
            }
          })
      }.width('100%')

      if (this.loading) {
        Row({ space: 8 }) {
          LoadingProgress().width(20).height(20).color('#087F68')
          Text('正在请求 AI…').fontSize(12).fontColor('#697570')
        }.width('100%').margin({ top: 12 })
      } else if (this.error.length > 0) {
        Text(this.error).width('100%').fontSize(12).fontColor('#A33A3A')
          .backgroundColor('#FBECEC').borderRadius(5).padding(10).margin({ top: 12 })
      } else if (this.message.length > 0) {
        Text(this.message).width('100%').fontSize(12).fontColor('#697570')
          .backgroundColor('#F4F7F6').borderRadius(5).padding(10).margin({ top: 12 })
      } else {
        Column() {
          Text('AI 未启用').width('100%').fontSize(14).fontWeight(FontWeight.Bold)
          Text('未配置模型服务。草稿编辑、复写和同步仍可使用。')
            .width('100%').fontSize(12).fontColor('#697570').margin({ top: 6 })
        }.width('100%').alignItems(HorizontalAlign.Start).margin({ top: 12 })
      }

      Button(this.hidden ? '显示 AI 区域' : '隐藏 AI 区域')
        .height(34).fontSize(12).fontColor('#17201D').backgroundColor('#FFFFFF')
        .border({ width: 1, color: '#D9E1DD' }).borderRadius(5).margin({ top: 12 })
        .onClick(() => this.onToggleArtifact())

      if (this.hasConflict) {
        Column() {
          Text('检测到同步冲突，请选择保留版本')
            .width('100%').fontSize(12).fontWeight(FontWeight.Bold).fontColor('#A33A3A')
          Row({ space: 8 }) {
            Button('采用服务器版本')
              .height(34).fontSize(12).fontColor('#087F68').backgroundColor('#FFFFFF')
              .border({ width: 1, color: '#087F68' }).borderRadius(5)
              .onClick(() => this.onResolveServer())
            Button('保留本地版本')
              .height(34).fontSize(12).fontColor('#A33A3A').backgroundColor('#FFFFFF')
              .border({ width: 1, color: '#E1BCBC' }).borderRadius(5)
              .onClick(() => this.onResolveLocal())
          }.width('100%').margin({ top: 8 })
        }.width('100%').alignItems(HorizontalAlign.Start).margin({ top: 16 })
      }
    }.width('100%').alignItems(HorizontalAlign.Start)
  }
}
