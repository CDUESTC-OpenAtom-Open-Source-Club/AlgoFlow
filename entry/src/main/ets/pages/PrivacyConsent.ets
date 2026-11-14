import { common } from '@kit.AbilityKit';
import { SYNC_ENTRY } from 'BuildProfile';
import { enterAfterConsent, openPrivacyPolicy } from '../navigation/AppRoutes';
import { savePrivacyConsent } from '../platform/PrivacyConsentStore';

// The first page until the user agrees to the privacy policy (EntryAbility
// checks PrivacyConsentStore). Home has not loaded yet, so the draft database
// is not opened and nothing is sent before consent.
@Entry
@Component
struct PrivacyConsent {
  @State saving: boolean = false;
  @State message: string = '';

  private async agree(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.message = '';
    try {
      await savePrivacyConsent(getContext(this));
      await enterAfterConsent();
    } catch (error) {
      console.error(`[AlgoFlow] privacy consent failed: ${error instanceof Error ? error.message : 'unknown'}`);
      this.message = '没能保存你的选择，请重试';
    } finally {
      this.saving = false;
    }
  }

  // Nothing is saved, so the next launch asks again.
  private decline(): void {
    (getContext(this) as common.UIAbilityContext).terminateSelf();
  }

  @Builder
  Point(text: string) {
    Row({ space: 8 }) {
      Circle().width(6).height(6).fill('#55745F').margin({ top: 7 })
      Text(text).fontSize(13).fontColor('#3F4540').lineHeight(20).layoutWeight(1)
    }.width('100%').alignItems(VerticalAlign.Top)
  }

  build() {
    Column({ space: 18 }) {
      Column({ space: 10 }) {
        Image($r('app.media.af_logo')).width(56).height(56).objectFit(ImageFit.Contain)
        Text('欢迎使用算法随想').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#252A26')
        Text('开始使用前，请阅读并同意隐私政策。要点：').fontSize(12).fontColor('#5E645D')
      }.width('100%').alignItems(HorizontalAlign.Start)

      Column({ space: 12 }) {
        this.Point(SYNC_ENTRY ? '不开启同步时，草稿只保存在这台手机上。' : '草稿、思路和代码只保存在这台手机上。')
        if (SYNC_ENTRY) {
          this.Point('在「设置 → 连接电脑」扫码并确认后，草稿才会上传到你确认的服务器。')
        }
        this.Point(SYNC_ENTRY ? '只申请网络权限，不收集姓名、手机号、位置等信息。' : '不申请任何权限，不收集姓名、手机号、位置等信息。')
      }.width('100%').padding(16).backgroundColor('#FFFFFF')
        .border({ width: 1, color: '#E5E2D9' }).borderRadius(16)

      Text('阅读完整的《隐私政策》').fontSize(13).fontWeight(FontWeight.Medium).fontColor('#55745F')
        .decoration({ type: TextDecorationType.Underline, color: '#55745F' })
        .onClick(() => { openPrivacyPolicy(); })

      Blank()

      if (this.message.length > 0) {
        Text(this.message).fontSize(12).fontColor('#B5674D')
      }
      Column({ space: 10 }) {
        Button(this.saving ? '正在保存…' : '同意并继续')
          .type(ButtonType.Normal).width('100%').height(44).fontSize(14).fontWeight(FontWeight.Bold)
          .fontColor('#FFFFFF').backgroundColor('#55745F').borderRadius(12)
          .enabled(!this.saving)
          .onClick(() => { this.agree(); })
        Button('不同意并退出')
          .type(ButtonType.Normal).width('100%').height(40).fontSize(13).fontWeight(FontWeight.Medium)
          .fontColor('#5E645D').backgroundColor(Color.Transparent)
          .enabled(!this.saving)
          .onClick(() => { this.decline(); })
      }.width('100%')
    }.width('100%').height('100%').padding({ left: 24, right: 24, top: 48, bottom: 28 })
      .alignItems(HorizontalAlign.Start).backgroundColor('#F3F1EA')
  }
}
