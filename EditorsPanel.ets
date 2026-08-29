/**
 * 编辑器面板：标题、思路片段、C++ 短代码、独立复写。
 * 长文本编辑区固定尺寸 + 内部滚动，配合外层 Scroll 适配输入法弹出，避免布局跳动。
 */
@Component
export struct EditorsPanel {
  @Prop title: string = '';
  @Prop idea: string = '';
  @Prop code: string = '';
  @Prop rewrite: string = '';
  onTitleChange: (v: string) => void = (_v: string): void => {};
  onIdeaChange: (v: string) => void = (_v: string): void => {};
  onCodeChange: (v: string) => void = (_v: string): void => {};
  onRewriteChange: (v: string) => void = (_v: string): void => {};

  build() {
    Column() {
      TextInput({ text: this.title, placeholder: '草稿标题' })
        .height(52).fontSize(24).fontWeight(FontWeight.Bold).backgroundColor('#FFFFFF')
        .padding({ left: 0, right: 0 }).margin({ top: 22 })
        .onChange((value: string) => this.onTitleChange(value))

      Text('思路片段').width('100%').fontSize(12).fontWeight(FontWeight.Bold)
        .fontColor('#4F5D58').margin({ top: 22, bottom: 8 })
      TextArea({ text: this.idea, placeholder: '每行记录一个可引用的思路步骤' })
        .width('100%').height(132).fontSize(14).backgroundColor('#F8FAF9')
        .border({ width: 1, color: '#D9E1DD' }).borderRadius(6)
        .onChange((value: string) => this.onIdeaChange(value))

      Text('C++ 短代码').width('100%').fontSize(12).fontWeight(FontWeight.Bold)
        .fontColor('#4F5D58').margin({ top: 20, bottom: 8 })
      TextArea({ text: this.code, placeholder: '// 用短代码表达当前思路' })
        .width('100%').height(210).fontSize(13).fontColor('#E6EEEA').fontFamily('monospace')
        .backgroundColor('#202725').borderRadius(6)
        .onChange((value: string) => this.onCodeChange(value))

      Text('我的独立复写').width('100%').fontSize(12).fontWeight(FontWeight.Bold)
        .fontColor('#4F5D58').margin({ top: 22, bottom: 8 })
      TextArea({ text: this.rewrite, placeholder: '复写独立保存，不覆盖原思路' })
        .width('100%').height(150).fontSize(14).backgroundColor('#F8FAF9')
        .border({ width: 1, color: '#D9E1DD' }).borderRadius(6)
        .onChange((value: string) => this.onRewriteChange(value))
    }.width('100%')
  }
}
