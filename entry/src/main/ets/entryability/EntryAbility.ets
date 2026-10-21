import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { util } from '@kit.ArkTS';
import { CARD_REQUEST_KEY, encodeCardRequest, parseCardLaunch } from '../navigation/AppRoutes';

const DOMAIN = 0x0000;
const TAG = 'AlgoFlow';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.storeCardRequest(want);
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, TAG, '[AlgoFlow] Failed to set color mode. Cause: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // Main window is created, set main page for this ability
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onWindowStageCreate');

    windowStage.loadContent('pages/Home', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, '[AlgoFlow] Failed to load content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, '[AlgoFlow] Content loaded.');
    });
  }

  onNewWant(want: Want): void {
    this.storeCardRequest(want);
  }

  // Home watches CARD_REQUEST_KEY, so card taps work on cold start and while
  // the app is already running.
  private storeCardRequest(want: Want): void {
    const request = parseCardLaunch(want.parameters as Record<string, Object> | undefined, util.generateRandomUUID());
    const encoded = encodeCardRequest(request);
    if (encoded.length > 0) {
      hilog.info(DOMAIN, TAG, '[AlgoFlow] Card launch action=%{public}s', request.action);
      AppStorage.setOrCreate<string>(CARD_REQUEST_KEY, encoded);
    }
  }

  onWindowStageDestroy(): void {
    // Main window is destroyed, release UI related resources
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onWindowStageDestroy');
  }

  onForeground(): void {
    // Ability has brought to foreground
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onForeground');
  }

  onBackground(): void {
    // Ability has back to background
    hilog.info(DOMAIN, TAG, '[AlgoFlow] Ability onBackground');
  }
}
