import { DraftWorkspaceViewModel } from '../application/DraftWorkspaceViewModel';
import { AIMode, Draft, SyncStatus } from '../domain/Models';
import { InMemoryDraftRepository } from '../platform/InMemoryDraftRepository';

@Entry
@Component
struct Index {
  private viewModel: DraftWorkspaceViewModel = new DraftWorkspaceViewModel(new InMemoryDraftRepository());
  @State drafts: Draft[] = [];
  @State selectedId: string = '';
  @State title: string = '';
  @State idea: string = '';
  @State code: string = '';
  @State rewrite: string = '';
  @State mode: AIMode = AIMode.FAITHFUL_TRANSFORM;
  @State artifactHidden: boolean = false;
  @State syncStatus: SyncStatus = SyncStatus.LOCAL_ONLY;

  aboutToAppear(): void {
    this.selectedId = this.viewModel.ensureStarterDraft();
    this.refresh();
  }

  private refresh(): void {
    this.drafts = this.viewModel.listDrafts();
    const draft = this.viewModel.getDraft(this.selectedId);
    if (draft === undefined) return;
    this.title = draft.title;
    this.idea = draft.idea;
    this.code = draft.code;
    this.rewrite = draft.rewrite;
    this.mode = draft.aiMode;
    this.artifactHidden = draft.artifactHidden;
    this.syncStatus = draft.syncStatus;
  }

  private save(): void {
    this.viewModel.update(this.selectedId, this.title, this.idea, this.code, this.rewrite);
    this.refresh();
  }

  private chooseMode(mode: AIMode): void {
    this.viewModel.setMode(this.selectedId, mode);
    this.refresh();
  }

  @Builder
  ModeButton(label: string, value: AIMode) {
    Button(label)
      .height(34)
      .fontSize(12)
      .fontColor(this.mode === value ? '#FFFFFF' : '#4F5D58')
      .backgroundColor(this.mode === value ? '#087F68' : '#EDF2EF')
      .borderRadius(5)
      .margin({ right: 6, bottom: 6 })
      .onClick(() => this.chooseMode(value))
  }

  build() {
    Column() {
      Row() {
        Text('AF')
          .width(30).height(30).textAlign(TextAlign.Center).fontSize(11).fontWeight(FontWeight.Bold)
          .fontColor('#FFFFFF').backgroundColor('#17201D').borderRadius(6)
        Column() {
          Text('AlgoFlow').fontSize(15).fontWeight(FontWeight.Bold)
          Text('算法随想').fontSize(10).fontColor('#697570')
        }.alignItems(HorizontalAlign.Start).margin({ left: 9 })
        Blank()
        Text('仅本地').fontSize(11).fontColor('#087F68')
      }
      .width('100%').height(58).padding({ left: 16, right: 16 })
      .border({ width: { bottom: 1 }, color: '#D9E1DD' })

      Scroll() {
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
              .onClick(() => { this.selectedId = this.viewModel.createDraft(); this.refresh(); })
          }.width('100%')

          Scroll() {
            Row({ space: 8 }) {
              ForEach(this.drafts, (draft: Draft) => {
                Button(draft.title)
                  .height(38).fontSize(12)
                  .fontColor(this.selectedId === draft.id ? '#FFFFFF' : '#4F5D58')
                  .backgroundColor(this.selectedId === draft.id ? '#087F68' : '#EDF2EF')
                  .borderRadius(5)
                  .onClick(() => { this.selectedId = draft.id; this.refresh(); })
              }, (draft: Draft) => draft.id)
            }
          }.scrollable(ScrollDirection.Horizontal).width('100%').margin({ top: 14 })

          TextInput({ text: this.title, placeholder: '草稿标题' })
            .height(52).fontSize(24).fontWeight(FontWeight.Bold).backgroundColor('#FFFFFF')
            .padding({ left: 0, right: 0 }).margin({ top: 22 })
            .onChange((value: string) => { this.title = value; this.save(); })
          Row({ space: 6 }) {
            Circle().width(7).height(7).fill('#087F68')
            Text(this.syncStatus === SyncStatus.LOCAL_ONLY ? '仅本地 · 已保存到当前会话' : this.syncStatus)
              .fontSize(11).fontColor('#697570')
          }.width('100%').margin({ top: 5, bottom: 16 })
          Divider().color('#D9E1DD')

          Text('思路片段').width('100%').fontSize(12).fontWeight(FontWeight.Bold).fontColor('#4F5D58').margin({ top: 22, bottom: 8 })
          TextArea({ text: this.idea, placeholder: '每行记录一个可引用的思路步骤' })
            .width('100%').height(132).fontSize(14).backgroundColor('#F8FAF9')
            .border({ width: 1, color: '#D9E1DD' }).borderRadius(6)
            .onChange((value: string) => { this.idea = value; this.save(); })

          Text('C++ 短代码').width('100%').fontSize(12).fontWeight(FontWeight.Bold).fontColor('#4F5D58').margin({ top: 20, bottom: 8 })
          TextArea({ text: this.code, placeholder: '// 用短代码表达当前思路' })
            .width('100%').height(210).fontSize(13).fontColor('#E6EEEA').fontFamily('monospace')
            .backgroundColor('#202725').borderRadius(6)
            .onChange((value: string) => { this.code = value; this.save(); })

          Divider().color('#D9E1DD').margin({ top: 24, bottom: 20 })
          Text('AI 模式').width('100%').fontSize(10).fontWeight(FontWeight.Bold).fontColor('#087F68')
          Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
            this.ModeButton('忠实转换', AIMode.FAITHFUL_TRANSFORM)
            this.ModeButton('可行性', AIMode.FEASIBILITY_ANALYSIS)
            this.ModeButton('渐进提示', AIMode.PROGRESSIVE_HINT)
            this.ModeButton('完整解题', AIMode.FULL_SOLUTION)
          }.width('100%').margin({ top: 10 })

          Column() {
            Text('AI 未启用').width('100%').fontSize(14).fontWeight(FontWeight.Bold)
            Text('未配置模型服务。草稿编辑、复写和同步仍可使用。')
              .width('100%').fontSize(12).fontColor('#697570').margin({ top: 6 })
            Button(this.artifactHidden ? '显示 AI 区域' : '隐藏 AI 区域')
              .height(34).fontSize(12).fontColor('#17201D').backgroundColor('#FFFFFF')
              .border({ width: 1, color: '#D9E1DD' }).borderRadius(5).margin({ top: 12 })
              .onClick(() => { this.viewModel.toggleArtifact(this.selectedId); this.refresh(); })
          }.width('100%').alignItems(HorizontalAlign.Start).margin({ top: 20 })

          Text('我的独立复写').width('100%').fontSize(12).fontWeight(FontWeight.Bold).fontColor('#4F5D58').margin({ top: 22, bottom: 8 })
          TextArea({ text: this.rewrite, placeholder: '复写独立保存，不覆盖原思路' })
            .width('100%').height(150).fontSize(14).backgroundColor('#F8FAF9')
            .border({ width: 1, color: '#D9E1DD' }).borderRadius(6)
            .onChange((value: string) => { this.rewrite = value; this.save(); })

          Button('删除草稿')
            .height(36).fontSize(12).fontColor('#A33A3A').backgroundColor('#FFFFFF')
            .border({ width: 1, color: '#E1BCBC' }).borderRadius(5).margin({ top: 22, bottom: 36 })
            .onClick(() => { this.selectedId = this.viewModel.deleteDraft(this.selectedId); this.refresh(); })
        }
        .width('100%').padding({ left: 18, right: 18 }).alignItems(HorizontalAlign.Start)
      }
      .layoutWeight(1).scrollBar(BarState.Auto)
    }
    .width('100%').height('100%').backgroundColor('#FFFFFF')
  }
}
