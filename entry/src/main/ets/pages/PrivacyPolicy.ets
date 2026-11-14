import { webview } from '@kit.ArkWeb';
import { DEBUG } from 'BuildProfile';
import { goBack } from '../navigation/AppRoutes';

const BUNDLED_PAGE_PREFIX = 'resource://rawfile/';

// The privacy policy bundled with the app. entry/hvigorfile.ts generates
// rawfile/privacy.html at build time from deploy/privacy.template.html, the
// template the server's copy is made from. It is a static page: scripts are
// off and every navigation away from the bundled file is blocked.
@Entry
@Component
struct PrivacyPolicy {
  private controller: webview.WebviewController = new webview.WebviewController();

  build() {
    Column() {
      Row({ space: 10 }) {
        Button() {
          Row({ space: 4 }) {
            Text('←').fontSize(13).fontWeight(FontWeight.Bold).fontColor('#252A26')
            Text('返回').fontSize(11).fontWeight(FontWeight.Bold).fontColor('#252A26')
          }
        }.type(ButtonType.Normal).height(34).padding({ left: 12, right: 12 })
          .backgroundColor('#FFFFFF').border({ width: 1, color: '#E5E2D9' }).borderRadius(10)
          .onClick(() => { goBack(); })
        Text('隐私政策').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#252A26')
      }.width('100%').padding({ left: 20, right: 20, top: 16, bottom: 10 })

      Web({ src: $rawfile('privacy.html'), controller: this.controller })
        .javaScriptAccess(false)
        .onLoadIntercept((event: OnLoadInterceptEvent) => {
          const url = event.data.getRequestUrl();
          if (url.startsWith(BUNDLED_PAGE_PREFIX)) return false;
          if (DEBUG) console.warn(`[AlgoFlow] privacy page blocked navigation to ${url}`);
          return true;
        })
        .layoutWeight(1).width('100%')
    }.width('100%').height('100%').backgroundColor('#F3F1EA')
  }
}
